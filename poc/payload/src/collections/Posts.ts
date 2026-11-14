import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, CollectionBeforeChangeHook, CollectionConfig } from 'payload'
import { APIError } from 'payload'

import type { PayloadRequest } from 'payload'

import { type PayloadPostInput, preparePayloadPost, unpublishPayloadPost } from '../../../../worker/blog/payload-publisher'
import { isValidSlug, slugify } from '../../../../worker/lib/html'
import { DELETED_NOT_ON_SITE, asEditorError, mediaLoader, previewEndpoint, publisherEnv, reader, settle, statusAfter, willBePublic, writeToSite } from '../site/publishing'
import { seoFields, seoInput } from '../fields/seo'
import { contentEditor } from './Users'

// The blog's posts (docs/PAYLOAD-BLOG.md). Payload is where they're written and kept. The public
// site keeps rendering them from the `posts` table, which this collection's hooks keep in step with
// Payload's main (published) document: publishing writes the post there, unpublishing or deleting
// removes it. Saving a draft changes nothing public.

type PostDoc = {
  id: number | string
  title?: string
  slug?: string
  publicId?: string
  subtitle?: string | null
  summary?: string | null
  category?: string | null
  tags?: Array<{ tag?: string | null }> | null
  featured?: boolean | null
  heroImage?: number | string | { id: number | string } | null
  content?: PayloadPostInput['content']
  publishedAt?: string | null
  updatedDate?: string | null
  updatedAt?: string | null
  seo?: Parameters<typeof seoInput>[0]
  legacy?: {
    bodyHtml?: string | null
    toc?: unknown
    searchText?: string | null
    wordCount?: number | null
    readingMinutes?: number | null
    imageKey?: string | null
    imageAlt?: string | null
    imageWidth?: number | null
    imageHeight?: number | null
  } | null
  _status?: 'draft' | 'published'
  deletedAt?: string | null
}

const idOf = (value: PostDoc['heroImage']) => (value && typeof value === 'object' ? value.id : (value ?? null))

/** The publisher's input for a Payload document. */
export const toPublisherInput = (doc: PostDoc): PayloadPostInput => {
  const legacy = doc.legacy?.bodyHtml
    ? {
        body_html: doc.legacy.bodyHtml,
        toc: (Array.isArray(doc.legacy.toc) ? doc.legacy.toc : []) as NonNullable<PayloadPostInput['legacy']>['toc'],
        search_text: doc.legacy.searchText ?? '',
        word_count: doc.legacy.wordCount ?? 0,
        reading_minutes: doc.legacy.readingMinutes ?? 1,
      }
    : null
  return {
    postId: doc.publicId || `payload:${doc.id}`,
    slug: doc.slug ?? '',
    title: doc.title ?? '',
    subtitle: doc.subtitle,
    summary: doc.summary,
    category: doc.category,
    tags: (doc.tags ?? []).map((t) => t.tag ?? '').filter(Boolean),
    featured: doc.featured,
    publishedAt: doc.publishedAt ?? null,
    updatedAt: doc.updatedDate ?? null,
    sourceUpdatedAt: doc.updatedAt ?? null,
    content: doc.content ?? null,
    legacy,
    heroMediaId: idOf(doc.heroImage),
    seo: seoInput(doc.seo),
    legacyImage: doc.legacy?.imageKey
      ? {
          key: doc.legacy.imageKey,
          alt: doc.legacy.imageAlt ?? '',
          width: doc.legacy.imageWidth ?? null,
          height: doc.legacy.imageHeight ?? null,
        }
      : null,
  }
}

/** Fields only server code writes (hooks, the import with overrideAccess): never a request, on create or update. */
const SERVER_ONLY = { create: () => false, update: () => false }

/** A new post gets its public id once, at creation; it never changes. */
const assignPublicId: CollectionBeforeChangeHook = ({ data, operation }) => {
  if (operation === 'create' && !data.publicId) data.publicId = `payload:${crypto.randomUUID()}`
  return data
}

