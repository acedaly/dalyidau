import type { PayloadRequest } from 'payload'

import { republishProjectList } from '../../../../worker/site/publisher'
import { type DriftItem, type DriftReport, type SyncStatus, adoptEarlierPosts, inStep, noteSyncStatus, readSyncStatus, recordSiteDrift, siteDrift } from '../../../../worker/site/sync-check'
import { cloudflareEnv } from '../cloudflare-env'
import { syncPost } from '../collections/Posts'
import { removeOrphan } from '../../../../worker/site/orphans'
import { publisherEnv, republishSettings, syncPage, syncProject } from './publishing'

// "Website sync" (docs/AUDIT-2026-11.md, H3): whether the public site shows what Payload says is published,
// and the Republish action that makes it so. The comparison itself is worker/site/sync-check.ts.

type Databases = { D1: D1Database; DB: D1Database }

/**
 * The comparison, live, for a person looking at it: every save counts, however recent. (Only the cron
 * leaves out the last two minutes, so a save that is still on its way isn't logged as a fault.)
 */
export async function siteSyncReport(): Promise<DriftReport> {
  const env = await cloudflareEnv<Databases>()
  // Posts published before the site recorded which save they were made from (once; see adoptEarlierPosts).
  await adoptEarlierPosts(env.D1 as never, env.DB as never)
  return siteDrift(env.D1 as never, env.DB as never, new Date(), 0)
}

/** What's known about the checks themselves: the last automatic run, the last failure, the last repair. */
export async function siteSyncStatus(): Promise<SyncStatus> {
  const env = await cloudflareEnv<Databases>()
  return readSyncStatus(env.DB as never)
}

export type RepublishResult = {
  fixed: DriftItem[]
  failed: Array<DriftItem & { message: string }>
  /** On the site with no document in Payload: never touched (see republish). */
  leftAlone: DriftItem[]
  report: DriftReport
  inStep: boolean
}

/**
 * Publishes again, from Payload's published documents, everything the comparison says the site has wrong:
 * missing and stale items are published, items the site shouldn't have are taken down, and the project list
 * is rebuilt. It runs the same code as saving does, so it can only ever make the site match Payload.
 *
 * One thing it never does: remove something from the site that Payload has no document for at all. That
 * isn't "Payload says unpublish it"; it's "Payload doesn't know it", which is also what a lost document or
 * an empty Payload database looks like, and the site's copy may then be the only one. Those are reported
 * and left exactly as they are for a person to decide.
 */
export async function republish(req: PayloadRequest): Promise<RepublishResult> {
  const env = await cloudflareEnv<Databases>()
  // Asked for by a person, so even a save from a moment ago counts.
  await adoptEarlierPosts(env.D1 as never, env.DB as never)
  const before = await siteDrift(env.D1 as never, env.DB as never, new Date(), 0)
  const fixed: DriftItem[] = []
  const failed: RepublishResult['failed'] = []
  const leftAlone: DriftItem[] = []
  for (const item of before.items) {
    if (item.id === null) {
      leftAlone.push(item)
      continue
    }
    try {
      // No site id is passed: if the document has gone since the comparison, this does nothing rather than remove it.
      if (item.kind === 'post') await syncPost(req, item.id)
      else if (item.kind === 'page') await syncPage(req, item.id)
      else await syncProject(req, item.id)
      fixed.push(item)
    } catch (error) {
      failed.push({ ...item, message: (error as Error).message })
    }
  }
  if (before.projectListStale) await republishProjectList({ DB: env.DB as never })
  // The menu and settings aren't compared item by item, so a repair always rebuilds them from Payload.
  await republishSettings(req).catch((error) => failed.push({ kind: 'page', id: null, siteId: 'menu', title: 'The menu and site settings', slug: '', state: 'stale', message: (error as Error).message }))
  // If the comparison can't be made again, nothing is known to be fixed: say so rather than assume.
  const after = await recordSiteDrift(env.D1 as never, env.DB as never, new Date(), { manual: true })
  const report = after ?? before
  // Fixed means the comparison, made again, no longer lists it: not merely that nothing threw.
  for (const item of [...fixed]) {
    if (after && !after.items.some((i) => i.kind === item.kind && i.siteId === item.siteId)) continue
    fixed.splice(fixed.indexOf(item), 1)
    failed.push({ ...item, message: after ? 'It was published again, but the website still doesn’t match. Open it and save it again, or try Republish in a minute.' : 'The website couldn’t be checked afterwards, so it isn’t known whether this was fixed.' })
  }
  await noteSyncStatus(env.DB as never, {
    lastRepair: {
      at: new Date().toISOString(),
      by: (req.user as { email?: string } | null)?.email ?? null,
      fixed: fixed.length,
      failed: failed.length,
      leftAlone: leftAlone.length,
      inStep: inStep(report),
    },
  }).catch(() => undefined)
  req.payload.logger.info({ msg: 'site republished', fixed: fixed.length, failed: failed.length, leftAlone: leftAlone.length, inStep: inStep(report) })
  return { fixed, failed, leftAlone, report, inStep: inStep(report) }
}

/**
 * Takes one item off the site that Payload has no document for. Owners only, one item at a time, and only
 * if the comparison, made again now, still says Payload has no document for it. A full copy of what was on
 * the site is kept first (worker/site/orphans.ts). Republish never does this.
 */
export async function removeOrphanedItem(req: PayloadRequest, kind: DriftItem['kind'], siteId: string): Promise<{ removed: boolean; slug: string | null; reason?: string; warning?: string }> {
  const env = await cloudflareEnv<Databases>()
  const report = await siteDrift(env.D1 as never, env.DB as never, new Date(), 0)
  const item = report.items.find((i) => i.kind === kind && i.siteId === siteId && i.state === 'extra' && i.id === null)
  if (!item) return { removed: false, slug: null, reason: 'Payload has a document for that, or it isn’t on the website. Use Republish instead.' }
  const by = (req.user as { email?: string } | null)?.email ?? null
  const slug = await removeOrphan(await publisherEnv(), kind, siteId, by)
  req.payload.logger.info({ msg: 'orphan removed from the site', kind, siteId, slug, by })
  // The removal has happened. What follows is tidying: if it fails, say that, never "it wasn't removed".
  let warning: string | undefined
  if (kind === 'page' && slug !== null)
    await republishSettings(req).catch(() => {
      warning = 'It was removed, but the menu couldn’t be refreshed. Press Republish to rebuild the menu.'
    })
  await recordSiteDrift(env.D1 as never, env.DB as never, new Date(), { manual: true }).catch(() => undefined)
  return { removed: slug !== null, slug, ...(warning ? { warning } : {}) }
}
