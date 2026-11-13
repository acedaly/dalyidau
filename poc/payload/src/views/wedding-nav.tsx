// Links to the wedding and administration screens in Payload's own navigation, in collapsible groups.
// NavGroup is the component Payload uses for "Collections": a click on the label opens or closes the group,
// and each person's choice is remembered in their Payload preferences. The wedding groups come first
// (beforeNavLinks), as they're used most; Administration comes last (afterNavLinks).
import { NavGroup } from '@payloadcms/ui'
import Link from 'next/link'

import { ADMINISTRATION_NAV, NAV, NAV_GROUPS, PLANNER_APP_PATH, adminPath, administrationPath } from './wedding-routes'

const LABELS = new Map(NAV.map(([label, screen]) => [screen, label]))

export function WeddingNav() {
  return (
    <div aria-label="Wedding" className="daly-nav" role="navigation">
      {NAV_GROUPS.map(([group, screens], index) => (
        <NavGroup key={group} label={group}>
          {screens.map((screen) => (
            <Link className="nav__link" href={adminPath(screen)} key={screen} prefetch={false}>
              <span className="nav__link-label">{LABELS.get(screen)}</span>
            </Link>
          ))}
          {index === 0 && (
            // The phone app is its own page outside Payload (worker/planner), so a plain link.
            <a className="nav__link" href={PLANNER_APP_PATH}>
              <span className="nav__link-label">Phone app ↗</span>
            </a>
          )}
        </NavGroup>
      ))}
    </div>
  )
}

export function AdministrationNav() {
  return (
    <div aria-label="Administration" className="daly-nav" role="navigation">
      <NavGroup label="Administration">
        {ADMINISTRATION_NAV.map(([label, screen]) => (
          <Link className="nav__link" href={administrationPath(screen)} key={screen} prefetch={false}>
            <span className="nav__link-label">{label}</span>
          </Link>
        ))}
      </NavGroup>
    </div>
  )
}
