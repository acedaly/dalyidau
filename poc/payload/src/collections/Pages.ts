import type { CollectionConfig } from 'payload'
import { APIError } from 'payload'

import { pageProblem } from '../../../../worker/site/publisher'
import { slugify } from '../../../../worker/lib/html'
import { checkPage, pagePreview, publisherEnv, syncPage, statusAfter, willBePublic } from '../site/publishing'
import { seoFields } from '../fields/seo'
import { contentEditor } from './Users'

// Pages on daly.id.au/<address> (the About page is one). Publishing puts a page on the site straight
// away, Unpublish or Trash take it down, and a renamed page's old address redirects to the new one.
export const Pages: CollectionConfig = {
  slug: 'pages',
  labels: { singular: 'Page', plural: 'Pages' },
  admin: {
    useAsTitle: 'title',
    group: 'Website',
    defaultColumns: ['title', 'slug', '_status', 'updatedAt'],
    description: 'Pages at daly.id.au/<address>. Publishing puts a page on the site straight away; add it to Navigation to show it in the menu.',
    // The latest saved version, draft or not, as it will look on the site (src/site/publishing.ts previewEndpoint).
    preview: (doc) => (doc?.id ? `/api/pages/${doc.id}/preview` : null),
  },
  versions: { drafts: true, maxPerDoc: 50 },
  trash: true,
  access: {
    // Only owners and admins, even for reading: the public reads the site, never this API.
    read: ({ req }) => contentEditor(req.user as never),
    create: ({ req }) => contentEditor(req.user as never),
    update: ({ req }) => contentEditor(req.user as never),
    delete: ({ req }) => (req.user as { portalRole?: string } | null)?.portalRole === 'owner',
    readVersions: ({ req }) => contentEditor(req.user as never),
  },
  endpoints: [pagePreview],
  hooks: {
    // The address fills in from the title when it is left empty, drafts included (it is required, and checked before the hooks below run).
    beforeValidate: [
      ({ data, originalDoc }) => {
        if (data && !data.slug && !originalDoc?.slug && typeof data.title === 'string' && data.title.trim()) data.slug = slugify(data.title)
        return data
      },
    ],
    beforeChange: [
      async ({ data, originalDoc, req }) => {
        const slug = slugify(String(data.slug ?? originalDoc?.slug ?? data.title ?? ''))
        if (slug) data.slug = slug
        // Another page (published or not, Trash included) already has this address: say so, rather than
        // letting the database's unique index fail with a 500.
        if (slug) {
          const others = await req.payload.find({
            collection: 'pages',
            where: { slug: { equals: slug }, ...(originalDoc?.id !== undefined ? { id: { not_equals: originalDoc.id } } : {}) },
            trash: true,
            limit: 1,
            depth: 0,
            overrideAccess: true,
            req,
          })
          if (others.totalDocs) throw new APIError(`daly.id.au/${slug} is already used by another page.`, 400, undefined, true)
        }
        // What the document will be after this save (a change that doesn't mention the status keeps it).
        if (statusAfter(data, originalDoc) !== 'published') return data
        const problem = pageProblem({ slug, title: String(data.title ?? originalDoc?.title ?? '') })
        if (problem) throw new APIError(problem, 400, undefined, true)
        const env = await publisherEnv()
        const owner = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(`page:${slug}`).first<{ value: string }>()
        let ownerId: unknown
        try {
          ownerId = owner ? (JSON.parse(owner.value) as { id?: unknown } | null)?.id : undefined
        } catch {
          ownerId = undefined // a damaged snapshot belongs to nobody
        }
        if (ownerId !== undefined && String(ownerId) !== String(originalDoc?.id))
          throw new APIError(`daly.id.au/${slug} is already used by another page.`, 400, undefined, true)
        // Then everything else a publish checks (the featured image, the rendered page), still before saving.
        if (willBePublic(data, originalDoc)) await checkPage(req, { ...originalDoc, ...data, slug, id: originalDoc?.id ?? 'new' })
        return data
      },
    ],
    afterChange: [async ({ doc, req, context, operation }) => (context?.skipPublicSync ? doc : (await syncPage(req, doc.id, false, operation === 'create'), doc))],
    afterDelete: [async ({ doc, req, context }) => void (context?.skipPublicSync ? null : await syncPage(req, doc.id, true))],
  },
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'slug',
      label: 'Address',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: {
        position: 'sidebar',
        description: 'daly.id.au/<address>: lower-case letters, numbers and hyphens. Changing it keeps the old address redirecting. Addresses the site uses itself (blog, wedding, contact, admin…) are refused.',
      },
    },
    { name: 'lede', label: 'Introduction', type: 'textarea', admin: { description: 'Shown under the title, and in search results unless a description is set below.' } },
    { name: 'heroImage', label: 'Featured image', type: 'upload', relationTo: 'media', admin: { description: 'Optional, shown above the text (JPEG, PNG, GIF, WebP or AVIF, up to 15 MB).' } },
    { name: 'content', type: 'richText' },
    { name: 'showButtons', label: 'End with "Read the blog" and "Say hello" buttons', type: 'checkbox', defaultValue: false, admin: { position: 'sidebar' } },
    seoFields({ title: '"<title> — <site name>"', description: 'the introduction', image: 'the featured image' }),
  ],
}
