import type { GlobalConfig } from 'payload'

import { contentEditor } from '../collections/Users'
import { republishSettings } from '../site/publishing'

// The site's menu (header and footer). Saving updates the site straight away.
export const Navigation: GlobalConfig = {
  slug: 'navigation',
  label: 'Navigation',
  admin: {
    group: 'Website',
    description:
      'The menu in the header and footer, in this order (drag to reorder). A link to a page appears only while that page is published. The Wedding link is added automatically while the wedding website is public.',
  },
  access: {
    read: ({ req }) => contentEditor(req.user as never),
    update: ({ req }) => contentEditor(req.user as never),
  },
  hooks: {
    afterChange: [async ({ doc, req, context }) => (context?.skipPublicSync ? doc : (await republishSettings(req, { navigation: doc }), doc))],
  },
  fields: [
    {
      name: 'items',
      label: 'Menu items',
      type: 'array',
      maxRows: 12,
      admin: { initCollapsed: false, components: { RowLabel: '/site/nav-row-label#NavRowLabel' } },
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'label', type: 'text', required: true, admin: { width: '40%' } },
            {
              name: 'type',
              label: 'Links to',
              type: 'radio',
              required: true,
              defaultValue: 'page',
              options: [
                { label: 'A page', value: 'page' },
                { label: 'An address', value: 'url' },
              ],
              admin: { width: '60%', layout: 'horizontal' },
            },
          ],
        },
        { name: 'page', type: 'relationship', relationTo: 'pages', required: true, admin: { condition: (_, sibling) => sibling?.type === 'page' } },
        {
          name: 'url',
          label: 'Address',
          type: 'text',
          required: true,
          admin: {
            condition: (_, sibling) => sibling?.type === 'url',
            placeholder: '/blog or https://…',
            description: 'A path on this site (/, /blog, /contact) or a full https:// address.',
          },
        },
      ],
    },
  ],
}
