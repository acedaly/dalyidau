import type { GlobalConfig } from 'payload'

import { DEFAULT_SITE, SOCIAL_KINDS } from '../../../../src/shared/site-content'
import { settingsSnapshot } from '../../../../worker/site/publisher'
import { contentEditor } from '../collections/Users'
import { asEditorError, republishSettings, settingsInput } from '../site/publishing'

// Site-wide settings for daly.id.au. Saving publishes them straight away (with the menu).
export const SiteSettings: GlobalConfig = {
  slug: 'site-settings',
  label: 'Site settings',
  admin: {
    group: 'Website',
    description: 'Names, descriptions, contact details and social links used across daly.id.au. Saving updates the site straight away.',
  },
  access: {
    read: ({ req }) => contentEditor(req.user as never),
    update: ({ req }) => contentEditor(req.user as never),
  },
  hooks: {
    // Checked before saving, so a mistake is shown and nothing is stored.
    beforeChange: [async ({ data }) => (await asEditorError(async () => settingsSnapshot(settingsInput(data as never), [])), data)],
    afterChange: [async ({ doc, req, context }) => (context?.skipPublicSync ? doc : (await republishSettings(req, { settings: doc }), doc))],
  },
  fields: [
    {
      type: 'row',
      fields: [
        { name: 'name', label: 'Site name', type: 'text', required: true, defaultValue: DEFAULT_SITE.name, admin: { width: '60%' } },
        { name: 'shortName', label: 'Logo initials', type: 'text', required: true, maxLength: 4, defaultValue: DEFAULT_SITE.shortName, admin: { width: '40%' } },
      ],
    },
    { name: 'title', label: 'Homepage title', type: 'text', required: true, defaultValue: DEFAULT_SITE.title, admin: { description: "The browser tab and search result title of the homepage." } },
    { name: 'description', label: 'Site description', type: 'textarea', required: true, defaultValue: DEFAULT_SITE.description, admin: { description: 'Used by search engines and link previews when a page has no description of its own.' } },
    {
      type: 'row',
      fields: [
        { name: 'blogTitle', label: 'Blog title', type: 'text', required: true, defaultValue: DEFAULT_SITE.blogTitle, admin: { width: '40%' } },
        { name: 'blogDescription', label: 'Blog description', type: 'textarea', required: true, defaultValue: DEFAULT_SITE.blogDescription, admin: { width: '60%' } },
      ],
    },
    { name: 'email', label: 'Public email', type: 'email', defaultValue: DEFAULT_SITE.email ?? undefined, admin: { description: 'Shown in the menu, on the homepage and the contact page. Leave empty to hide it everywhere.' } },
    {
      name: 'socials',
      label: 'Social links',
      type: 'array',
      admin: { description: 'Shown as icons in the footer and as cards on the contact page.' },
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'kind', type: 'select', required: true, options: SOCIAL_KINDS.map((k) => ({ label: k === 'x' ? 'X' : k[0].toUpperCase() + k.slice(1), value: k })), admin: { width: '25%' } },
            { name: 'label', type: 'text', required: true, admin: { width: '25%' } },
            { name: 'url', label: 'Address', type: 'text', required: true, admin: { width: '50%', placeholder: 'https://' } },
          ],
        },
      ],
    },
    {
      name: 'contact',
      label: 'Contact page',
      type: 'group',
      fields: [
        { name: 'eyebrow', label: 'Label above the heading', type: 'text', required: true, defaultValue: DEFAULT_SITE.contact.eyebrow },
        { name: 'heading', type: 'text', required: true, defaultValue: DEFAULT_SITE.contact.heading },
        { name: 'intro', label: 'Introduction', type: 'textarea', required: true, defaultValue: DEFAULT_SITE.contact.intro },
        { name: 'emailDescription', label: 'Email card text', type: 'textarea', required: true, defaultValue: DEFAULT_SITE.contact.emailDescription },
      ],
    },
    {
      name: 'seoImage',
      label: 'Default social preview image',
      type: 'upload',
      relationTo: 'media',
      admin: { description: 'Used in link previews for pages without their own image. Leave empty for the built-in one. Best at 1200 × 630.' },
    },
    { name: 'footerText', label: 'Footer text', type: 'text', admin: { description: 'After "© year" in the footer. Leave empty to use the site name.' } },
  ],
}
