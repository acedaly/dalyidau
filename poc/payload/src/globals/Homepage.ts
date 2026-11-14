import type { GlobalConfig } from 'payload'

import { DEFAULT_HOME, DEFAULT_PROJECTS_HOME } from '../../../../src/shared/site-content'
import { homeSnapshot, projectsHomeSnapshot } from '../../../../worker/site/publisher'
import { contentEditor } from '../collections/Users'
import { asEditorError, homeInput, republishHome, republishProjectsHome } from '../site/publishing'
import { isRestore, resaveRestored } from '../site/restore'

// The homepage's words. "Save draft" keeps changes here; "Publish changes" puts them on the site.
export const Homepage: GlobalConfig = {
  slug: 'homepage',
  label: 'Homepage',
  admin: {
    group: 'Website',
    description:
      'The words on daly.id.au. "Projects homepage" is the redesigned, projects-first homepage: it shows once switched on in Administration → Features (preview it at /portal/preview). Publish changes to update the site.',
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
        if (data._status === 'published') {
          await asEditorError(async () => homeSnapshot(homeInput(data)))
          await asEditorError(async () => projectsHomeSnapshot({ ...DEFAULT_PROJECTS_HOME, ...((data.projectsHome ?? {}) as object) }))
        }
        return data
      },
    ],
    afterChange: [
      async ({ doc, req, context }) => {
        // A restore hands over a version row, not the homepage: it is saved again as itself (src/site/restore.ts).
        // Before this, restoring a published version changed Payload and left the site as it was.
        if (!context?.skipPublicSync && isRestore(req)) {
          await resaveRestored(req, 'homepage')
          return doc
        }
        if (!context?.skipPublicSync && doc._status === 'published') {
          await republishHome(req, doc)
          await republishProjectsHome(req, { projectsHome: { ...DEFAULT_PROJECTS_HOME, ...((doc.projectsHome ?? {}) as object) } })
        }
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
      name: 'projectsHome',
      label: 'Projects homepage',
      type: 'group',
      admin: { description: 'The projects-first homepage. Its projects come from Projects (featured first, then by display order) and its articles from the blog.' },
      fields: [
        { name: 'heroTitle', label: 'Hero title', type: 'text', required: true, defaultValue: DEFAULT_PROJECTS_HOME.heroTitle },
        { name: 'heroIntro', label: 'Hero introduction', type: 'textarea', required: true, defaultValue: DEFAULT_PROJECTS_HOME.heroIntro },
        { name: 'heroCtaLabel', label: 'Hero button text', type: 'text', required: true, defaultValue: DEFAULT_PROJECTS_HOME.heroCtaLabel, admin: { description: 'The button goes to /projects.' } },
        {
          type: 'row',
          fields: [
            { name: 'projectsHeading', label: 'Projects heading', type: 'text', required: true, defaultValue: DEFAULT_PROJECTS_HOME.projectsHeading, admin: { width: '40%' } },
            { name: 'projectsIntro', label: 'Projects introduction', type: 'text', defaultValue: DEFAULT_PROJECTS_HOME.projectsIntro, admin: { width: '60%', description: 'Also the introduction on /projects.' } },
          ],
        },
        { name: 'showMoreProjects', label: 'Show the "All projects" links', type: 'checkbox', defaultValue: true },
        {
          type: 'row',
          fields: [
            { name: 'showWriting', label: 'Show latest writing', type: 'checkbox', defaultValue: true, admin: { width: '30%' } },
            { name: 'writingHeading', label: 'Writing heading', type: 'text', required: true, defaultValue: DEFAULT_PROJECTS_HOME.writingHeading, admin: { width: '45%' } },
            { name: 'writingCount', label: 'How many articles', type: 'number', required: true, min: 0, max: 6, defaultValue: DEFAULT_PROJECTS_HOME.writingCount, admin: { width: '25%', step: 1 } },
          ],
        },
        {
          type: 'row',
          fields: [
            { name: 'showAbout', label: 'Show the About section', type: 'checkbox', defaultValue: true, admin: { width: '30%' } },
            { name: 'aboutHeading', label: 'About heading', type: 'text', required: true, defaultValue: DEFAULT_PROJECTS_HOME.aboutHeading, admin: { width: '70%' } },
          ],
        },
        { name: 'aboutText', label: 'About text', type: 'textarea', required: true, defaultValue: DEFAULT_PROJECTS_HOME.aboutText },
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