/** Refuses a publish that would fail anyway, before anything is saved. */
const validateBeforePublish: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
  // What the post will be after this save (a change that doesn't mention the status keeps it).
  if (statusAfter(data, originalDoc) !== 'published') return data
  const slug = slugify(String(data.slug ?? originalDoc?.slug ?? data.title ?? ''))
  if (!slug || !isValidSlug(slug)) throw new APIError('Give the post a web address made of lower-case letters, numbers and hyphens.', 400, undefined, true)
  data.slug = slug
  if (!data.publishedAt && !originalDoc?.publishedAt) data.publishedAt = new Date().toISOString()
  const env = await publisherEnv()
  const publicId = String(data.publicId ?? originalDoc?.publicId ?? '')
  const clash = await env.DB.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?').bind(slug, publicId).first<{ id: string }>()
  if (clash) throw new APIError(`/blog/${slug} is already used by another post.`, 400, undefined, true)
  // Then everything else a publish checks (some content, a featured image that can be read, a row another
  // publisher owns), run in full and writing nothing, while nothing has been saved yet.
  if (willBePublic(data, originalDoc)) {
    const merged = { ...originalDoc, ...data, slug, publicId, id: originalDoc?.id ?? 'new' } as PostDoc
    await asEditorError(() => preparePayloadPost(env, toPublisherInput(merged), { ...mediaLoader(req, env), mode: 'check' }))
  }
  req.payload.logger.info({ msg: 'post publish validated', slug })
  return data
}

/**
 * Makes the public site match Payload's main (published) document of a post. Also what Republish runs
 * (site/sync.ts). `siteId` is the post's id on the site, for when Payload has no document any more.
 */
export async function syncPost(req: PayloadRequest, id: number | string, options: { siteId?: string; deleted?: boolean } = {}) {
  const env = await publisherEnv()
  // The main document, never a draft version: a draft save leaves it (and the public site) as it was.
  // Null only when the post really is gone; a read that fails is retried, then reported (never read as "gone").
  await settle(reader<PostDoc>(req, `post ${id}`, 'posts', id), async (main) => {
    // In Trash (deleted, restorable) counts as unpublished.
    if (main && main._status === 'published' && !main.deletedAt) {
      const result = await writeToSite(req, `post ${id}`, () => preparePayloadPost(env, toPublisherInput(main), mediaLoader(req, env)))
      req.payload.logger.info({ msg: 'blog post published', outcome: result.outcome.outcome, slug: result.slug })
      return
    }
    // No document, and not because it was just deleted: nothing is known, so nothing is taken down.
    if (!main && !options.deleted) return
    const siteId = main ? toPublisherInput(main).postId : options.siteId
    if (!siteId) return
    // Deleted for good: the addresses kept for it while it was unpublished or in Trash are released.
    const removed = await writeToSite(
      req,
      `post ${id}`,
      () => unpublishPayloadPost(env, siteId, { forget: !!options.deleted && !main }),
      undefined,
      options.deleted ? DELETED_NOT_ON_SITE : undefined,
    )
    if (removed) req.payload.logger.info({ msg: 'blog post unpublished', postId: siteId })
  })
}

const syncPublicPost: CollectionAfterChangeHook = async ({ doc, req, context }) => {
  if (!context?.skipPublicSync) await syncPost(req, doc.id)
  return doc
}

const removePublicPost: CollectionAfterDeleteHook = async ({ doc, req, context }) => {
  if (!context?.skipPublicSync) await syncPost(req, doc.id, { siteId: toPublisherInput(doc as PostDoc).postId, deleted: true })
}

