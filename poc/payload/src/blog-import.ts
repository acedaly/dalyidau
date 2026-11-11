import type { Payload, PayloadRequest } from 'payload'

import { cloudflareEnv } from './cloudflare-env'

// Brings the blog's existing posts into Payload (docs/PAYLOAD-BLOG.md#import). Run once by the
// data migration 20261111_blog_import; safe to run again (posts already imported are skipped).
//
// Each post keeps its id, address, dates, image and its stored HTML byte for byte, so the public page
// doesn't change. Its `posts` row is claimed for Payload (source 'payload') so the retired publishers
// can never overwrite it, and the row as it was is kept on the Payload document (legacy.originalRow)
// for undoing. Nothing is deleted, here or in the down migration.

type Row = Record<string, unknown> & {
  id: string
  source: string
  slug: string
  title: string
  subtitle: string | null
  summary: string | null
  category: string | null
  tags: string
  featured: number
  image_key: string | null
  image_alt: string | null
  image_width: number | null
  image_height: number | null
  body_html: string
  toc: string
  search_text: string
  word_count: number
  reading_minutes: number
  published_at: string
  updated_at: string | null
}

const IMPORTABLE = ['capacities', 'amplenote']

const parse = <T>(value: string | null | undefined, fallback: T): T => {
  try {
    return value ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}

export async function importLegacyPosts(payload: Payload, req?: PayloadRequest): Promise<{ imported: string[]; skipped: string[] }> {
  const { DB } = await cloudflareEnv<{ DB: D1Database }>()
  const rows = (
    await DB.prepare(`SELECT * FROM posts WHERE source IN (${IMPORTABLE.map(() => '?').join(', ')}) ORDER BY published_at`)
      .bind(...IMPORTABLE)
      .all<Row>()
  ).results
  const imported: string[] = []
  const skipped: string[] = []
  for (const row of rows) {
    const existing = await payload.find({ collection: 'posts', where: { publicId: { equals: row.id } }, limit: 1, depth: 0, overrideAccess: true, req })
    if (existing.docs.length) {
      skipped.push(row.slug)
      continue
    }
    // Claim the row first, and only if it's still the publisher's it was read from.
    const claimed = await DB.prepare("UPDATE posts SET source = 'payload' WHERE id = ? AND source = ?").bind(row.id, row.source).run()
    if (!claimed.meta.changes) {
      skipped.push(row.slug)
      continue
    }
    try {
      await payload.create({
        collection: 'posts',
        overrideAccess: true,
        draft: false,
        req,
        data: {
          title: row.title,
          slug: row.slug,
          subtitle: row.subtitle,
          summary: row.summary,
          category: row.category,
          tags: parse<string[]>(row.tags, []).map((tag) => ({ tag })),
          featured: !!row.featured,
          publishedAt: row.published_at,
          updatedDate: row.updated_at,
          publicId: row.id,
          legacy: {
            source: row.source,
            bodyHtml: row.body_html,
            toc: parse(row.toc, []),
            searchText: row.search_text,
            wordCount: row.word_count,
            readingMinutes: row.reading_minutes,
            imageKey: row.image_key,
            imageAlt: row.image_alt,
            imageWidth: row.image_width,
            imageHeight: row.image_height,
            originalRow: row,
          },
          _status: 'published',
        } as never,
      })
      imported.push(row.slug)
    } catch (error) {
      // Give the row back to its publisher, exactly as it was, and stop: a half-import is never left behind.
      await restoreRow(DB, row)
      throw error
    }
  }
  return { imported, skipped }
}

/** Puts a `posts` row back exactly as it was before the import. */
export async function restoreRow(DB: D1Database, row: Record<string, unknown>) {
  const columns = Object.keys(row).filter((c) => /^[a-z_]+$/.test(c))
  await DB.prepare(
    `INSERT INTO posts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT(id) DO UPDATE SET ${columns
      .filter((c) => c !== 'id')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ')}`,
  )
    .bind(...columns.map((c) => row[c] ?? null))
    .run()
}

/** Undo: every imported post's row goes back to its earlier publisher, as it was. Payload's copies stay. */
export async function releaseImportedPosts(payload: Payload, req?: PayloadRequest): Promise<string[]> {
  const { DB } = await cloudflareEnv<{ DB: D1Database }>()
  const docs = await payload.find({ collection: 'posts', where: { 'legacy.source': { exists: true } }, limit: 1000, depth: 0, overrideAccess: true, req })
  const released: string[] = []
  for (const doc of docs.docs as Array<{ legacy?: { originalRow?: Record<string, unknown> } }>) {
    const row = doc.legacy?.originalRow
    if (!row?.id) continue
    await restoreRow(DB, row)
    released.push(String(row.slug))
  }
  await DB.prepare("INSERT INTO meta (key, value) VALUES ('content_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(new Date().toISOString()).run()
  return released
}
