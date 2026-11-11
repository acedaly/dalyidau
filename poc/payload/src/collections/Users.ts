import type { Access, CollectionConfig } from 'payload'

import { accessStrategy } from '../auth/access-strategy'

type PortalUserLike = { portalRole?: string; permissions?: string[] } | null | undefined

/** Owners and admins of the portal edit site content; nobody else. */
export const contentEditor = (user: PortalUserLike) => user?.portalRole === 'owner' || user?.portalRole === 'admin'
const ownersOnly: Access = ({ req }) => (req.user as PortalUserLike)?.portalRole === 'owner'

export const Users: CollectionConfig = {
  slug: 'users',
  // A mirror of who has signed in (roles come from Administration → Users and permissions), so it isn't
  // in the menu: one place to manage people.
  admin: { useAsTitle: 'email', hidden: true },
  auth: {
    // No Payload passwords, login form, API keys or reset emails: Cloudflare Access is the only way in.
    disableLocalStrategy: true,
    strategies: [accessStrategy],
  },
  access: {
    // Anyone the portal recognises may open the admin (wedding screens apply their own permissions).
    admin: ({ req }) => Boolean((req.user as PortalUserLike)?.permissions?.includes('wedding.view')),
    read: ownersOnly,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'email', type: 'email', required: true, unique: true, index: true },
    {
      name: 'portalRole',
      type: 'select',
      options: ['owner', 'admin', 'editor', 'viewer'],
      admin: { readOnly: true, description: 'Mirrored from the portal on each sign-in. Change roles in the portal.' },
    },
  ],
}
