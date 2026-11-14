import type { Field } from 'payload'

import { SEO_LIMITS } from '../../../../src/shared/site-content'
import type { SeoInput } from '../../../../worker/blog/payload-publisher'

// "Search and link previews": one set of fields for posts, pages and projects. Everything is optional and
// has a sensible default from the content itself, so an article never needs any of it filled in
// (worker/seo.ts builds the page's head; worker/blog/payload-publisher.ts resolveSeo validates on publish).

/** `fallback` says, in the editor's words, what each empty field uses instead. */
export const seoFields = (fallback: { title: string; description: string; image: string }): Field => ({
  name: 'seo',
  label: 'Search and link previews',
  type: 'group',
  admin: {
    description: 'All optional. Left empty, search engines and link previews use the title, summary and image above.',
  },
  fields: [
    { name: 'title', label: 'Search title', type: 'text', maxLength: SEO_LIMITS.title, admin: { description: `The page title in search results and the browser tab. Leave empty to use ${fallback.title}. About 60 characters shows in full.` } },
    { name: 'description', label: 'Search description', type: 'textarea', maxLength: SEO_LIMITS.description, admin: { description: `The line under the title in search results. Leave empty to use ${fallback.description}. About 155 characters shows in full.` } },
    {
      type: 'collapsible',
      label: 'Sharing (links pasted into messages and social media)',
      admin: { initCollapsed: true },
      fields: [
        { name: 'socialTitle', label: 'Sharing title', type: 'text', maxLength: SEO_LIMITS.title, admin: { description: 'Leave empty to use the search title.' } },
        { name: 'socialDescription', label: 'Sharing description', type: 'textarea', maxLength: SEO_LIMITS.description, admin: { description: 'Leave empty to use the search description.' } },
        { name: 'image', label: 'Sharing image', type: 'upload', relationTo: 'media', admin: { description: `1200 × 630 pixels looks best. Leave empty to use ${fallback.image}.` } },
      ],
    },
    {
      type: 'collapsible',
      label: 'Advanced',
      admin: { initCollapsed: true },
      fields: [
        {
          name: 'canonical',
          label: 'Canonical address',
          type: 'text',
          admin: { placeholder: 'https://… or /a-path-on-this-site', description: 'Only when this was first published somewhere else, or duplicates another page here: the address search engines should treat as the original. Leave empty otherwise.' },
        },
        { name: 'noindex', label: 'Hide from search engines', type: 'checkbox', defaultValue: false, admin: { description: 'The page stays public for anyone with the link, but search engines are asked not to list it and it is left out of the sitemap.' } },
      ],
    },
  ],
})

type SeoDoc = {
  title?: string | null
  description?: string | null
  socialTitle?: string | null
  socialDescription?: string | null
  image?: unknown
  canonical?: string | null
  noindex?: boolean | null
} | null

const idOf = (value: unknown): string | number | null =>
  value && typeof value === 'object' ? ((value as { id?: string | number }).id ?? null) : ((value as string | number | null | undefined) ?? null)

/** The group as the publishers take it. */
export const seoInput = (seo: SeoDoc | undefined): SeoInput | null =>
  seo
    ? {
        title: seo.title,
        description: seo.description,
        socialTitle: seo.socialTitle,
        socialDescription: seo.socialDescription,
        imageMediaId: idOf(seo.image),
        canonical: seo.canonical,
        noindex: seo.noindex,
      }
    : null
