import type { GlobalConfig } from 'payload'

import { MAX_REDIRECTS, type RedirectInput, publishRedirects, redirectFrom } from '../../../../worker/site/redirects'
import { contentEditor } from '../collections/Users'
import { changedByField, recordChangedBy } from '../fields/changed-by'
import { asEditorError, publisherEnv, writeToSite } from '../site/publishing'
import { checkBeforeRestore, isRestore, resaveRestored } from '../site/restore'
import type { PayloadRequest } from 'payload'

// Redirects kept by hand (docs/AUDIT-2026-11.md, Phase 2b). A global, not a collection, so its API sits
// under /api/globals, which Cloudflare Access already covers. The redirects the site makes by itself when
// something is renamed are listed underneath, read-only; they always win, and a redirect here is only used
// for an address nothing else answers (worker/site/redirects.ts).

type RedirectsDoc = { items?: Array<RedirectInput & { note?: string | null; createdAt?: string | null }> | null; updatedAt?: string | null }

/** Writes the list to the site as Payload has it. Also what Republish runs. */
export async function syncRedirects(req: PayloadRequest, doc?: RedirectsDoc) {
  const env = await publisherEnv()
  const count = await writeToSite(req, 'redirects', async () => {
    const current = doc ?? ((await req.payload.findGlobal({ slug: 'redirects', depth: 0, overrideAccess: true, req })) as RedirectsDoc)
    const snapshot = await publishRedirects(env, current.items ?? [], { updatedAt: current.updatedAt ?? null })
    return Object.keys(snapshot.redirects).length
  })
  req.payload.logger.info({ msg: 'redirects published', count })
}

export const Redirects: GlobalConfig = {
  slug: 'redirects',
  label: 'Redirects',
  admin: {
    group: 'Website',
    description:
      'Send an old address somewhere new. You rarely need this: renaming a post, page or project keeps its old address working by itself (those are listed at the bottom). Saving updates the site straight away.',
  },
  // Every save is kept, with who made it: Versions shows what changed and when, and can restore an earlier list.
  versions: { max: 50 },
  access: {
    read: ({ req }) => contentEditor(req.user as never),
    update: ({ req }) => contentEditor(req.user as never),
    readVersions: ({ req }) => contentEditor(req.user as never),
  },
  hooks: {
    // A version that today's rules would refuse is refused before it is restored (src/site/restore.ts).
    beforeOperation: [
      checkBeforeRestore('redirects', async (version) => void (await publishRedirects(await publisherEnv(), (version as RedirectsDoc).items ?? [], { mode: 'check' }))),
    ],
    beforeChange: [
      recordChangedBy,
      // Checked in full before saving (duplicates, loops, addresses that already answer): nothing is stored on a mistake.
      async ({ data, originalDoc }) => {
        const before = new Map(((originalDoc as RedirectsDoc | undefined)?.items ?? []).map((i) => [(i as { id?: string }).id, i.createdAt]))
        const now = new Date().toISOString()
        for (const item of ((data as RedirectsDoc).items ?? []) as Array<RedirectInput & { id?: string; createdAt?: string | null }>) {
          // Stored as the site compares it, so the list reads the way it behaves.
          const from = redirectFrom(item.from)
          if ('path' in from) item.from = from.path
          if (typeof item.to === 'string') item.to = item.to.trim()
          // When it was added: set once by the server, kept across later saves.
          item.createdAt = before.get(item.id) ?? now
        }
        const env = await publisherEnv()
        await asEditorError(() => publishRedirects(env, (data as RedirectsDoc).items ?? [], { mode: 'check' }))
        return data
      },
    ],
    afterChange: [
      async ({ doc, req, context }) => {
        if (context?.skipPublicSync) return doc
        // A restore hands over a version row, not the list: it is saved again as itself (src/site/restore.ts).
        if (isRestore(req)) await resaveRestored(req, 'redirects', doc)
        else await syncRedirects(req, doc as RedirectsDoc)
        return doc
      },
    ],
  },
  fields: [
    {
      name: 'items',
      label: 'Redirects',
      labels: { singular: 'Redirect', plural: 'Redirects' },
      type: 'array',
      maxRows: MAX_REDIRECTS,
      admin: { initCollapsed: true, components: { RowLabel: '/site/redirect-row-label#RedirectRowLabel' } },
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'from', label: 'Old address', type: 'text', required: true, admin: { width: '50%', placeholder: '/old-page', description: 'A path on this site. Only used when nothing else answers it.' } },
            { name: 'to', label: 'Goes to', type: 'text', required: true, admin: { width: '50%', placeholder: '/blog/new-post or https://…' } },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'status',
              label: 'Type',
              type: 'select',
              required: true,
              defaultValue: '301',
              options: [
                { label: 'Permanent (301): the address has moved for good', value: '301' },
                { label: 'Temporary (302): it will come back', value: '302' },
              ],
              admin: { width: '50%' },
            },
            { name: 'enabled', label: 'Switched on', type: 'checkbox', defaultValue: true, admin: { width: '50%', description: 'Untick to keep the redirect here without using it.' } },
          ],
        },
        { name: 'note', label: 'Note (what it is for)', type: 'text', maxLength: 300, admin: { description: 'For you: the content or reason it belongs to. Never shown on the site.' } },
        { name: 'createdAt', label: 'Added', type: 'date', access: { create: () => false, update: () => false }, admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } } },
      ],
    },
    changedByField,
    // The redirects the site keeps by itself (read-only; src/views/automatic-redirects.tsx).
    { name: 'automatic', type: 'ui', admin: { components: { Field: '/views/automatic-redirects#AutomaticRedirects' } } },
  ],
}
