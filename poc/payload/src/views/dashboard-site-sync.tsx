// "Website sync" on Payload's dashboard: does the public site show what's published here? (docs/AUDIT-2026-11.md, H3.)
// Checked live each time the dashboard opens (a few small database reads, src/site/sync.ts). When something is
// out of step it says what, and Republish puts it right. Shown to the people who edit the site.
import type { TypedUser } from 'payload'

import { inStep } from '../../../../worker/site/sync-check'
import { siteSyncReport } from '../site/sync'
import { RepublishButton } from './republish-button'

const KIND = { post: 'Blog post', page: 'Page', project: 'Project' } as const
const STATE = {
  missing: 'published here, but not on the website',
  stale: 'the website shows an older version',
  extra: 'on the website, but not published here',
} as const

export async function DashboardSiteSync({ user }: { user?: TypedUser | null }) {
  const role = (user as { portalRole?: string } | null | undefined)?.portalRole
  if (role !== 'owner' && role !== 'admin') return null
  const report = await siteSyncReport().catch(() => null)
  const ok = report ? inStep(report) : false
  return (
    <section aria-labelledby="daly-site-sync" className="daly-dashboard daly-sync" data-state={report ? (ok ? 'ok' : 'out') : 'unknown'}>
      <div className="daly-dashboard__head">
        <h2 className="collections__label" id="daly-site-sync">
          Website sync
        </h2>
      </div>
      {!report ? (
        <p className="daly-sync__line" role="status">
          Couldn’t check the website just now. Reload this page to try again.
        </p>
      ) : ok ? (
        <p className="daly-sync__line" role="status">
          <span aria-hidden="true" className="daly-sync__dot" /> The website matches what’s published here.
        </p>
      ) : (
        <div role="alert">
          <p className="daly-sync__line">
            <span aria-hidden="true" className="daly-sync__dot" /> The website doesn’t match what’s published here.
          </p>
          <ul className="daly-sync__list">
            {report.items.map((item) => (
              <li key={`${item.kind}:${item.siteId}`}>
                <strong>
                  {KIND[item.kind]}: {item.title || item.slug || item.siteId}
                </strong>{' '}
                — {STATE[item.state]}
              </li>
            ))}
            {report.projectListStale ? <li>The list of projects on the website is out of date.</li> : null}
          </ul>
          <RepublishButton />
        </div>
      )}
    </section>
  )
}
