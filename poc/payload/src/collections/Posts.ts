import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, CollectionBeforeChangeHook, CollectionConfig } from 'payload'
import { APIError } from 'payload'

import {
  type PayloadPostInput,
  type PublisherEnv,
  PublishError,
  publishPayloadPost,
  unpublishPayloadPost,
} from '../../../../worker/blog/payload-publisher'
import { isValidSlug, slugify } from '../../../../worker/lib/html'
import { cloudflareEnv } from '../cloudflare-env'
import { contentEditor } from './Users'

// The blog's posts (docs/PAYLOAD-BLOG.md). Payload is where they're written and kept. The public
// site keeps rendering them from the `posts` table, which this collection's hooks keep in step with
// Payload's main (published) document: publishing writes the post there, unpublishing or deleting
// removes it. Saving a draft changes nothing public.

const publisherEnv = async (): Promise<PublisherEnv & { R2: R2Bucket }> => {
  const e = await cloudflareEnv<PublisherEnv & { R2: R2Bucket }>()
  return { DB: e.DB, MEDIA: e.MEDIA, SITE_URL: e.SITE_URL, R2: e.R2 }
}

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
    content: doc.content ?? null,
    legacy,
    heroMediaId: idOf(doc.heroImage),
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

/** A new post gets its public id once, at creation; it never changes. */
const assignPublicId: CollectionBeforeChangeHook = ({ data, operation }) => {
  if (operation === 'create' && !data.publicId) data.publicId = `payload:${crypto.randomUUID()}`
  return data
}

/** Refuses a publish that would fail anyway, before anything is saved. */
const validateBeforePublish: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
  if (data._status !== 'published') return data
  const slug = slugify(String(data.slug ?? originalDoc?.slug ?? data.title ?? ''))
  if (!slug || !isValidSlug(slug)) throw new APIError('Give the post a web address made of lower-case letters, numbers and hyphens.', 400, undefined, true)
  data.slug = slug
  if (!data.publishedAt && !originalDoc?.publishedAt) data.publishedAt = new Date().toISOString()
  const env = await publisherEnv()
  const publicId = String(data.publicId ?? originalDoc?.publicId ?? '')
  const clash = await env.DB.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?').bind(slug, publicId).first<{ id: string }>()
  if (clash) throw new APIError(`/blog/${slug} is already used by another post.`, 400, undefined, true)
  req.payload.logger.info({ msg: 'post publish validated', slug })
  return data
}

/** Makes the public site match Payload's main (published) document. */
const syncPublicPost: CollectionAfterChangeHook = async ({ doc, req, context }) => {
  if (context?.skipPublicSync) return doc
  // The main document, never a draft version: a draft save leaves it (and the public site) as it was.
  const main = (await req.payload.findByID({
    collection: 'posts',
    id: doc.id,
    draft: false,
    trash: true,
    depth: 0,
    overrideAccess: true,
    req,
  })) as PostDoc
  const env = await publisherEnv()
  const input = toPublisherInput(main)
  try {
    // In Trash (deleted, restorable) counts as unpublished.
    if (main._status === 'published' && !main.deletedAt) {
      const result = await publishPayloadPost(env, input, {
        loadMedia: async (id) => {
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
      req.payload.logger.info({ msg: 'blog post published', outcome: result.outcome, slug: result.slug })
    } else if (await unpublishPayloadPost(env, input.postId)) {
      req.payload.logger.info({ msg: 'blog post unpublished', postId: input.postId })
    }
  } catch (error) {
    if (error instanceof PublishError) throw new APIError(error.message, 400, undefined, true)
    throw error
  }
  return doc
}

const removePublicPost: CollectionAfterDeleteHook = async ({ doc, req, context }) => {
  if (context?.skipPublicSync) return
  const env = await publisherEnv()
  if (await unpublishPayloadPost(env, toPublisherInput(doc as PostDoc).postId)) req.payload.logger.info({ msg: 'blog post removed', id: doc.id })
}

export const Posts: CollectionConfig = {
  slug: 'posts',
  labels: { singular: 'Blog post', plural: 'Blog posts' },
  admin: {
    useAsTitle: 'title',
    group: 'Website',
    defaultColumns: ['title', 'slug', '_status', 'publishedAt'],
    description: 'Posts on daly.id.au/blog. Publishing puts a post on the site straight away; Unpublish takes it down.',
    preview: (doc) => (doc?.slug && doc?._status === 'published' ? `/blog/${doc.slug}` : null),
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
  hooks: {
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
    {
      name: 'publicId',
      type: 'text',
      unique: true,
      index: true,
      access: { update: () => false },
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
      access: { update: () => false },
      fields: [
        { name: 'source', type: 'text', admin: { readOnly: true } },
        { name: 'bodyHtml', type: 'textarea', admin: { readOnly: true } },
        { name: 'toc', type: 'json', admin: { readOnly: true } },
        { name: 'searchText', type: 'textarea', admin: { readOnly: true, hidden: true } },
        { name: 'wordCount', type: 'number', admin: { readOnly: true } },
        { name: 'readingMinutes', type: 'number', admin: { readOnly: true } },
        { name: 'imageKey', type: 'text', admin: { readOnly: true } },
        { name: 'imageAlt', type: 'text', admin: { readOnly: true } },
        { name: 'imageWidth', type: 'number', admin: { readOnly: true } },
        { name: 'imageHeight', type: 'number', admin: { readOnly: true } },
        { name: 'originalRow', type: 'json', admin: { readOnly: true, hidden: true, description: 'The posts row before import, for undoing it.' } },
      ],
    },
  ],
}
