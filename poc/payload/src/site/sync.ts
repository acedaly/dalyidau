import type { PayloadRequest } from 'payload'

import { republishProjectList } from '../../../../worker/site/publisher'
import { type DriftItem, type DriftReport, SYNC_GRACE_MS, inStep, recordSiteDrift, siteDrift } from '../../../../worker/site/sync-check'
import { cloudflareEnv } from '../cloudflare-env'
import { syncPost } from '../collections/Posts'
import { syncPage, syncProject } from './publishing'

// "Website sync" (docs/AUDIT-2026-11.md, H3): whether the public site shows what Payload says is published,
// and the Republish action that makes it so. The comparison itself is worker/site/sync-check.ts.

type Databases = { D1: D1Database; DB: D1Database }

/** The comparison, live. Saves made in the last two minutes are left out (they may still be on their way). */
export async function siteSyncReport(): Promise<DriftReport> {
  const env = await cloudflareEnv<Databases>()
  return siteDrift(env.D1 as never, env.DB as never)
}

export type RepublishResult = { fixed: DriftItem[]; failed: Array<DriftItem & { message: string }>; report: DriftReport; inStep: boolean }

/**
 * Publishes again, from Payload's published documents, everything the comparison says the site has wrong:
 * missing and stale items are published, items the site shouldn't have are taken down, and the project list
 * is rebuilt. It runs the same code as saving does, so it can only ever make the site match Payload.
 */
export async function republish(req: PayloadRequest): Promise<RepublishResult> {
  const env = await cloudflareEnv<Databases>()
  // Asked for by a person, so even a save from a moment ago counts.
  const before = await siteDrift(env.D1 as never, env.DB as never, new Date(Date.now() + SYNC_GRACE_MS))
  const fixed: DriftItem[] = []
  const failed: RepublishResult['failed'] = []
  for (const item of before.items) {
    try {
      if (item.kind === 'post') await syncPost(req, item.id ?? -1, { siteId: item.siteId })
      else if (item.kind === 'page') await syncPage(req, item.id ?? item.siteId)
      else await syncProject(req, item.id ?? item.siteId)
      fixed.push(item)
    } catch (error) {
      failed.push({ ...item, message: (error as Error).message })
    }
  }
  if (before.projectListStale) await republishProjectList({ DB: env.DB as never })
  const report = (await recordSiteDrift(env.D1 as never, env.DB as never, new Date(Date.now() + SYNC_GRACE_MS))) ?? before
  req.payload.logger.info({ msg: 'site republished', fixed: fixed.length, failed: failed.length, inStep: inStep(report) })
  return { fixed, failed, report, inStep: inStep(report) }
}
