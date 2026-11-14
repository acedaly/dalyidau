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
 * time the article was published. Drafts and items in Trash count: they'd lose it just the same. Old versions
 * don't: they're history, and keep working without it.
 */
const refuseIfInUse: CollectionBeforeDeleteHook = async ({ id }) => {
  const { D1 } = await cloudflareEnv<{ D1: D1Database }>()
  const n = Number(id)
  // In an article's or page's text an image is an upload node: {"type":"upload", … "value":<id>}.
  const inText = [`%"relationTo":"media"%"value":${n},%`, `%"relationTo":"media"%"value":${n}}%`, `%"value":${n},%"relationTo":"media"%`, `%"value":${n}}%"relationTo":"media"%`]
  const text = (table: string) => `SELECT title FROM ${table} WHERE ${inText.map((_, i) => `content LIKE ?${i + 2}`).join(' OR ')}`
  const queries: Array<[string, string]> = [
    ['Blog post', `SELECT title FROM posts WHERE hero_image_id = ?1 OR seo_image_id = ?1 UNION ${text('posts')}`],
    ['Page', `SELECT title FROM pages WHERE hero_image_id = ?1 OR seo_image_id = ?1 UNION ${text('pages')}`],
    ['Project', `SELECT title FROM projects WHERE hero_image_id = ?1 OR seo_image_id = ?1 UNION SELECT p.title FROM projects p JOIN projects_gallery g ON g._parent_id = p.id WHERE g.image_id = ?1 UNION ${text('projects')}`],
    ['Site settings', `SELECT 'the default sharing image' AS title FROM site_settings WHERE seo_image_id = ?1`],
  ]
  const uses: string[] = []
  for (const [kind, sql] of queries) {
    const { results } = await D1.prepare(sql)
      .bind(n, ...(sql.includes('LIKE') ? inText : []))
      .all<{ title: string | null }>()
    for (const row of results) uses.push(kind === 'Site settings' ? `Site settings (${row.title})` : `${kind} “${row.title ?? 'untitled'}”`)
  }
  if (uses.length)
    throw new APIError(
      `This image is still used by ${uses.slice(0, 5).join(', ')}${uses.length > 5 ? ` and ${uses.length - 5} more` : ''}. Take it out of ${uses.length === 1 ? 'that' : 'those'} first, then delete it.`,
      400,
      undefined,
      true,
    )
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
