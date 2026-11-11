import type { PayloadRequest } from 'payload'
import { APIError } from 'payload'

import type { MediaFile, PublisherEnv } from '../../../../worker/blog/payload-publisher'
import {
  PublishError,
  publishHome,
  publishPage,
  publishProject,
  publishProjectsHome,
  unpublishProject,
  type ProjectInput,
  publishSiteSettings,
  publishedSlugs,
  resolveNavigation,
  unpublishPage,
  type NavigationInput,
  type PageInput,
  type SiteSettingsInput,
} from '../../../../worker/site/publisher'
import { cloudflareEnv } from '../cloudflare-env'

// The website's content (docs/PAYLOAD-FRONTEND-PLAN.md): Payload keeps it; these helpers publish what's
// published in Payload to the public site's snapshots (worker/site/publisher.ts). Drafts change nothing public.

export const publisherEnv = async (): Promise<PublisherEnv & { R2: R2Bucket }> => {
  const e = await cloudflareEnv<PublisherEnv & { R2: R2Bucket }>()
  return { DB: e.DB, MEDIA: e.MEDIA, SITE_URL: e.SITE_URL, R2: e.R2 }
}

const idOf = (value: unknown): string | number | null =>
  value && typeof value === 'object' ? ((value as { id?: string | number }).id ?? null) : ((value as string | number | null | undefined) ?? null)

/** Reads an image from Payload's own (private) media store, for copying into the public bucket. */
export const mediaLoader = (req: PayloadRequest, env: { R2: R2Bucket }) => ({
  loadMedia: async (id: string | number): Promise<MediaFile | null> => {
    const media = (await req.payload.findByID({ collection: 'media', id, depth: 0, overrideAccess: true, req }).catch(() => null)) as {
      filename?: string
      mimeType?: string
      alt?: string
      caption?: string | null
    } | null
    if (!media?.filename) return null
    const object = await env.R2.get(media.filename)
    if (!object) return null
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      contentType: media.mimeType ?? object.httpMetadata?.contentType ?? '',
      alt: media.alt ?? '',
      caption: media.caption ?? null,
    }
  },
})

/** A publish refusal becomes a message the editor sees, not a 500. */
export async function asEditorError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof PublishError) throw new APIError(error.message, 400, undefined, true)
    throw error
  }
}

type NavDoc = { items?: Array<{ label?: string | null; type?: 'page' | 'url' | null; page?: unknown; url?: string | null }> | null }

/** The Navigation global as the publisher takes it: page links become the page's current slug. */
export async function navigationInput(req: PayloadRequest, doc?: NavDoc): Promise<NavigationInput> {
  const nav = doc ?? ((await req.payload.findGlobal({ slug: 'navigation', depth: 0, overrideAccess: true, req })) as NavDoc)
  const items: NavigationInput['items'] = []
  for (const item of nav.items ?? []) {
    if (item.type === 'page') {
      const id = idOf(item.page)
      const page = id
        ? ((await req.payload.findByID({ collection: 'pages', id, depth: 0, draft: false, overrideAccess: true, req }).catch(() => null)) as {
            slug?: string
            _status?: string
            deletedAt?: string | null
          } | null)
        : null
      items.push({ label: item.label, pageSlug: page?.slug ?? '__missing__' })
    } else items.push({ label: item.label, url: item.url })
  }
  return { items }
}

type SettingsDoc = Omit<SiteSettingsInput, 'seoImageMediaId' | 'socials'> & {
  socials?: Array<{ label?: string | null; url?: string | null; kind?: string | null }> | null
  seoImage?: unknown
}

export const settingsInput = (doc: SettingsDoc): SiteSettingsInput => ({ ...doc, seoImageMediaId: idOf(doc.seoImage) })

/** Republishes the settings and the menu together (the menu depends on which pages are published). */
export async function republishSettings(req: PayloadRequest, docs: { settings?: SettingsDoc; navigation?: NavDoc } = {}) {
  const env = await publisherEnv()
  const settings = docs.settings ?? ((await req.payload.findGlobal({ slug: 'site-settings', depth: 0, overrideAccess: true, req })) as SettingsDoc)
  const nav = resolveNavigation(await navigationInput(req, docs.navigation), await publishedSlugs(env.DB))
  await asEditorError(() => publishSiteSettings(env, settingsInput(settings), nav, mediaLoader(req, env)))
  req.payload.logger.info({ msg: 'site settings published', menuItems: nav.length })
}

export async function republishHome(req: PayloadRequest, doc: Record<string, unknown>) {
  const env = await publisherEnv()
  await asEditorError(() => publishHome(env, homeInput(doc)))
  req.payload.logger.info({ msg: 'homepage published' })
}

