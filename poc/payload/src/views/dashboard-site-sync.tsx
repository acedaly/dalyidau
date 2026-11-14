// "Website sync" on Payload's dashboard: does the public site show what's published here? (docs/AUDIT-2026-11.md, H3.)
// Checked live each time the dashboard opens (a few small database reads, src/site/sync.ts). When something is
// out of step it says what, and Republish puts it right. Shown to the people who edit the site.
import type { TypedUser } from 'payload'

import { discrepancies, inStep } from '../../../../worker/site/sync-check'
import { siteSyncReport, siteSyncStatus } from '../site/sync'
import { RemoveOrphanButton } from './remove-orphan-button'
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
  const [report, status] = await Promise.all([siteSyncReport().catch(() => null), siteSyncStatus().catch(() => null)])
  const ok = report ? inStep(report) : false
  const count = report ? discrepancies(report) : null
  // A save the website missed since the last repair may have left the menu or settings behind, which the
  // comparison doesn't cover item by item: Republish rebuilds them, so it's offered then too.
  const missedSince = status?.lastPublishFailure && !(Date.parse(status.lastRepair?.at ?? '') >= Date.parse(status.lastPublishFailure.at))
  const when = (iso: string | null | undefined) =>
    iso ? new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Sydney' }).format(new Date(iso)) : null
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
        <>
          <p className="daly-sync__line" role="status">
            <span aria-hidden="true" className="daly-sync__dot" /> The website matches what’s published here.
          </p>
          {missedSince ? (
            <>
              <p className="daly-sync__line">A recent save didn’t reach the website. If the menu or site settings look out of date, Republish rebuilds them.</p>
              <RepublishButton />
            </>
          ) : null}
        </>
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
                — {item.id === null ? 'on the website, but there’s no document for it here. Republish leaves it alone, because the website’s copy may be the only one' : STATE[item.state]}
                {item.id === null && role === 'owner' ? <RemoveOrphanButton kind={item.kind} siteId={item.siteId} title={item.title || item.slug || item.siteId} /> : null}
                {item.id === null && role !== 'owner' ? ' An owner can remove it from the website.' : null}
              </li>
            ))}
            {report.projectListStale ? <li>The list of projects on the website is out of date.</li> : null}
          </ul>
          {report.projectListStale || missedSince || report.items.some((item) => item.id !== null) ? <RepublishButton /> : null}
        </div>
      )}
      <dl className="daly-sync__facts">
        <div>
          <dt>Out of step now</dt>
          <dd>{count === null ? 'Unknown' : count === 0 ? 'Nothing' : `${count} ${count === 1 ? 'item' : 'items'}`}</dd>
        </div>
        <div>
          <dt>Last automatic check</dt>
          <dd>
            {status?.lastSuccessAt
              ? `${when(status.lastSuccessAt)}: ${status.outstanding ? `${status.outstanding} out of step` : 'all in step'}`
              : 'Not run yet (it runs every 15 minutes)'}
          </dd>
        </div>
        <div>
          <dt>Last check that failed</dt>
          <dd>{status?.lastFailureAt ? `${when(status.lastFailureAt)}: ${status.lastFailureMessage ?? 'no details'}` : 'None'}</dd>
        </div>
        <div>
          <dt>Last save the website missed</dt>
          <dd>{status?.lastPublishFailure ? `${when(status.lastPublishFailure.at)}: ${status.lastPublishFailure.what}` : 'None'}</dd>
        </div>
        <div>
          <dt>Last Republish</dt>
          <dd>
            {status?.lastRepair
              ? `${when(status.lastRepair.at)}${status.lastRepair.by ? ` by ${status.lastRepair.by}` : ''}: ${status.lastRepair.fixed} fixed, ${status.lastRepair.failed} failed, ${status.lastRepair.leftAlone} left alone`
              : 'Never'}
          </dd>
        </div>
      </dl>
    </section>
  )
}
