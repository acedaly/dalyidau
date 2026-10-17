// Virtual tables (FTS5) and how to rebuild them. `wrangler d1 export` refuses a database containing
// any virtual table, so backups export the ordinary tables one by one, recreate each virtual table
// from its CREATE statement and then refill it with these statements. They must match
// KNOWLEDGE_FTS_REBUILD in worker/knowledge/search.ts (test/knowledge.test.ts checks).
export const VIRTUAL_TABLE_REBUILDS = {
    knowledge_fts: [
        "DELETE FROM knowledge_fts",
        `INSERT INTO knowledge_fts (rowid, title, body, tags) SELECT o.search_rowid, o.title, o.body_text,
    COALESCE((SELECT group_concat(t.name, ' ') FROM knowledge_object_tags ot JOIN knowledge_tags t ON t.id = ot.tag_id WHERE ot.object_id = o.id), '')
    FROM knowledge_objects o`,
    ],
};

/** FTS5 keeps its data in these ordinary-looking tables, which go with the virtual table, not the backup. */
export const SHADOW_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"];
