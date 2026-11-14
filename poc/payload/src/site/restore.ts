import type { PayloadRequest } from 'payload'

// Restoring an earlier version of a global (Versions → Restore) isn't an ordinary save in Payload 3: it
// writes the old version straight to the database, runs no `beforeChange` hook (so nothing is validated and
// nobody is recorded as having made the change), and then calls `afterChange` with the VERSION row
// ({ id, version: {…} }) instead of the document. A hook that published `doc` would publish an empty one.
//
// So a restore is followed at once by an ordinary save of what was restored, changing nothing: that save
// is validated, records who restored it, adds its own entry to the history and publishes the real document.

export const isRestore = (req: PayloadRequest) => (req.context as { isRestoringVersion?: boolean } | undefined)?.isRestoringVersion === true

/** Saves the just-restored global again, as itself, so the ordinary hooks run on it. */
export async function resaveRestored(req: PayloadRequest, slug: 'homepage' | 'navigation' | 'redirects' | 'site-settings'): Promise<void> {
  ;(req.context as { isRestoringVersion?: boolean }).isRestoringVersion = false
  await req.payload.updateGlobal({ slug, data: {}, req, overrideAccess: true })
}
