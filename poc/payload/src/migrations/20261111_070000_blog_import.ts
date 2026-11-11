import type { MigrateDownArgs, MigrateUpArgs } from '@payloadcms/db-d1-sqlite'

import { importLegacyPosts, releaseImportedPosts } from '../blog-import'

// Data migration: the blog's existing posts move into Payload (src/blog-import.ts). It runs once,
// when Payload first starts after the deploy. Their public pages don't change.
export async function up({ payload, req }: MigrateUpArgs): Promise<void> {
  const result = await importLegacyPosts(payload, req)
  payload.logger.info({ msg: 'blog import', imported: result.imported, skipped: result.skipped })
}

// Gives every imported post's row back to its earlier publisher, exactly as it was. Deletes nothing.
export async function down({ payload, req }: MigrateDownArgs): Promise<void> {
  const released = await releaseImportedPosts(payload, req)
  payload.logger.info({ msg: 'blog import undone', released })
}
