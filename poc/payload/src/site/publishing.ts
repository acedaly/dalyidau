import type { Endpoint, PayloadRequest } from 'payload'
import { APIError, NotFound } from 'payload'

import type { MediaFile, PublisherEnv } from '../../../../worker/blog/payload-publisher'
import {
  PublishError,
  forgetEarlierDocument,
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
import { type DraftPreview, type PreviewKind, previewPath, storeDraftPreview } from '../../../../worker/site/preview'
import { GaveUp, Unsettled, retried, settle as settleLoop } from '../../../../worker/site/settle'
import { noteSyncStatus } from '../../../../worker/site/sync-check'
import { cloudflareEnv } from '../cloudflare-env'
import { seoInput } from '../fields/seo'

// The website's content (docs/PAYLOAD-FRONTEND-PLAN.md): Payload keeps it; these helpers publish what's
// published in Payload to the public site's snapshots (worker/site/publisher.ts). Drafts change nothing public.

export const publisherEnv = async (): Promise<PublisherEnv & { R2: R2Bucket }> => {
  const e = await cloudflareEnv<PublisherEnv & { R2: R2Bucket }>()
  // IMAGES and IMAGE_TRANSFORMS: smaller copies of each image are made as it is published (worker/lib/image-variants.ts).
  return { DB: e.DB, MEDIA: e.MEDIA, SITE_URL: e.SITE_URL, R2: e.R2, IMAGES: e.IMAGES, IMAGE_TRANSFORMS: e.IMAGE_TRANSFORMS }
}

/**
 * A document, or null only when it doesn't exist. A read that fails for any other reason (the database
 * having a bad moment) is thrown, never read as "gone": acting on "gone" takes things off the site.
 */
export async function findOrNull<T>(req: PayloadRequest, collection: 'pages' | 'projects' | 'posts' | 'media', id: string | number, draft = false): Promise<T | null> {
  try {
    return (await req.payload.findByID({ collection, id, draft, trash: true, depth: 0, overrideAccess: true, req })) as T
  } catch (error) {
    if (error instanceof NotFound || (error as { status?: number })?.status === 404) return null
    throw error
  }
}

type Versioned = { updatedAt?: string | null; _status?: string | null; deletedAt?: string | null; listed?: boolean | null } | null
const sameVersion = (a: Versioned, b: Versioned) =>
  (a === null) === (b === null) && a?.updatedAt === b?.updatedAt && a?._status === b?._status && (a?.deletedAt ?? null) === (b?.deletedAt ?? null) && (a?.listed ?? null) === (b?.listed ?? null)

export { DELETED_NOT_ON_SITE, NOT_CONFIRMED, SAVED_NOT_ON_SITE, reader }

/**
 * Makes the site match a document, and makes sure it still does when it's done (worker/site/settle.ts has
 * the loop and why). A document that changed under every attempt is never left unsaid: the editor is told,
 * and the sync check will show it.
 */
export async function settle<D extends Versioned>(read: (verifying: boolean) => Promise<D>, apply: (doc: D) => Promise<void>): Promise<void> {
  try {
    await settleLoop(read, apply, sameVersion)
  } catch (error) {
    if (!(error instanceof Unsettled)) throw error
    throw new APIError(`The document kept changing while the website was being updated. Check "Website sync" on the dashboard in a minute, and press Republish if it's listed.`, 503, undefined, true)
  }
}

/** A document read for a sync: retried like a write; a failed check-back says so truthfully (the site was written). */
const reader =
  <T>(req: PayloadRequest, what: string, collection: 'pages' | 'projects' | 'posts', id: string | number) =>
  (verifying: boolean) =>
    writeToSite(req, what, () => findOrNull<T>(req, collection, id), undefined, verifying ? NOT_CONFIRMED : SAVED_NOT_ON_SITE)

const idOf = (value: unknown): string | number | null =>
  value && typeof value === 'object' ? ((value as { id?: string | number }).id ?? null) : ((value as string | number | null | undefined) ?? null)

/** Reads an image from Payload's own (private) media store, for copying into the public bucket. */
export const mediaLoader = (req: PayloadRequest, env: { R2: R2Bucket }) => ({
  loadMedia: async (id: string | number): Promise<MediaFile | null> => {
    // Null only when the image really isn't there; a failed read is thrown (and retried by writeToSite).
    const media = await findOrNull<{ filename?: string; mimeType?: string; alt?: string; caption?: string | null }>(req, 'media', id)
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

const SAVED_NOT_ON_SITE = `Saved in Payload, but the website couldn't be updated, so it still shows the previous version. Nothing is lost: save again in a minute, or press Republish under "Website sync" on the dashboard.`
const DELETED_NOT_ON_SITE = `Deleted in Payload, but the website couldn't be updated, so it may still be showing. It's listed under "Website sync" on the dashboard, where an owner can remove it from the website.`
const NOT_CONFIRMED = `Saved, and the website was updated, but it couldn't be confirmed that it shows the latest version. Check "Website sync" on the dashboard in a minute.`

/**
 * A write to the public site, after Payload has already saved. A refusal (PublishError) is the editor's to
 * fix and is shown as it is. Anything else is the database or the bucket having a bad moment: it is tried
 * three times, and if it still fails the editor is told plainly that Payload has the change and the site
 * doesn't, instead of a bare error. The cron's sync check (worker/site/sync-check.ts) reports it until it's fixed.
 */
export async function writeToSite<T>(req: PayloadRequest, what: string, work: () => Promise<T>, onRetry?: () => void, failure: string = SAVED_NOT_ON_SITE): Promise<T> {
  const note = (message: string) =>
    publisherEnv()
      .then((env) => noteSyncStatus(env.DB, { lastPublishFailure: { at: new Date().toISOString(), what, message: message.slice(0, 300) } }))
      .catch(() => undefined)
  try {
    return await retried(work, { onRetry, isFinal: (error) => error instanceof PublishError || error instanceof APIError })
  } catch (error) {
    if (error instanceof APIError) throw error
    if (error instanceof PublishError) {
      // Refused now although the check before saving passed (an image deleted or an address taken in
      // between). Payload has already saved, so the message must not read as "not saved".
      req.payload.logger.error({ msg: 'site_sync_refused', what, message: error.message })
      await note(error.message)
      throw new APIError(`Saved in Payload, but not published on the website: ${error.message}`, 400, undefined, true)
    }
    const last = error instanceof GaveUp ? error.last : error
    req.payload.logger.error({ msg: 'site_sync_failed', what, message: (last as Error)?.message })
    // Kept for the dashboard too (best effort: the site's database may be what's failing).
    await note(String((last as Error)?.message ?? last))
    throw new APIError(failure, 503, undefined, true)
  }
}

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
        ? await findOrNull<{ slug?: string; _status?: string; deletedAt?: string | null }>(req, 'pages', id)
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
  // Read and written as one retried step: a failed read of the menu's pages never becomes a shorter menu.
  const count = await writeToSite(req, 'site settings', async () => {
    const settings = docs.settings ?? ((await req.payload.findGlobal({ slug: 'site-settings', depth: 0, overrideAccess: true, req })) as SettingsDoc)
    const nav = resolveNavigation(await navigationInput(req, docs.navigation), await publishedSlugs(env.DB))
    await publishSiteSettings(env, settingsInput(settings), nav, mediaLoader(req, env))
    return nav.length
  })
  req.payload.logger.info({ msg: 'site settings published', menuItems: count })
}

export async function republishHome(req: PayloadRequest, doc: Record<string, unknown>) {
  const env = await publisherEnv()
  await writeToSite(req, 'homepage', () => publishHome(env, homeInput(doc)))
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
  seo?: Parameters<typeof seoInput>[0]
  createdAt?: string | null
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
  seo: seoInput(doc.seo),
  createdAt: doc.createdAt ?? null,
  updatedAt: doc.updatedAt ?? null,
})

/**
 * Makes the public site match a page's main (published) document, then refreshes the menu when what's
 * public changed (the menu shows a page only while it's published). A draft save of a page that isn't on the
 * site changes nothing public and touches nothing.
 */
export async function syncPage(req: PayloadRequest, id: string | number, deleted = false, created = false) {
  const env = await publisherEnv()
  // A new document may have been given a deleted one's number: it starts with no kept addresses.
  if (created) await writeToSite(req, `page ${id}`, () => forgetEarlierDocument(env, 'page', id))
  let changed = false
  const assumeChanged = () => void (changed = true)
  try {
    await settle(reader<PageDoc>(req, `page ${id}`, 'pages', id), async (main) => {
      if (main && main._status === 'published' && !main.deletedAt) {
        changed = true // even if the write's answer is lost
        const page = await writeToSite(req, `page ${id}`, () => publishPage(env, pageInput(main), mediaLoader(req, env)))
        req.payload.logger.info({ msg: 'page published', slug: page.slug })
        return
      }
      // No document, and not because it was just deleted: nothing is known, so nothing is taken down.
      if (!main && !deleted) return
      // Deleted for good (afterDelete; Trash is an update): the addresses kept for it are released.
      const removed = await writeToSite(req, `page ${id}`, () => unpublishPage(env, id, { forget: deleted && !main, createdAt: main?.createdAt }), assumeChanged, deleted ? DELETED_NOT_ON_SITE : SAVED_NOT_ON_SITE)
      if (removed) {
        req.payload.logger.info({ msg: 'page unpublished', id })
        changed = true
      }
    })
  } finally {
    // Whatever happened above, a page that went on or came off the site gets the menu rebuilt.
    if (changed) await republishSettings(req)
  }
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
  seo?: Parameters<typeof seoInput>[0]
  createdAt?: string | null
  updatedAt?: string | null
  _status?: 'draft' | 'published'
  deletedAt?: string | null
}

type Node = { type?: string; tag?: string; text?: string; children?: Node[] }
const hasText = (node: Node): boolean => (node.type === 'text' ? Boolean(node.text?.trim()) : node.type === 'upload' || (node.children ?? []).some(hasText))

/**
 * A project's write-up without the sections nobody filled in. A new project starts with suggested headings
 * (collections/Projects.ts projectTemplate); one left with nothing under it would otherwise be published as a
 * bare heading. A heading is dropped when it, or everything between it and the next heading, is empty.
 */
export function withoutEmptySections(content: ProjectInput['content']): ProjectInput['content'] {
  const nodes = (content?.root?.children ?? []) as Node[]
  if (!nodes.some((n) => n.type === 'heading')) return content
  const kept: Node[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.type !== 'heading') {
      kept.push(node)
      continue
    }
    let end = i + 1
    while (end < nodes.length && nodes[end].type !== 'heading') end++
    // Kept: a heading with words of its own and something under it.
    if (hasText(node) && nodes.slice(i + 1, end).some(hasText)) kept.push(node)
    else i = end - 1
  }
  return { ...content, root: { ...content!.root, children: kept } } as ProjectInput['content']
}

export const projectInput = (doc: ProjectDoc): ProjectInput => ({
  id: doc.id,
  slug: doc.slug ?? '',
  title: doc.title ?? '',
  summary: doc.summary,
  content: withoutEmptySections(doc.content ?? null),
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
  seo: seoInput(doc.seo),
  publishedAt: doc.createdAt ?? null,
  createdAt: doc.createdAt ?? null,
  updatedAt: doc.updatedAt ?? null,
})

/** Makes the public site match a project's main (published) document. */
export async function syncProject(req: PayloadRequest, id: string | number, deleted = false, created = false) {
  const env = await publisherEnv()
  // A new document may have been given a deleted one's number: it starts with no kept addresses.
  if (created) await writeToSite(req, `project ${id}`, () => forgetEarlierDocument(env, 'project', id))
  await settle(reader<ProjectDoc>(req, `project ${id}`, 'projects', id), async (main) => {
    if (main && main._status === 'published' && !main.deletedAt && main.listed !== false) {
      const project = await writeToSite(req, `project ${id}`, () => publishProject(env, projectInput(main), mediaLoader(req, env)))
      req.payload.logger.info({ msg: 'project published', slug: project.slug })
      return
    }
    // No document, and not because it was just deleted: nothing is known, so nothing is taken down.
    if (!main && !deleted) return
    // Deleted for good (afterDelete; Trash is an update): the addresses kept for it are released.
    if (await writeToSite(req, `project ${id}`, () => unpublishProject(env, id, { forget: deleted && !main, createdAt: main?.createdAt }), undefined, deleted ? DELETED_NOT_ON_SITE : SAVED_NOT_ON_SITE))
      req.payload.logger.info({ msg: 'project unpublished', id })
  })
}

export async function republishProjectsHome(req: PayloadRequest, doc: Record<string, unknown>) {
  const env = await publisherEnv()
  const projectsHome = (doc.projectsHome ?? {}) as Record<string, unknown>
  await writeToSite(req, 'projects homepage', () => publishProjectsHome(env, projectsHome))
  req.payload.logger.info({ msg: 'projects homepage published' })
}

// --- Checks before saving (docs/AUDIT-2026-11.md, H3) -----------------------------------------------------

/** True when saving this would leave the document published and out of Trash. */
export const willBePublic = (data: Record<string, unknown>, originalDoc?: Record<string, unknown> | null) =>
  statusAfter(data, originalDoc) === 'published' && !('deletedAt' in data ? data.deletedAt : originalDoc?.deletedAt)

/**
 * The status the document will have once this save is done. A change that doesn't mention the status (an
 * API call that only swaps the featured image, say) leaves a published document published, so it is checked
 * like a publish. A draft save always says "draft".
 */
export const statusAfter = (data: Record<string, unknown>, originalDoc?: Record<string, unknown> | null) => data._status ?? originalDoc?._status

/**
 * Everything publishing this page would check, run before Payload saves it and writing nothing: an address
 * in use, a featured image that can't be read or is damaged. What can be known in advance is refused here,
 * while nothing has been saved, rather than after.
 */
export async function checkPage(req: PayloadRequest, doc: PageDoc) {
  const env = await publisherEnv()
  await asEditorError(() => publishPage(env, pageInput(doc), { ...mediaLoader(req, env), mode: 'check' }))
}

export async function checkProject(req: PayloadRequest, doc: ProjectDoc) {
  const env = await publisherEnv()
  await asEditorError(() => publishProject(env, projectInput(doc), { ...mediaLoader(req, env), mode: 'check' }))
}

// --- Draft preview (docs/AUDIT-2026-11.md, H5) ------------------------------------------------------------

type PreviewData<K extends PreviewKind> = Extract<DraftPreview, { kind: K }>['data']
type PreviewLoader = ReturnType<typeof mediaLoader> & { mode: 'preview' }

const previewProblem = (message: string, status: number) =>
  new Response(
    `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Can’t preview yet</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1rem;line-height:1.5}</style></head>
<body><h1>This can’t be previewed yet</h1><p>${message.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</p><p>Fix that in the admin, save the draft, and press Preview again.</p></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } },
  )

/**
 * GET /api/<collection>/:id/preview: builds the latest saved version of a document (a draft, if there is one)
 * exactly as publishing would, keeps the result privately and sends the editor to see it on the site's own
 * pages (worker/site/preview.ts). Nothing public changes. Owners and admins only.
 */
export function previewEndpoint<K extends PreviewKind>(
  kind: K,
  collection: 'pages' | 'projects' | 'posts',
  build: (env: Awaited<ReturnType<typeof publisherEnv>>, doc: Record<string, unknown>, loader: PreviewLoader) => Promise<PreviewData<K>>,
): Endpoint {
  return {
    path: '/:id/preview',
    method: 'get',
    handler: async (req) => {
      const role = (req.user as { portalRole?: string } | null)?.portalRole
      if (role !== 'owner' && role !== 'admin') return Response.json({ error: 'forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
      // It stores a preview, so like a write it must be asked for from this site (the admin's Preview
      // button, or the address typed in), not by a page somewhere else sending the editor here.
      const from = req.headers.get('sec-fetch-site')
      if (from && from !== 'same-origin' && from !== 'none') return Response.json({ error: 'cross_site' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
      const id = String(req.routeParams?.id ?? '')
      const find = (draft: boolean) => findOrNull<Record<string, unknown>>(req, collection, id, draft)
      const [latest, main] = [await find(true), await find(false)]
      if (!latest) return previewProblem('That document no longer exists.', 404)
      const env = await publisherEnv()
      let data: PreviewData<K>
      try {
        data = await build(env, latest, { ...mediaLoader(req, env), mode: 'preview' })
      } catch (error) {
        if (error instanceof PublishError) return previewProblem(error.message, 422)
        throw error
      }
      const preview = { kind, createdAt: new Date().toISOString(), published: main?._status === 'published' && !main?.deletedAt, data } as DraftPreview
      await storeDraftPreview(env.DB, preview, id)
      return new Response(null, { status: 302, headers: { Location: previewPath(kind, id), 'Cache-Control': 'no-store' } })
    },
  }
}

export const pagePreview = previewEndpoint('page', 'pages', (env, doc, loader) => publishPage(env, pageInput(doc as PageDoc), loader))
export const projectPreview = previewEndpoint('project', 'projects', (env, doc, loader) => publishProject(env, projectInput(doc as ProjectDoc), loader))
