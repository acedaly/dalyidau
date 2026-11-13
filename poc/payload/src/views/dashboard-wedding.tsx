// The top of Payload's dashboard (/admin): the wedding, which is what the admin is used for most, as cards
// with a line on what each one is for, and the phone app. Payload's own collection cards follow below.
// Shown only to people whose portal role includes the wedding (the same check as wedding-view.tsx).
import type { TypedUser } from 'payload'
import Link from 'next/link'

import { PLANNER_APP_PATH, adminPath } from './wedding-routes'

const CARDS: ReadonlyArray<readonly [title: string, screen: string, description: string]> = [
  ['Wedding dashboard', '', 'Countdown, RSVPs, follow-ups and what needs doing next.'],
  ['Guests', 'guests', 'Everyone invited, their households and contact details.'],
  ['RSVPs', 'rsvps', 'Who is coming to each event, and who hasn’t replied.'],
  ['Tasks', 'tasks', 'The planning to-do list, with due dates.'],
  ['Budget', 'budget', 'Costs, deposits and what’s been paid.'],
  ['Seating', 'seating', 'Tables and who sits where.'],
  ['Communications', 'communications', 'Emails and texts to guests.'],
  ['Wedding website', 'website', 'What guests see at wedding.daly.id.au.'],
]

export function DashboardWedding({ user }: { user?: TypedUser | null }) {
  const permissions = (user as { permissions?: string[] } | null | undefined)?.permissions ?? []
  if (!permissions.includes('wedding.view')) return null
  return (
    <section aria-labelledby="daly-dashboard-wedding" className="daly-dashboard">
      <div className="daly-dashboard__head">
        <h2 className="collections__label" id="daly-dashboard-wedding">
          Wedding
        </h2>
        <a className="daly-dashboard__app" href={PLANNER_APP_PATH}>
          Open the phone app ↗
        </a>
      </div>
      <ul className="daly-dashboard__cards">
        {CARDS.map(([title, screen, description]) => (
          <li key={screen || 'home'}>
            <Link className="daly-card" href={adminPath(screen)} prefetch={false}>
              <span className="daly-card__title">{title}</span>
              <span className="daly-card__text">{description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
