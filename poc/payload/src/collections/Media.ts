import type { CollectionBeforeDeleteHook, CollectionConfig } from 'payload'
import { APIError } from 'payload'

import { cloudflareEnv } from '../cloudflare-env'
import { contentEditor } from './Users'

/** What may be uploaded: the same five types the public site publishes. */
export const MEDIA_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'] as const
/** The public site's own limit (worker/lib/image.ts), enforced at upload too. */
export const MEDIA_MAX_BYTES = 15 * 1024 * 1024

/**
 * Refuses to delete an image that something still uses (docs/AUDIT-2026-11.md, M3). Before, the database
 * quietly emptied the field that pointed at it, and an image inside an article's text was left out the next
 * time the article was published. Drafts (including a newer draft of something already published) and items in Trash count: they'd lose it
 * just the same. Older versions don't: they're history, and keep working without it.
 */
const refuseIfInUse: CollectionBeforeDeleteHook = async ({ id }) => {
  const { D1 } = await cloudflareEnv<{ D1: D1Database }>()
  const n = Number(id)
  // In rich text an image is an upload node, whose JSON has `"relationTo":"media","value":<id>` side by side
  // (followed by `}` as the editor saves it, or `,` when other keys come after). Matched as that exact run:
  // `"value":3}` on its own is also how a numbered list's third item is stored.
  const patterns = [`%"relationTo":"media","value":${n}}%`, `%"relationTo":"media","value":${n},%`]
  const text = (table: string, column: string, title: string, where = '') =>
    `SELECT ${title} AS title FROM ${table} WHERE (${column} LIKE ?2 OR ${column} LIKE ?3)${where}`
  // Every statement takes the same three values (the id and the two patterns); those that only need the id say so with `?2 IS NOT ?3`.
  const byId = (sql: string) => `${sql} AND ?2 IS NOT ?3`
  // The published (or only) copy of each document, and the latest saved draft of each, which lives in its
  // version table. One short statement each, sent together: D1 allows only a few SELECTs joined by UNION.
  const queries: Array<[string, string]> = [
    ['Blog post', byId(`SELECT title FROM posts WHERE (hero_image_id = ?1 OR seo_image_id = ?1)`)],
    ['Blog post', text('posts', 'content', 'title')],
    ['Blog post', byId(`SELECT version_title AS title FROM _posts_v WHERE latest = 1 AND (version_hero_image_id = ?1 OR version_seo_image_id = ?1)`)],
    ['Blog post', text('_posts_v', 'version_content', 'version_title', ' AND latest = 1')],
    ['Page', byId(`SELECT title FROM pages WHERE (hero_image_id = ?1 OR seo_image_id = ?1)`)],
    ['Page', text('pages', 'content', 'title')],
    ['Page', byId(`SELECT version_title AS title FROM _pages_v WHERE latest = 1 AND (version_hero_image_id = ?1 OR version_seo_image_id = ?1)`)],
    ['Page', text('_pages_v', 'version_content', 'version_title', ' AND latest = 1')],
    ['Project', byId(`SELECT title FROM projects WHERE (hero_image_id = ?1 OR seo_image_id = ?1)`)],
    ['Project', byId(`SELECT p.title AS title FROM projects p JOIN projects_gallery g ON g._parent_id = p.id WHERE g.image_id = ?1`)],
    ['Project', text('projects', 'content', 'title')],
    ['Project', byId(`SELECT version_title AS title FROM _projects_v WHERE latest = 1 AND (version_hero_image_id = ?1 OR version_seo_image_id = ?1)`)],
    ['Project', byId(`SELECT v.version_title AS title FROM _projects_v v JOIN _projects_v_version_gallery g ON g._parent_id = v.id WHERE v.latest = 1 AND g.image_id = ?1`)],
    ['Project', text('_projects_v', 'version_content', 'version_title', ' AND latest = 1')],
    ['Site settings', byId(`SELECT 'the default sharing image' AS title FROM site_settings WHERE seo_image_id = ?1`)],
  ]
  const found = await D1.batch<{ title: string | null }>(queries.map(([, sql]) => D1.prepare(sql).bind(n, ...patterns)))
  const uses = new Set<string>()
  found.forEach((result, i) => {
    const kind = queries[i][0]
    for (const row of result.results) uses.add(kind === 'Site settings' ? `Site settings (${row.title})` : `${kind} “${row.title ?? 'untitled'}”`)
  })
  if (uses.size) {
    const list = [...uses]
    throw new APIError(
      `This image is still used by ${list.slice(0, 5).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}. Take it out of ${list.length === 1 ? 'that' : 'those'} first, then delete it.`,
      400,
      undefined,
      true,
    )
  }
}

export const Media: CollectionConfig = {
  slug: 'media',
  admin: {
    group: 'Blog and Media',
    description:
      'Every image, in one library. Upload the largest good version you have (JPEG, PNG, GIF, WebP or AVIF, up to 15 MB): the site makes the smaller sizes itself. Only what a published page uses is copied to the public site.',
  },
  access: {
    // Only the people who edit the website: file names and alt text can give away drafts (audit L5).
    read: ({ req }) => contentEditor(req.user as never),
    create: ({ req }) => contentEditor(req.user as never),
    update: ({ req }) => contentEditor(req.user as never),
    delete: ({ req }) => contentEditor(req.user as never),
  },
  hooks: { beforeDelete: [refuseIfInUse] },
  fields: [
    {
      name: 'alt',
      label: 'Alt text',
      type: 'text',
      required: true,
      admin: { description: 'What the image shows, as you would say it to someone who can’t see it. Read out by screen readers and shown if the image doesn’t load.' },
    },
  ],
  upload: {
    // These are not supported on Workers yet due to lack of sharp
    crop: false,
    focalPoint: false,
    // Only the image types the public site can publish (worker/lib/image.ts). Payload goes by the type
    // it detects from the file's bytes, or failing that its extension, never the browser's label, so an
    // SVG, HTML or script file is refused at upload instead of sitting in the library. (A file that starts
    // like a real image is stored as that image; whatever is stored is served as a sandboxed, no-script
    // response, platform/compose.ts API_CSP.) The 15 MB limit is in payload.config.ts (upload.limits).
    mimeTypes: [...MEDIA_MIME_TYPES],
  },
}
