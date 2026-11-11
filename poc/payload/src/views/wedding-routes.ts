// The screens offered inside Payload's admin: every wedding screen the portal served under /portal/wedding,
// at /admin/wedding/..., and the portal's settings and audit log, at /admin/administration/...
// (worker/portal/pages.ts loads them; platform/bridge.ts applies the same sign-in and permission checks).
// The old /portal pages redirect here (src/shared/portal/admin-paths.ts).
import {
  ADMINISTRATION_SCREEN,
  WEDDING_SCREEN,
  adminPathForPortal,
  administrationPath,
  portalPathForAdministration,
  weddingAdminPath,
} from '../../../../src/shared/portal/admin-paths'

export { ADMINISTRATION_SCREEN, WEDDING_SCREEN, administrationPath, portalPathForAdministration }

export const NAV: ReadonlyArray<readonly [label: string, screen: string]> = [
  ['Dashboard', ''],
  ['Guests', 'guests'],
  ['Households', 'households'],
  ['Events', 'events'],
  ['RSVPs', 'rsvps'],
  ['Invitations', 'invitations'],
  ['Communications', 'communications'],
  ['Seating', 'seating'],
  ['Catering', 'catering'],
  ['Tasks', 'tasks'],
  ['Timeline', 'timeline'],
  ['Budget', 'budget'],
  ['Suppliers', 'suppliers'],
  ['Website', 'website'],
  ['Settings', 'settings'],
]

/** The wedding menu's collapsible groups. Every NAV screen is in exactly one. */
export const NAV_GROUPS: ReadonlyArray<readonly [label: string, screens: readonly string[]]> = [
  ['Wedding', ['', 'guests', 'households', 'events', 'rsvps', 'invitations', 'communications', 'website', 'settings']],
  ['Wedding Planning', ['seating', 'catering', 'tasks', 'timeline', 'budget', 'suppliers']],
]

/** The Administration group (the former portal settings and audit log). */
export const ADMINISTRATION_NAV: ReadonlyArray<readonly [label: string, screen: string]> = [
  ['General', ''],
  ['Users and permissions', 'access'],
  ['Features', 'features'],
  ['Integrations and security', 'security'],
  ['Privacy', 'privacy'],
  ['Capacities archive', 'website'],
  ['Audit log', 'audit'],
]

export const adminPath = weddingAdminPath
export const portalPath = (screen: string) => (screen ? `/portal/wedding/${screen}` : '/portal/wedding')

/** The Payload address for a link inside a screen, or null to leave the link alone (the website preview, other sites). */
export const adminPathForPortalLink = (href: string): string | null => adminPathForPortal(href, { strict: true })
