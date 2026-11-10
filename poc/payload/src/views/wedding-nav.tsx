// Links to the wedding screens in Payload's own navigation.
import Link from 'next/link'

import { NAV, adminPath } from './wedding-routes'

export function WeddingNav() {
  return (
    <nav aria-label="Wedding" style={{ marginTop: 'calc(var(--base) * 1.5)' }}>
      <p className="nav-group__label" style={{ fontWeight: 600 }}>Wedding</p>
      {NAV.map(([label, screen]) => (
        <Link className="nav__link" href={adminPath(screen)} key={screen} prefetch={false}>
          <span className="nav__link-label">{label}</span>
        </Link>
      ))}
    </nav>
  )
}
