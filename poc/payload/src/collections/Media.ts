import type { CollectionConfig } from 'payload'

import { contentEditor } from './Users'

export const Media: CollectionConfig = {
  slug: 'media',
  admin: { group: 'Blog and Media', description: 'Images for pages, blog posts and site settings. Only what a published page uses is copied to the public site.' },
  access: {
    read: () => true,
    // Payload's default is "any signed-in user", which here would include a portal viewer.
    create: ({ req }) => contentEditor(req.user as never),
    update: ({ req }) => contentEditor(req.user as never),
    delete: ({ req }) => contentEditor(req.user as never),
  },
  fields: [
    {
      name: 'alt',
      type: 'text',
      required: true,
    },
  ],
  upload: {
    // These are not supported on Workers yet due to lack of sharp
    crop: false,
    focalPoint: false,
  },
}
