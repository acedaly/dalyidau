import type { CollectionConfig } from 'payload'

import { contentEditor } from './Users'

/** What may be uploaded: the same five types the public site publishes. */
export const MEDIA_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'] as const
/** The public site's own limit (worker/lib/image.ts), enforced at upload too. */
export const MEDIA_MAX_BYTES = 15 * 1024 * 1024

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
    // Only the image types the public site can publish (worker/lib/image.ts). Payload goes by the type
    // it detects from the file's bytes, or failing that its extension, never the browser's label, so an
    // SVG, HTML or script file is refused at upload instead of sitting in the library. (A file that starts
    // like a real image is stored as that image; whatever is stored is served as a sandboxed, no-script
    // response, platform/compose.ts API_CSP.) The 15 MB limit is in payload.config.ts (upload.limits).
    mimeTypes: [...MEDIA_MIME_TYPES],
  },
}
