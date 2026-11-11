import type { CollectionConfig } from 'payload'

import { contentEditor } from './Users'

/** Website pages managed in Payload (Phase 0: just enough to measure the bundle and prove access rules). */
export const Pages: CollectionConfig = {
  slug: 'pages',
  admin: { useAsTitle: 'title' },
  versions: { drafts: true },
  access: {
    read: ({ req }) => (contentEditor(req.user as never) ? true : { _status: { equals: 'published' } }),
    create: ({ req }) => contentEditor(req.user as never),
    update: ({ req }) => contentEditor(req.user as never),
    delete: ({ req }) => contentEditor(req.user as never),
  },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true, unique: true, index: true },
    { name: 'content', type: 'richText' },
  ],
}
