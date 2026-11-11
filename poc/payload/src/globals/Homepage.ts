import type { GlobalConfig } from 'payload'

import { DEFAULT_HOME } from '../../../../src/shared/site-content'
import { homeSnapshot } from '../../../../worker/site/publisher'
import { contentEditor } from '../collections/Users'
import { asEditorError, homeInput, republishHome } from '../site/publishing'

// The homepage's words. "Save draft" keeps changes here; "Publish changes" puts them on the site.
export const Homepage: GlobalConfig = {
  slug: 'homepage',
  label: 'Homepage',
  admin: {
    group: 'Website',
    description: 'The words on daly.id.au. The latest posts are added automatically from the blog. Publish changes to update the site.',
    preview: () => '/',
  },
  versions: { drafts: true, max: 50 },
  access: {
    read: ({ req }) => contentEditor(req.user as never),
    update: ({ req }) => contentEditor(req.user as never),
    readVersions: ({ req }) => contentEditor(req.user as never),
  },
  hooks: {
    beforeChange: [
      async ({ data }) => {
        if (data._status === 'published') await asEditorError(async () => homeSnapshot(homeInput(data)))
        return data
      },
    ],
    afterChange: [
      async ({ doc, req, context }) => {
        if (!context?.skipPublicSync && doc._status === 'published') await republishHome(req, doc)
        return doc
      },
    ],
  },
  fields: [
    {
      type: 'collapsible',
      label: 'Introduction',
      fields: [
        { name: 'eyebrow', label: 'Small heading', type: 'text', required: true, defaultValue: DEFAULT_HOME.eyebrow },
        {
          type: 'row',
          fields: [
            { name: 'heading', type: 'text', required: true, defaultValue: DEFAULT_HOME.heading, admin: { width: '60%' } },
            { name: 'headingEmphasis', label: 'Heading ending (in italics)', type: 'text', defaultValue: DEFAULT_HOME.headingEmphasis, admin: { width: '40%' } },
          ],
        },
        { name: 'intro', label: 'Introduction', type: 'textarea', required: true, defaultValue: DEFAULT_HOME.intro },
        {
          type: 'row',
          fields: [
            { name: 'ctaLabel', label: 'Link text', type: 'text', required: true, defaultValue: DEFAULT_HOME.ctaLabel, admin: { width: '50%' } },
            { name: 'ctaHref', label: 'Link address', type: 'text', required: true, defaultValue: DEFAULT_HOME.ctaHref, admin: { width: '50%' } },
          ],
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'Latest posts',
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'latestEyebrow', label: 'Small heading', type: 'text', required: true, defaultValue: DEFAULT_HOME.latestEyebrow, admin: { width: '35%' } },
            { name: 'latestHeading', label: 'Heading', type: 'text', required: true, defaultValue: DEFAULT_HOME.latestHeading, admin: { width: '40%' } },
            { name: 'latestCount', label: 'How many posts', type: 'number', required: true, min: 0, max: 12, defaultValue: DEFAULT_HOME.latestCount, admin: { width: '25%', step: 1 } },
          ],
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'About this place',
      fields: [
        { name: 'aboutHeading', label: 'Heading', type: 'text', required: true, defaultValue: DEFAULT_HOME.aboutHeading },
        {
          name: 'aboutParagraphs',
          label: 'Paragraphs',
          type: 'array',
          maxRows: 10,
          defaultValue: DEFAULT_HOME.aboutParagraphs.map((text) => ({ text })),
          fields: [{ name: 'text', type: 'textarea', required: true }],
        },
        { name: 'showContactLine', label: 'End with "Have a thought to share? Say hello" (when there is a public email)', type: 'checkbox', defaultValue: true },
      ],
    },
    {
      type: 'collapsible',
      label: 'Search and link previews',
      admin: { initCollapsed: true },
      fields: [
        { name: 'seoTitle', label: 'Title', type: 'text', admin: { description: 'Leave empty to use the homepage title from Site settings.' } },
        { name: 'seoDescription', label: 'Description', type: 'textarea', admin: { description: 'Leave empty to use the site description.' } },
      ],
    },
  ],
}