export const Posts: CollectionConfig = {
  slug: 'posts',
  labels: { singular: 'Blog post', plural: 'Blog posts' },
  admin: {
    useAsTitle: 'title',
    group: 'Blog and Media',
    defaultColumns: ['title', 'slug', '_status', 'publishedAt'],
    description: 'Posts on daly.id.au/blog. Publishing puts a post on the site straight away; Unpublish takes it down.',
    // The latest saved version, draft or not, as it will look on the site (src/site/publishing.ts previewEndpoint).
    preview: (doc) => (doc?.id ? `/api/posts/${doc.id}/preview` : null),
  },
  versions: { drafts: true, maxPerDoc: 50 },
  // Trash: moving a post there (an update) takes it off the site and keeps it restorable. Deleting permanently is owners only.
  trash: true,
  access: {
    // Only owners and admins, even for reading: the public reads the site, never this API.
    read: ({ req }) => contentEditor(req.user as never),
    create: ({ req }) => contentEditor(req.user as never),
    update: ({ req }) => contentEditor(req.user as never),
    delete: ({ req }) => (req.user as { portalRole?: string } | null)?.portalRole === 'owner',
    readVersions: ({ req }) => contentEditor(req.user as never),
  },
  endpoints: [
    previewEndpoint('post', 'posts', async (env, doc, loader) => {
      const prepared = await preparePayloadPost(env, toPublisherInput(doc as PostDoc), loader)
      return { slug: prepared.slug, record: prepared.record }
    }),
  ],
  hooks: {
    // The address fills in from the title when it is left empty, drafts included (it is required, and checked before the hooks below run).
    beforeValidate: [
      ({ data, originalDoc }) => {
        if (data && !data.slug && !originalDoc?.slug && typeof data.title === 'string' && data.title.trim()) data.slug = slugify(data.title)
        return data
      },
    ],
    beforeChange: [assignPublicId, validateBeforePublish],
    afterChange: [syncPublicPost],
    afterDelete: [removePublicPost],
  },
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      admin: { position: 'sidebar', description: 'The address: daly.id.au/blog/<slug>. Changing it keeps the old address redirecting.' },
    },
    { name: 'subtitle', type: 'text' },
    { name: 'summary', type: 'textarea', admin: { description: 'Shown in lists, feeds and search results. Left empty, the first words of the post are used.' } },
    { name: 'heroImage', type: 'upload', relationTo: 'media', admin: { description: 'The featured image (JPEG, PNG, GIF, WebP or AVIF, up to 15 MB).' } },
    { name: 'content', type: 'richText' },
    { name: 'publishedAt', type: 'date', admin: { position: 'sidebar', date: { pickerAppearance: 'dayAndTime' } } },
    { name: 'updatedDate', label: 'Updated', type: 'date', admin: { position: 'sidebar', description: 'Shown as "Updated" on the post, when set.' } },
    { name: 'category', type: 'text', admin: { position: 'sidebar' } },
    { name: 'tags', type: 'array', admin: { position: 'sidebar' }, fields: [{ name: 'tag', type: 'text', required: true }] },
    { name: 'featured', type: 'checkbox', admin: { position: 'sidebar' } },
    seoFields({ title: '"<title> — <site name>"', description: 'the summary', image: 'the featured image' }),
    {
      name: 'publicId',
      type: 'text',
      unique: true,
      index: true,
      // Set only by the server (assignPublicId, the import): never from a request, on create or update.
      access: SERVER_ONLY,
      admin: { position: 'sidebar', readOnly: true, description: "The post's id on the public site. Imported posts keep their original one." },
    },
    {
      name: 'legacy',
      type: 'group',
      admin: {
        description:
          'An imported post as it was published before Payload. While Content is empty, the site shows this HTML exactly as it was; writing Content replaces it.',
        condition: (data) => Boolean(data?.legacy?.bodyHtml),
      },
      // Only the import (overrideAccess) writes this. Its HTML is published as stored, without the escaping
      // the Lexical renderer applies, so no request may ever set it: not on create, not on update. The rule
      // is on every field inside as well as the group: Payload fills a refused group's fields from the
      // source document when duplicating, so the group's rule alone would let Duplicate copy the HTML.
      access: SERVER_ONLY,
      fields: [
        { name: 'source', type: 'text', access: SERVER_ONLY, admin: { readOnly: true } },
        { name: 'bodyHtml', type: 'textarea', access: SERVER_ONLY, admin: { readOnly: true } },
        { name: 'toc', type: 'json', access: SERVER_ONLY, admin: { readOnly: true } },
        { name: 'searchText', type: 'textarea', access: SERVER_ONLY, admin: { readOnly: true, hidden: true } },
        { name: 'wordCount', type: 'number', access: SERVER_ONLY, admin: { readOnly: true } },
        { name: 'readingMinutes', type: 'number', access: SERVER_ONLY, admin: { readOnly: true } },
        { name: 'imageKey', type: 'text', access: SERVER_ONLY, admin: { readOnly: true } },
        { name: 'imageAlt', type: 'text', access: SERVER_ONLY, admin: { readOnly: true } },
        { name: 'imageWidth', type: 'number', access: SERVER_ONLY, admin: { readOnly: true } },
        { name: 'imageHeight', type: 'number', access: SERVER_ONLY, admin: { readOnly: true } },
        { name: 'originalRow', type: 'json', access: SERVER_ONLY, admin: { readOnly: true, hidden: true, description: 'The posts row before import, for undoing it.' } },
      ],
    },
  ],
}
