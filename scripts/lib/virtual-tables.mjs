// Virtual tables (FTS5) and how to rebuild them. `wrangler d1 export` refuses a database containing
// any virtual table, so backups then export the ordinary tables one by one, recreate each virtual
// table from its CREATE statement and refill it with these statements.
//
// There are none at the moment: the only one, Daly Knowledge's knowledge_fts, was dropped with its
// tables by migration 0032 (docs/DECOMMISSION_PORTAL_APPS.md). A database restored from an older
// backup may still have it; it then comes back empty, with a warning from db-backup.
/** @type {Record<string, string[]>} */
export const VIRTUAL_TABLE_REBUILDS = {};

/** FTS5 keeps its data in these ordinary-looking tables, which go with the virtual table, not the backup. */
export const SHADOW_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"];
