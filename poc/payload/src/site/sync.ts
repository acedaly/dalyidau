import type { PayloadRequest } from 'payload'

import { republishProjectList } from '../../../../worker/site/publisher'
import { type DriftItem, type DriftReport, SYNC_GRACE_MS, type SyncStatus, inStep, noteSyncStatus, readSyncStatus, recordSiteDrift, siteDrift } from '../../../../worker/site/sync-check'
import { cloudflareEnv } from '../cloudflare-env'
import { syncPost } from '../collections/Posts'
import { syncPage, syncProject } from './publishing'

// "Website sync" (docs/AUDIT-2026-11.md, H3): whether the public site shows what Payload says is published,
// and the Republish action that makes it so. The comparison itself is worker/site/sync-check.ts.

type Databases = { D1: D1Database; DB: D1Database }

/**
 * The comparison, live. Saves made in the last two minutes are left out (they may still be on their way)
 * unless `includeRecent` is set.
 */
export async function siteSyncReport(includeRecent = false): Promise<DriftReport> {
  const env = await cloudflareEnv<Databases>()
  return siteDrift(env.D1 as never, env.DB as never, new Date(Date.now() + (includeRecent ? SYNC_GRACE_MS : 0)))
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
  const before = await siteDrift(env.D1 as never, env.DB as never, new Date(Date.now() + SYNC_GRACE_MS))
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
  const report = (await recordSiteDrift(env.D1 as never, env.DB as never, new Date(Date.now() + SYNC_GRACE_MS))) ?? before
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
