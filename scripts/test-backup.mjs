// Regression test for backups and migrations, entirely local and with invented data:
//
//   npm run test:backup
//
// 1. Builds a scratch database with every migration before 0014, and fills it with blog, wedding and
//    Knowledge rows (including the FTS5 index).
// 2. Applies 0014 to that populated database and checks nothing existing changed.
// 3. Adds rows to every Milestone 3 table (daily notes, collections, pins, favourites, saved views,
//    templates) and every Daly Tasks table (0015, 0016).
// 4. Runs the real backup script against it (`db-backup.mjs --local`), which exports per table,
//    restores into a throwaway database and checks row counts, schema objects and integrity.
// 5. Restores that backup once more and checks search works, relations are intact, nothing crosses
//    spaces and the wedding and blog rows are there.
//
// Nothing remote is touched. The scratch databases and the backup it makes are deleted afterwards.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, Report, d1Query, migrationFiles, wrangler } from "./lib/ops.mjs";
import { VIRTUAL_TABLE_REBUILDS } from "./lib/virtual-tables.mjs";

const report = new Report();
const work = mkdtempSync(join(tmpdir(), "dalyidau-backup-test-"));
const state = join(work, "state");
const restored = join(work, "restored");
const local = (persistTo) => ({ remote: false, persistTo });
const query = (sql, persistTo = state) => d1Query("local", sql, local(persistTo))[0];
const run = (sql, persistTo = state) => {
    const file = join(work, `run-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
    writeFileSync(file, sql);
    const result = wrangler(["d1", "execute", "DB", "--local", "--env=", "--cwd", work, "--persist-to", persistTo, "--file", file, "--yes"], { quiet: true });
    if (!result.ok) throw new Error(result.stderr.split("\n").find((l) => l.trim()) ?? "execute failed");
};
const migrate = () => {
    const result = wrangler(["d1", "migrations", "apply", "DB", "--local", "--env=", "--cwd", work, "--persist-to", state], { quiet: true });
    if (!result.ok) throw new Error(`migrations failed: ${result.stderr.split("\n").find((l) => l.trim())}`);
};

const NOW = "2026-10-17T00:00:00.000Z";
const PRE_0014 = `
INSERT INTO posts (id, slug, title, body_html, published_at, content_hash, synced_at) VALUES ('post-1', 'hello', 'Hello', '<p>Hi</p>', '${NOW}', 'h', '${NOW}');
INSERT INTO households (id, name, rsvp_code, created_at, updated_at) VALUES ('hh_backuptest0001', 'The Examples', 'BKUP7777', '${NOW}', '${NOW}');
INSERT INTO guests (id, household_id, first_name, created_at, updated_at) VALUES ('gst_backuptest0001', 'hh_backuptest0001', 'Robin', '${NOW}', '${NOW}');
INSERT INTO events (id, name, created_at, updated_at) VALUES ('evt_backuptest0001', 'Ceremony', '${NOW}', '${NOW}');
INSERT INTO guest_events (guest_id, event_id) VALUES ('gst_backuptest0001', 'evt_backuptest0001');
INSERT INTO knowledge_spaces (id, name, kind, personal_owner, created_by, created_at, updated_at) VALUES
  ('ksp_backuptest0001', 'My knowledge', 'personal', 'owner@example.com', 'owner@example.com', '${NOW}', '${NOW}'),
  ('ksp_backuptest0002', 'Household', 'shared', NULL, 'owner@example.com', '${NOW}', '${NOW}');
INSERT INTO knowledge_memberships (space_id, email, role, added_by, created_at, updated_at) VALUES
  ('ksp_backuptest0001', 'owner@example.com', 'owner', 'owner@example.com', '${NOW}', '${NOW}'),
  ('ksp_backuptest0002', 'owner@example.com', 'owner', 'owner@example.com', '${NOW}', '${NOW}'),
  ('ksp_backuptest0002', 'partner@example.com', 'editor', 'owner@example.com', '${NOW}', '${NOW}');
INSERT INTO knowledge_object_types (id, space_id, name, slug, created_by, updated_by, created_at, updated_at) VALUES
  ('kty_backuptest0001', 'ksp_backuptest0001', 'Page', 'page', 'x', 'x', '${NOW}', '${NOW}'),
  ('kty_backuptest0002', 'ksp_backuptest0002', 'Page', 'page', 'x', 'x', '${NOW}', '${NOW}');
INSERT INTO knowledge_objects (id, space_id, type_id, title, body_text, search_rowid, created_by, updated_by, created_at, updated_at) VALUES
  ('kob_backuptest0001', 'ksp_backuptest0001', 'kty_backuptest0001', 'Hydrant inspection notes', 'Check the pumps before summer', 1, 'x', 'x', '${NOW}', '${NOW}'),
  ('kob_backuptest0002', 'ksp_backuptest0001', 'kty_backuptest0001', 'Pump models', 'Two stroke', 2, 'x', 'x', '${NOW}', '${NOW}'),
  ('kob_backuptest0003', 'ksp_backuptest0002', 'kty_backuptest0002', 'Bin night', 'Tuesday', 3, 'x', 'x', '${NOW}', '${NOW}');
INSERT INTO knowledge_relations (id, space_id, source_id, target_id, relation_type, origin, created_by, created_at) VALUES
  ('krl_backuptest0001', 'ksp_backuptest0001', 'kob_backuptest0001', 'kob_backuptest0002', 'mentions', 'content', 'x', '${NOW}');
INSERT INTO knowledge_tags (id, space_id, name, created_at) VALUES ('ktg_backuptest0001', 'ksp_backuptest0001', 'seasonal', '${NOW}');
INSERT INTO knowledge_object_tags (space_id, object_id, tag_id) VALUES ('ksp_backuptest0001', 'kob_backuptest0001', 'ktg_backuptest0001');
INSERT INTO knowledge_revisions (id, space_id, object_id, version, kind, type_id, title, content_json, content_format, properties_json, changed_by, started_at, changed_at) VALUES
  ('krv_backuptest0001', 'ksp_backuptest0001', 'kob_backuptest0001', 1, 'create', 'kty_backuptest0001', 'Hydrant inspection notes', '{"type":"doc","content":[]}', 'daly.doc.v1', '{}', 'x', '${NOW}', '${NOW}');
INSERT INTO knowledge_audit (space_id, at, actor, action, entity_type, entity_id, summary) VALUES ('ksp_backuptest0001', '${NOW}', 'x', 'object.create', 'object', 'kob_backuptest0001', 'Created an object');
${VIRTUAL_TABLE_REBUILDS.knowledge_fts.map((s) => `${s};`).join("\n")}
`;

const M3 = `
INSERT INTO knowledge_objects (id, space_id, type_id, title, body_text, daily_date, search_rowid, created_by, updated_by, created_at, updated_at) VALUES
  ('kob_backuptest0004', 'ksp_backuptest0001', 'kty_backuptest0001', 'Saturday 17 October 2026', 'Rang the nursery', '2026-10-17', 4, 'x', 'x', '${NOW}', '${NOW}');
INSERT INTO knowledge_collections (id, space_id, name, created_by, updated_by, created_at, updated_at) VALUES ('kcl_backuptest0001', 'ksp_backuptest0001', 'Fire season', 'x', 'x', '${NOW}', '${NOW}');
INSERT INTO knowledge_collection_items (space_id, collection_id, object_id, position, pinned_at, added_by, added_at) VALUES
  ('ksp_backuptest0001', 'kcl_backuptest0001', 'kob_backuptest0001', 1, '${NOW}', 'x', '${NOW}'),
  ('ksp_backuptest0001', 'kcl_backuptest0001', 'kob_backuptest0002', 2, NULL, 'x', '${NOW}');
INSERT INTO knowledge_pins (space_id, object_id, position, pinned_by, pinned_at) VALUES ('ksp_backuptest0001', 'kob_backuptest0001', 1, 'x', '${NOW}');
INSERT INTO knowledge_favourites (email, space_id, object_id, position, created_at) VALUES ('owner@example.com', 'ksp_backuptest0001', 'kob_backuptest0002', 1, '${NOW}');
INSERT INTO knowledge_saved_views (id, space_id, owner_email, name, definition_json, created_by, updated_by, created_at, updated_at) VALUES
  ('kvw_backuptest0001', 'ksp_backuptest0001', 'owner@example.com', 'Seasonal', '{"tag":"seasonal"}', 'x', 'x', '${NOW}', '${NOW}');
INSERT INTO knowledge_templates (id, space_id, type_id, name, is_default, created_by, updated_by, created_at, updated_at) VALUES
  ('ktp_backuptest0001', 'ksp_backuptest0001', 'kty_backuptest0001', 'Inspection', 1, 'x', 'x', '${NOW}', '${NOW}');
${VIRTUAL_TABLE_REBUILDS.knowledge_fts.map((s) => `${s};`).join("\n")}
`;

// Daly Tasks (0015): every table, a shared project with two members, a section, a parent and a
// repeating subtask, a label, a completion, a comment, history, a Knowledge reference, a saved view
// and a reminder.
const TASKS = `
INSERT INTO task_preferences (email, time_zone, updated_at) VALUES ('owner@example.com', 'Australia/Sydney', '${NOW}');
INSERT INTO task_projects (id, name, kind, is_inbox, inbox_owner, created_by, updated_by, created_at, updated_at) VALUES
  ('tpj_backuptest0001', 'Inbox', 'personal', 1, 'owner@example.com', 'x', 'x', '${NOW}', '${NOW}'),
  ('tpj_backuptest0002', 'Household', 'shared', 0, NULL, 'x', 'x', '${NOW}', '${NOW}');
INSERT INTO task_project_members (project_id, email, role, added_by, created_at, updated_at) VALUES
  ('tpj_backuptest0001', 'owner@example.com', 'owner', 'x', '${NOW}', '${NOW}'),
  ('tpj_backuptest0002', 'owner@example.com', 'owner', 'x', '${NOW}', '${NOW}'),
  ('tpj_backuptest0002', 'partner@example.com', 'editor', 'x', '${NOW}', '${NOW}');
INSERT INTO task_sections (id, project_id, name, position, created_by, created_at, updated_at) VALUES ('tsc_backuptest0001', 'tpj_backuptest0002', 'Garden', 1, 'x', '${NOW}', '${NOW}');
INSERT INTO task_items (id, project_id, section_id, parent_id, depth, title, due_date, assignee_email, position, created_by, updated_by, created_at, updated_at) VALUES
  ('tsk_backuptest0001', 'tpj_backuptest0002', 'tsc_backuptest0001', NULL, 0, 'Prune the roses', '2026-10-20', 'partner@example.com', 1, 'x', 'x', '${NOW}', '${NOW}');
INSERT INTO task_items (id, project_id, section_id, parent_id, depth, title, due_date, recurrence_json, position, created_by, updated_by, created_at, updated_at) VALUES
  ('tsk_backuptest0002', 'tpj_backuptest0002', 'tsc_backuptest0001', 'tsk_backuptest0001', 1, 'Sharpen secateurs', '2026-10-21', '{"freq":"weekly","interval":1,"basis":"scheduled","anchor":"2026-10-21","weekdays":[3]}', 1, 'x', 'x', '${NOW}', '${NOW}');
INSERT INTO task_labels (id, owner_email, name, created_at, updated_at) VALUES ('tlb_backuptest0001', 'owner@example.com', 'garden', '${NOW}', '${NOW}');
INSERT INTO task_item_labels (task_id, name, added_by, added_at) VALUES ('tsk_backuptest0001', 'garden', 'x', '${NOW}');
INSERT INTO task_completions (task_id, kind, occurrence_date, next_date, at, by) VALUES ('tsk_backuptest0002', 'completed', '2026-10-14', '2026-10-21', '${NOW}', 'x');
INSERT INTO task_comments (id, task_id, author_email, body, created_at) VALUES ('tcm_backuptest0001', 'tsk_backuptest0001', 'owner@example.com', 'Gloves are in the shed', '${NOW}');
INSERT INTO task_activity (project_id, task_id, actor, action, at) VALUES ('tpj_backuptest0002', 'tsk_backuptest0001', 'x', 'task.create', '${NOW}');
INSERT INTO task_knowledge_links (id, task_id, object_id, added_by, added_at) VALUES ('tkl_backuptest0001', 'tsk_backuptest0001', 'kob_backuptest0003', 'x', '${NOW}');
INSERT INTO task_saved_views (id, owner_email, name, definition_json, created_at, updated_at) VALUES ('tfv_backuptest0001', 'owner@example.com', 'Garden', '{"labels":["garden"]}', '${NOW}', '${NOW}');
INSERT INTO task_reminders (id, task_id, owner_email, kind, remind_at, created_at) VALUES ('trm_backuptest0001', 'tsk_backuptest0001', 'partner@example.com', 'absolute', '2026-10-19T22:00:00.000Z', '${NOW}');
INSERT INTO task_view_preferences (email, view, prefs_json, updated_at) VALUES ('owner@example.com', 'upcoming', '{"mode":"week"}', '${NOW}');
UPDATE task_items SET client_id = 'qa-backuptest-0001' WHERE id = 'tsk_backuptest0001';
UPDATE task_reminders SET delivery_status = 'sent', attempts = 1, delivered_at = '${NOW}' WHERE id = 'trm_backuptest0001';
INSERT INTO task_recurrence_exceptions (task_id, occurrence_date, kind, moved_to, created_by, created_at) VALUES ('tsk_backuptest0002', '2026-10-28', 'move', '2026-10-29', 'x', '${NOW}');
INSERT INTO task_templates (id, owner_email, name, title, subtasks_json, created_at, updated_at) VALUES ('ttp_backuptest0001', 'owner@example.com', 'Packing', 'Pack for the coast', '[{"title":"Sunscreen"}]', '${NOW}', '${NOW}');
INSERT INTO task_import_batches (id, owner_email, source, file_fingerprint, status, options_json, created_at) VALUES ('tib_backuptest0001', 'owner@example.com', 'todoist_csv', 'abc', 'completed', '{}', '${NOW}');
INSERT INTO task_import_items (owner_email, source, kind, source_key, target_id, batch_id, imported_version, content_hash, created_at) VALUES ('owner@example.com', 'todoist', 'task', 'k1', 'tsk_backuptest0001', 'tib_backuptest0001', 1, 'h', '${NOW}');
`;
const TASK_TABLES = [
    "task_preferences",
    "task_projects",
    "task_project_members",
    "task_sections",
    "task_items",
    "task_labels",
    "task_item_labels",
    "task_completions",
    "task_comments",
    "task_activity",
    "task_knowledge_links",
    "task_saved_views",
    "task_reminders",
    "task_view_preferences",
    "task_recurrence_exceptions",
    "task_templates",
    "task_import_batches",
    "task_import_items",
];

const M3_TABLES = [
    "knowledge_collections",
    "knowledge_collection_items",
    "knowledge_pins",
    "knowledge_favourites",
    "knowledge_saved_views",
    "knowledge_templates",
];
const count = (table, persistTo = state) => query(`SELECT COUNT(*) AS n FROM ${table}`, persistTo)[0].n;
const searchHits = (term, persistTo) =>
    query(
        `SELECT o.id FROM knowledge_fts JOIN knowledge_objects o ON o.search_rowid = knowledge_fts.rowid WHERE knowledge_fts MATCH '"${term}"*' ORDER BY o.id`,
        persistTo,
    ).map((r) => r.id);

let backupFile = null;
try {
    // 1. Every migration before 0014, on its own copy of the config so the real migrations folder is untouched.
    copyFileSync(join(ROOT, "wrangler.jsonc"), join(work, "wrangler.jsonc"));
    mkdirSync(join(work, "migrations"));
    const all = migrationFiles();
    const before = all.filter((m) => m < "0014");
    for (const m of before) copyFileSync(join(ROOT, "migrations", m), join(work, "migrations", m));
    migrate();
    run(PRE_0014);
    report.pass(`A populated database at ${before.at(-1)} (blog, wedding and Knowledge rows, FTS index built)`);

    // 2. The new migrations on top of existing data.
    const objectsBefore = query("SELECT id, title, body_text, version, updated_at FROM knowledge_objects ORDER BY id");
    for (const m of all.filter((name) => name >= "0014")) copyFileSync(join(ROOT, "migrations", m), join(work, "migrations", m));
    migrate();
    const objectsAfter = query("SELECT id, title, body_text, version, updated_at FROM knowledge_objects ORDER BY id");
    report.check(
        JSON.stringify(objectsAfter) === JSON.stringify(objectsBefore),
        "Migrating left every existing object unchanged",
        "Migrating changed existing objects",
    );
    report.check(
        query("SELECT COUNT(*) AS n FROM knowledge_objects WHERE daily_date IS NOT NULL")[0].n === 0,
        "Existing objects aren't daily notes",
        "Existing objects gained a date",
    );
    report.check(searchHits("hydrant", state).join() === "kob_backuptest0001", "Search still works after migrating", "Search broke after migrating");
    report.check(count("guests") === 1 && count("posts") === 1, "Wedding and blog rows are untouched", "Wedding or blog rows changed");

    // 3. Rows in every new table.
    run(M3);
    report.check(
        M3_TABLES.every((t) => count(t) > 0),
        "Every Milestone 3 table has rows",
        "A Milestone 3 table is empty",
    );

    run(TASKS);
    report.check(
        TASK_TABLES.every((t) => count(t) > 0),
        "Every Tasks table has rows",
        "A Tasks table is empty",
    );

    // 4. The real backup script.
    const backup = spawnSync("node", [join(ROOT, "scripts", "db-backup.mjs"), "--local", "--persist-to", state], { cwd: ROOT, encoding: "utf8" });
    backupFile = /Backing up the local database to (\S+\.sql)/.exec(backup.stdout)?.[1] ?? null;
    process.stdout.write(
        backup.stdout
            .split("\n")
            .filter((l) => /^[✓✗!]/.test(l.replace(/\x1b\[\d+m/g, "")))
            .map((l) => `    ${l}\n`)
            .join(""),
    );
    report.check(
        backup.status === 0 && !!backupFile,
        "db-backup.mjs exported, restored and verified the database",
        `db-backup.mjs failed:\n${backup.stdout}\n${backup.stderr}`,
    );

    // 5. Restore it again and look inside.
    if (backupFile) {
        mkdirSync(restored);
        const result = wrangler(["d1", "execute", "DB", "--local", "--env=", "--persist-to", restored, "--file", backupFile, "--yes"], { quiet: true });
        report.check(result.ok, "The backup restores into an empty database", `The backup doesn't restore: ${result.stderr}`);
        for (const table of [
            "posts",
            "households",
            "guests",
            "events",
            "guest_events",
            "knowledge_objects",
            "knowledge_relations",
            "knowledge_revisions",
            ...M3_TABLES,
            ...TASK_TABLES,
        ])
            report.check(count(table, restored) === count(table), `${table}: ${count(table)} row(s) restored`, `${table}: row counts differ`);
        report.check(
            searchHits("hydrant", restored).join() === "kob_backuptest0001",
            "Search finds titles after restoring",
            "Search doesn't work after restoring",
        );
        report.check(
            searchHits("nursery", restored).join() === "kob_backuptest0004",
            "Search finds daily notes after restoring",
            "Daily notes aren't searchable after restoring",
        );
        report.check(
            query("SELECT source_id, target_id FROM knowledge_relations", restored)
                .map((r) => `${r.source_id}>${r.target_id}`)
                .join() === "kob_backuptest0001>kob_backuptest0002",
            "Relations are intact",
            "Relations changed",
        );
        const crossing = query(
            `SELECT 'relation' AS kind FROM knowledge_relations r JOIN knowledge_objects s ON s.id = r.source_id JOIN knowledge_objects t ON t.id = r.target_id WHERE s.space_id <> t.space_id
             UNION ALL SELECT 'collection' FROM knowledge_collection_items i JOIN knowledge_objects o ON o.id = i.object_id JOIN knowledge_collections c ON c.id = i.collection_id WHERE o.space_id <> c.space_id OR i.space_id <> c.space_id
             UNION ALL SELECT 'favourite' FROM knowledge_favourites f JOIN knowledge_objects o ON o.id = f.object_id WHERE o.space_id <> f.space_id`,
            restored,
        );
        report.check(crossing.length === 0, "Nothing crosses spaces in the restored copy", `Cross-space rows: ${JSON.stringify(crossing)}`);
        const indexes = query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('knowledge_objects_daily', 'knowledge_templates_default')",
            restored,
        );
        report.check(indexes.length === 2, "The daily-note and default-template unique indexes survive", "Unique indexes are missing after restoring");
        let refused = false;
        try {
            run(
                "INSERT INTO knowledge_objects (id, space_id, type_id, title, daily_date, search_rowid, created_by, updated_by, created_at, updated_at) VALUES ('kob_backuptest0009', 'ksp_backuptest0001', 'kty_backuptest0001', 'x', '2026-10-17', 99, 'x', 'x', 'x', 'x');",
                restored,
            );
        } catch {
            refused = true;
        }
        report.check(refused, "The restored copy still refuses a second daily note for a date", "The restored copy accepted a duplicate daily note");
        // Tasks' own rules survive: the personal-project trigger and the composite keys.
        const refuses = (sql) => {
            try {
                run(sql, restored);
                return false;
            } catch {
                return true;
            }
        };
        report.check(
            refuses(
                "INSERT INTO task_project_members (project_id, email, role, added_by, created_at, updated_at) VALUES ('tpj_backuptest0001', 'partner@example.com', 'editor', 'x', 'x', 'x');",
            ),
            "The restored copy still keeps personal projects to one member",
            "The restored copy let a second person into a personal project",
        );
        report.check(
            refuses("UPDATE task_items SET project_id = 'tpj_backuptest0001' WHERE id = 'tsk_backuptest0002';"),
            "The restored copy still refuses a subtask in a different project from its parent and section",
            "The restored copy accepted a cross-project subtask",
        );
        report.check(
            query("SELECT recurrence_json FROM task_items WHERE id = 'tsk_backuptest0002'", restored)[0]?.recurrence_json?.includes('"anchor":"2026-10-21"'),
            "Repeat rules restore intact",
            "Repeat rules changed in the restored copy",
        );
        // Milestone 2 (0016): delivery state, request ids, exceptions, templates and import provenance.
        report.check(
            query("SELECT delivery_status, attempts FROM task_reminders WHERE id = 'trm_backuptest0001'", restored)[0]?.delivery_status === "sent" &&
                query("SELECT client_id FROM task_items WHERE id = 'tsk_backuptest0001'", restored)[0]?.client_id === "qa-backuptest-0001",
            "Reminder delivery state and Quick Add request ids restore intact",
            "Reminder delivery state or request ids were lost",
        );
        report.check(
            query("SELECT moved_to FROM task_recurrence_exceptions WHERE task_id = 'tsk_backuptest0002'", restored)[0]?.moved_to === "2026-10-29" &&
                query("SELECT subtasks_json FROM task_templates WHERE id = 'ttp_backuptest0001'", restored)[0]?.subtasks_json === '[{"title":"Sunscreen"}]' &&
                query("SELECT target_id FROM task_import_items WHERE source_key = 'k1'", restored)[0]?.target_id === "tsk_backuptest0001",
            "Repeat exceptions, templates and Todoist import records restore intact",
            "Exceptions, templates or import records were lost",
        );
        report.check(
            refuses(
                "INSERT INTO task_items (id, project_id, depth, title, position, created_by, updated_by, created_at, updated_at, client_id) VALUES ('tsk_backuptest0009', 'tpj_backuptest0002', 0, 'Copy', 2, 'x', 'x', 'x', 'x', 'qa-backuptest-0001');",
            ),
            "The restored copy still refuses a second task with the same request id",
            "The restored copy accepted a duplicate request id",
        );
    }
} catch (error) {
    report.fail(error.message);
} finally {
    rmSync(work, { recursive: true, force: true });
    // The backup holds only the invented rows above; remove it and its manifest.
    if (backupFile)
        for (const name of readdirSync(join(ROOT, "backups"))) if (join(ROOT, "backups", name).startsWith(backupFile)) rmSync(join(ROOT, "backups", name));
}
report.finish();
