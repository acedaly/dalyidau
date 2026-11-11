import type { MigrateDownArgs, MigrateUpArgs } from '@payloadcms/db-d1-sqlite'

import { DEFAULT_ABOUT, DEFAULT_HOME, DEFAULT_SITE } from '../../../../src/shared/site-content'
import { publisherEnv } from '../site/publishing'

// Data migration: the website's words move into Payload (docs/PAYLOAD-FRONTEND-PLAN.md). The globals
// and the About page get exactly the text the site shows today, and are published, so the public pages
// look the same before and after. It runs once, when Payload first starts after the deploy. Anything
// that already exists (a page at /about, a saved global) is left as it is.

const paragraph = (text: string) => ({
  type: 'paragraph',
  version: 1,
  direction: 'ltr',
  format: '',
  indent: 0,
  textFormat: 0,
  textStyle: '',
  children: [{ type: 'text', version: 1, text, format: 0, detail: 0, mode: 'normal', style: '' }],
})

export const lexicalParagraphs = (paragraphs: string[]) => ({
  root: { type: 'root', version: 1, direction: 'ltr', format: '', indent: 0, children: paragraphs.map(paragraph) },
})

const saved = (doc: { updatedAt?: string | null; createdAt?: string | null } | null | undefined) => Boolean(doc?.updatedAt || doc?.createdAt)

export async function up({ payload, req }: MigrateUpArgs): Promise<void> {
  // 1. The About page.
  const existing = await payload.find({ collection: 'pages', where: { slug: { equals: 'about' } }, trash: true, limit: 1, overrideAccess: true, req })
  let aboutId = existing.docs[0]?.id
  if (!aboutId) {
    const about = await payload.create({
      collection: 'pages',
      overrideAccess: true,
      req,
      data: {
        title: DEFAULT_ABOUT.title,
        slug: 'about',
        lede: DEFAULT_ABOUT.lede,
        content: lexicalParagraphs(DEFAULT_ABOUT.paragraphs ?? []) as never,
        showButtons: true,
        seo: { description: DEFAULT_ABOUT.seoDescription },
        _status: 'published',
      } as never,
    })
    aboutId = about.id
  }

  // 2. Site settings, 3. the menu, 4. the homepage: only if they've never been saved.
  if (!saved((await payload.findGlobal({ slug: 'site-settings', overrideAccess: true, req })) as never)) {
    await payload.updateGlobal({
      slug: 'site-settings',
      overrideAccess: true,
      req,
      data: {
        name: DEFAULT_SITE.name,
        shortName: DEFAULT_SITE.shortName,
        title: DEFAULT_SITE.title,
        description: DEFAULT_SITE.description,
        blogTitle: DEFAULT_SITE.blogTitle,
        blogDescription: DEFAULT_SITE.blogDescription,
        email: DEFAULT_SITE.email,
        socials: [],
        contact: DEFAULT_SITE.contact,
      } as never,
    })
  }
  if (!saved((await payload.findGlobal({ slug: 'navigation', overrideAccess: true, req })) as never)) {
    await payload.updateGlobal({
      slug: 'navigation',
      overrideAccess: true,
      req,
      data: {
        items: [
          { label: 'Home', type: 'url', url: '/' },
          { label: 'Blog', type: 'url', url: '/blog' },
          { label: 'About', type: 'page', page: aboutId },
          { label: 'Contact', type: 'url', url: '/contact' },
        ],
      } as never,
    })
  }
  if (!saved((await payload.findGlobal({ slug: 'homepage', overrideAccess: true, req })) as never)) {
    const { aboutParagraphs, ...home } = DEFAULT_HOME
    await payload.updateGlobal({
      slug: 'homepage',
      overrideAccess: true,
      req,
      data: { ...home, aboutParagraphs: aboutParagraphs.map((text) => ({ text })), _status: 'published' } as never,
    })
  }
  payload.logger.info({ msg: 'website content seeded', aboutId })
}

// Takes the published snapshots away again, so the site shows its built-in text (the same words).
// Payload's own documents are kept.
export async function down({ payload }: MigrateDownArgs): Promise<void> {
  const env = await publisherEnv()
  await env.DB.batch([
    env.DB.prepare("DELETE FROM meta WHERE key IN ('site:settings', 'site:home', 'site:pages-managed') OR key LIKE 'page:%' OR key LIKE 'page-id:%' OR key LIKE 'page-redirect:%'"),
    env.DB.prepare("INSERT INTO meta (key, value) VALUES ('content_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(new Date().toISOString()),
  ])
  payload.logger.info({ msg: 'website snapshots removed' })
}
