// The wedding screens offered inside Payload's admin: every screen the portal serves under /portal/wedding
// (worker/portal/pages.ts), at the same path under /admin/wedding. The portal's own loader and permission
// checks still decide what each person may see (platform/bridge.ts); this list only decides what's routed.

/** A path below /admin/wedding (without the leading slash): '' is the wedding dashboard. */
export const WEDDING_SCREEN =
  /^(?:|guests(?:\/import)?|households|events|rsvps|invitations|communications(?:\/providers|\/texts|\/msg_[a-z0-9]+)?|tasks|timeline|seating|catering|budget|suppliers|website|settings(?:\/general|\/fields)?)$/

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

/** The menu's collapsible groups (as the portal's sidebar sections). Every NAV screen is in exactly one. */
export const NAV_GROUPS: ReadonlyArray<readonly [label: string, screens: readonly string[]]> = [
  ['Wedding', ['', 'guests', 'households', 'events', 'rsvps', 'invitations', 'communications', 'website', 'settings']],
  ['Planning', ['seating', 'catering', 'tasks', 'timeline', 'budget', 'suppliers']],
]

export const adminPath = (screen: string) => (screen ? `/admin/wedding/${screen}` : '/admin/wedding')
export const portalPath = (screen: string) => (screen ? `/portal/wedding/${screen}` : '/portal/wedding')

/** The Payload view for a portal wedding link, or null if it isn't one (other apps keep their portal links). */
export function adminPathForPortalLink(href: string): string | null {
  const m = /^\/portal\/wedding(?:\/([^?#]*))?([?#].*)?$/.exec(href)
  if (!m) return null
  const screen = (m[1] ?? '').replace(/\/$/, '')
  // The query and fragment are kept: screens read them in the browser (e.g. ?new=1 opens "Add guest").
  return WEDDING_SCREEN.test(screen) ? adminPath(screen) + (m[2] ?? '') : null
}
