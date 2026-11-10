// Links to the wedding screens in Payload's own navigation.
import Link from 'next/link'

const LINKS = [
  ['Wedding dashboard', '/admin/wedding'],
  ['Guests', '/admin/wedding/guests'],
  ['Households', '/admin/wedding/households'],
  ['RSVPs', '/admin/wedding/rsvps'],
  ['Seating', '/admin/wedding/seating'],
] as const

export function WeddingNav() {
  return (
    <nav aria-label="Wedding" style={{ marginTop: 'calc(var(--base) * 1.5)' }}>
      <p className="nav-group__label" style={{ fontWeight: 600 }}>Wedding</p>
      {LINKS.map(([label, href]) => (
        <Link className="nav__link" href={href} key={href} prefetch={false}>
          <span className="nav__link-label">{label}</span>
        </Link>
      ))}
    </nav>
  )
}