/** The Homepage global as the publisher takes it (paragraphs are an array of { text }). */
export const homeInput = (doc: Record<string, unknown>) => ({
  ...doc,
  aboutParagraphs: ((doc.aboutParagraphs as Array<{ text?: string }> | undefined) ?? []).map((p) => p.text ?? ''),
})

type PageDoc = {
  id: string | number
  title?: string
  slug?: string
  lede?: string | null
  content?: PageInput['content']
  heroImage?: unknown
  showButtons?: boolean | null
  seo?: { title?: string | null; description?: string | null } | null
  updatedAt?: string | null
  _status?: 'draft' | 'published'
  deletedAt?: string | null
}

export const pageInput = (doc: PageDoc): PageInput => ({
  id: doc.id,
  slug: doc.slug ?? '',
  title: doc.title ?? '',
  lede: doc.lede,
  content: doc.content ?? null,
  heroMediaId: idOf(doc.heroImage),
  showButtons: doc.showButtons,
  seoTitle: doc.seo?.title,
  seoDescription: doc.seo?.description,
  updatedAt: doc.updatedAt ?? null,
})

/** Makes the public site match a page's main (published) document, then refreshes the menu. */
export async function syncPage(req: PayloadRequest, id: string | number) {
  const env = await publisherEnv()
  const main = (await req.payload
    .findByID({ collection: 'pages', id, draft: false, trash: true, depth: 0, overrideAccess: true, req })
    .catch(() => null)) as PageDoc | null
  if (main && main._status === 'published' && !main.deletedAt) {
    const page = await asEditorError(() => publishPage(env, pageInput(main), mediaLoader(req, env)))
    req.payload.logger.info({ msg: 'page published', slug: page.slug })
  } else if (await unpublishPage(env, id)) req.payload.logger.info({ msg: 'page unpublished', id })
  await republishSettings(req).catch((error) => req.payload.logger.error({ msg: 'menu refresh failed', message: (error as Error).message }))
}

// --- Projects (Phase 4) ---------------------------------------------------------------------------------

type ProjectDoc = {
  id: string | number
  title?: string
  slug?: string
  summary?: string | null
  content?: ProjectInput['content']
  heroImage?: unknown
  gallery?: Array<{ image?: unknown; caption?: string | null }> | null
  status?: string | null
  tags?: Array<{ tag?: string | null }> | null
  featured?: boolean | null
  order?: number | null
  websiteUrl?: string | null
  githubUrl?: string | null
  links?: Array<{ label?: string | null; url?: string | null }> | null
  listed?: boolean | null
  seo?: { title?: string | null; description?: string | null } | null
  createdAt?: string | null
  updatedAt?: string | null
  _status?: 'draft' | 'published'
  deletedAt?: string | null
}

export const projectInput = (doc: ProjectDoc): ProjectInput => ({
  id: doc.id,
  slug: doc.slug ?? '',
  title: doc.title ?? '',
  summary: doc.summary,
  content: doc.content ?? null,
  heroMediaId: idOf(doc.heroImage),
  gallery: (doc.gallery ?? []).map((g) => ({ mediaId: idOf(g.image), caption: g.caption })),
  status: doc.status,
  tags: (doc.tags ?? []).map((t) => t.tag ?? '').filter(Boolean),
  featured: doc.featured,
  order: doc.order,
  websiteUrl: doc.websiteUrl,
  githubUrl: doc.githubUrl,
  links: doc.links,
  seoTitle: doc.seo?.title,
  seoDescription: doc.seo?.description,
  publishedAt: doc.createdAt ?? null,
  updatedAt: doc.updatedAt ?? null,
})

/** Makes the public site match a project's main (published) document. */
export async function syncProject(req: PayloadRequest, id: string | number) {
  const env = await publisherEnv()
  const main = (await req.payload
    .findByID({ collection: 'projects', id, draft: false, trash: true, depth: 0, overrideAccess: true, req })
    .catch(() => null)) as ProjectDoc | null
  if (main && main._status === 'published' && !main.deletedAt && main.listed !== false) {
    const project = await asEditorError(() => publishProject(env, projectInput(main), mediaLoader(req, env)))
    req.payload.logger.info({ msg: 'project published', slug: project.slug })
  } else if (await unpublishProject(env, id)) req.payload.logger.info({ msg: 'project unpublished', id })
}

export async function republishProjectsHome(req: PayloadRequest, doc: Record<string, unknown>) {
  const env = await publisherEnv()
  const projectsHome = (doc.projectsHome ?? {}) as Record<string, unknown>
  await asEditorError(() => publishProjectsHome(env, projectsHome))
  req.payload.logger.info({ msg: 'projects homepage published' })
}
