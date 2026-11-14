import type { GlobalBeforeOperationHook, PayloadRequest } from 'payload'
import { APIError } from 'payload'

import { asEditorError } from './publishing'

// Restoring an earlier version of a global (Versions → Restore) isn't an ordinary save in Payload 3: it
// writes the old version straight to the database, runs no `beforeChange` hook (so nothing is validated and
// nobody is recorded as having made the change), and then calls `afterChange` with the VERSION row
// ({ id, version: {…} }) instead of the document. A hook that published `doc` would publish an empty one.
//
// So a restore is handled in two steps:
// 1. Before Payload writes anything, the version is checked exactly as a save would be (checkBeforeRestore).
//    Payload's database has no transactions here, so a restore refused afterwards couldn't be undone: an
//    old version that is no longer valid (a redirect from an address a page has since taken, a menu link to
//    a page since deleted) is refused while everything is still as it was.
// 2. Once restored, it is saved again as itself, changing nothing (resaveRestored): that ordinary save
//    records who restored it, adds its own entry to the history and publishes the real document.

type GlobalSlug = 'homepage' | 'navigation' | 'redirects' | 'site-settings'

export const isRestore = (req: PayloadRequest) => (req.context as { isRestoringVersion?: boolean } | undefined)?.isRestoringVersion === true

/** Refuses, before anything is written, a restore of a version that couldn't be saved today. `check` throws a PublishError to refuse. */
export const checkBeforeRestore =
  (slug: GlobalSlug, check: (version: Record<string, unknown>, req: PayloadRequest) => Promise<void> | void): GlobalBeforeOperationHook =>
  async ({ args, operation, req }) => {
    if ((operation as string) !== 'restoreVersion') return args
    const id = (args as { id?: number | string }).id
    if (id === undefined) return args
    const { docs } = await req.payload.findGlobalVersions({ slug, where: { id: { equals: id } }, limit: 1, depth: 0, overrideAccess: true, req })
    const version = (docs[0] as unknown as { version?: Record<string, unknown> } | undefined)?.version
    // No such version: Payload answers "not found" itself.
    if (!version) return args
    await asEditorError(async () => void (await check(version, req)))
    return args
  }

/**
 * Saves the just-restored global again, as itself, so the ordinary hooks run on it. `restored` is what
 * Payload handed afterChange (the version row): a restored draft is saved as a draft.
 */
export async function resaveRestored(req: PayloadRequest, slug: GlobalSlug, restored?: unknown): Promise<void> {
  ;(req.context as { isRestoringVersion?: boolean }).isRestoringVersion = false
  const draft = (restored as { version?: { _status?: string } } | undefined)?.version?._status === 'draft'
  try {
    await req.payload.updateGlobal({ slug, data: {}, req, overrideAccess: true, ...(draft ? { draft: true } : {}) })
  } catch (error) {
    // The version was checked before it was restored, so this is the website or the database having a bad
    // moment. Payload has the restored version; the editor is told plainly that the site may not.
    if (error instanceof APIError && error.status === 503) throw error
    req.payload.logger.error({ msg: 'restore_resave_failed', slug, message: (error as Error).message })
    throw new APIError(
      `The earlier version was restored here, but it couldn't be published to the website: ${(error as Error).message} Open it and press Save to publish it, or restore a different version.`,
      (error as { status?: number }).status === 400 ? 400 : 503,
      undefined,
      true,
    )
  }
}
