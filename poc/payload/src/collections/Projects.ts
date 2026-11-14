import type { CollectionConfig } from 'payload'
import { APIError } from 'payload'

import { PROJECT_STATUSES } from '../../../../src/shared/site-content'
import { slugify } from '../../../../worker/lib/html'
import { projectProblem } from '../../../../worker/site/publisher'
import { checkProject, projectPreview, syncProject, statusAfter, willBePublic } from '../site/publishing'
import { contentEditor } from './Users'

// Projects on daly.id.au/projects (Phase 4). Publishing puts a project on the site straight away (while
// "Show on the public site" is ticked); Unpublish, unticking it, or Trash take it down. Featured projects
// lead the homepage; Display order decides the rest (lower first). Images come from Media (one library).
export const Projects: CollectionConfig = {
  slug: 'projects',
  labels: { singular: 'Project', plural: 'Projects' },
  admin: {
    useAsTitle: 'title',
    group: 'Website',
    defaultColumns: ['title', 'status', 'featured', 'order', '_status', 'updatedAt'],
    description:
      'Projects at daly.id.au/projects. Featured projects lead the homepage; Display order sorts the rest (lower first). Nothing is public until you publish, and only while "Show on the public site" is ticked.',
    // The latest saved version, draft or not, as it will look on the site (src/site/publishing.ts previewEndpoint).
    preview: (doc) => (doc?.id ? `/api/projects/${doc.id}/preview` : null),
  },
  versions: { drafts: true, maxPerDoc: 50 },
  trash: true,
  defaultSort: 'order',
  access: {
    read: ({ req }) => contentEditor(req.user as never),
    create: ({ req }) => contentEditor(req.user as never),
    update: ({ req }) => contentEditor(req.user as never),
    delete: ({ req }) => (req.user as { portalRole?: string } | null)?.portalRole === 'owner',
    readVersions: ({ req }) => contentEditor(req.user as never),
  },
  endpoints: [projectPreview],
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, req }) => {
        const slug = slugify(String(data.slug ?? originalDoc?.slug ?? data.title ?? ''))
        if (slug) data.slug = slug
        if (slug) {
          const others = await req.payload.find({
            collection: 'projects',
            where: { slug: { equals: slug }, ...(originalDoc?.id !== undefined ? { id: { not_equals: originalDoc.id } } : {}) },
            trash: true,
            limit: 1,
            depth: 0,
            overrideAccess: true,
            req,
          })
          if (others.totalDocs) throw new APIError(`daly.id.au/projects/${slug} is already used by another project.`, 400, undefined, true)
        }
        // What the document will be after this save (a change that doesn't mention the status keeps it).
        if (statusAfter(data, originalDoc) !== 'published') return data
        const merged = { ...originalDoc, ...data }
        const problem = projectProblem({
          slug,
          title: String(merged.title ?? ''),
          status: merged.status,
          websiteUrl: merged.websiteUrl,
          githubUrl: merged.githubUrl,
          links: merged.links,
        })
        if (problem) throw new APIError(problem, 400, undefined, true)
        // Then everything else a publish checks (the address, the cover and screenshots), still before saving.
        if (willBePublic(data, originalDoc) && merged.listed !== false) await checkProject(req, { ...merged, slug, id: originalDoc?.id ?? 'new' })
        return data
      },
    ],
    afterChange: [async ({ doc, req, context }) => (context?.skipPublicSync ? doc : (await syncProject(req, doc.id), doc))],
    afterDelete: [async ({ doc, req, context }) => void (context?.skipPublicSync ? null : await syncProject(req, doc.id, true))],
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
      admin: { position: 'sidebar', description: 'daly.id.au/projects/<address>. Changing it keeps the old address redirecting.' },
    },
    { name: 'summary', type: 'textarea', required: true, maxLength: 600, admin: { description: 'One or two sentences, shown on cards and in search results.' } },
    { name: 'heroImage', label: 'Cover image', type: 'upload', relationTo: 'media', admin: { description: 'A screenshot or picture of the project (16:10 looks best). Without one, the card shows a quiet panel with its initials.' } },
    { name: 'content', label: 'Description', type: 'richText' },
    {
      name: 'gallery',
      label: 'Screenshots',
      type: 'array',
      maxRows: 24,
      fields: [
        { name: 'image', type: 'upload', relationTo: 'media', required: true },
        { name: 'caption', type: 'text' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'websiteUrl', label: 'Website', type: 'text', admin: { width: '50%', placeholder: 'https://' } },
        { name: 'githubUrl', label: 'GitHub', type: 'text', admin: { width: '50%', placeholder: 'https://github.com/…' } },
      ],
    },
    {
      name: 'links',
      label: 'More links',
      type: 'array',
      maxRows: 8,
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'label', type: 'text', required: true, admin: { width: '40%' } },
            { name: 'url', label: 'Address', type: 'text', required: true, admin: { width: '60%', placeholder: 'https://' } },
          ],
        },
      ],
    },
    {
      name: 'seo',
      label: 'Search and link previews',
      type: 'group',
      fields: [
        { name: 'title', type: 'text', admin: { description: 'Leave empty to use "<title> — <site name>".' } },
        { name: 'description', type: 'textarea', admin: { description: 'Leave empty to use the summary.' } },
      ],
    },
    { name: 'status', type: 'select', required: true, defaultValue: 'active', options: PROJECT_STATUSES, admin: { position: 'sidebar' } },
    { name: 'listed', label: 'Show on the public site', type: 'checkbox', defaultValue: true, admin: { position: 'sidebar', description: 'Untick to keep a published (or archived) project in the CMS but off the site.' } },
    { name: 'featured', type: 'checkbox', defaultValue: false, admin: { position: 'sidebar', description: 'Featured projects lead the homepage.' } },
    { name: 'order', label: 'Display order', type: 'number', defaultValue: 100, admin: { position: 'sidebar', step: 1, description: 'Lower comes first.' } },
    { name: 'tags', label: 'Technologies and topics', type: 'array', maxRows: 12, admin: { position: 'sidebar' }, fields: [{ name: 'tag', type: 'text', required: true }] },
  ],
}
