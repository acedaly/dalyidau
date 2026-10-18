// Plans a DalyHub V2 → Daly Portal migration from a DalyHub database export. Local and read-only:
// it reads the export file into an in-memory SQLite database, writes a plan and a preview, and
// talks to nothing. See docs/DALYHUB_MIGRATION.md.
//
//   npx wrangler d1 export dalyhub-v2 --remote --output migration-work/dalyhub.sql   (in DalyHub-V2)
//   node scripts/dalyhub-plan.mjs migration-work/dalyhub.sql [--include-completed] [--include-archived]
//
// Writes migration-work/dalyhub-plan.json and migration-work/dalyhub-preview.md. migration-work/ is
// git-ignored: the plan holds real titles and notes, and this repository is public. Needs Node 22.18+
// (built-in node:sqlite and TypeScript type stripping).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describePlan, planDalyHubMigration } from "../src/shared/migration/dalyhub.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
    console.error("Usage: node scripts/dalyhub-plan.mjs <dalyhub export .sql> [--include-completed] [--include-archived] [--out <dir>]");
    process.exit(2);
}
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "migration-work";

const db = new DatabaseSync(":memory:");
db.exec(readFileSync(file, "utf8"));

const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
    .all()
    .map((r) => r.name);
const has = (t) => tables.includes(t);
const rows = (sql, table) => (has(table) ? db.prepare(sql).all() : []);
const tableCounts = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));

const source = {
    entities: rows("SELECT id, workspace_id, type, title, created_at, updated_at, deleted_at FROM entities", "entities"),
    links: rows("SELECT source_entity_id, target_entity_id, type, deleted_at FROM entity_links", "entity_links"),
    spine: rows("SELECT entity_id, kind, completed_at FROM spine_records", "spine_records"),
    tasks: rows(
        `SELECT entity_id, status, priority, due_date, scheduled_date, commitment_state, delegate_to, delegated_on, follow_up_on, delegate_note,
                description, waiting_since, waiting_note FROM task_details`,
        "task_details",
    ),
    projects: rows("SELECT entity_id, status, archived_at FROM project_details", "project_details"),
    goals: rows("SELECT entity_id, target_date, definition_of_done FROM goal_details", "goal_details"),
    areas: rows("SELECT entity_id, archived_at FROM area_details", "area_details"),
    notes: rows("SELECT entity_id, content, archived_at FROM note_details", "note_details"),
    decisions: rows("SELECT entity_id, status, rationale, decision_date, review_date, related_entity_id FROM decision_details", "decision_details"),
    meetings: rows(
        "SELECT entity_id, starts_at, timezone, location, status, agenda_markdown, notes_markdown, archived_at FROM meeting_details",
        "meeting_details",
    ),
    checklist: rows("SELECT id, task_id, title, position, completed FROM task_checklist_items", "task_checklist_items"),
    recurring: rows("SELECT entity_id FROM task_recurrence_rules", "task_recurrence_rules").map((r) => r.entity_id),
    tags: rows("SELECT entity_id, tag_key FROM entity_tags", "entity_tags"),
    tableCounts,
};
// node:sqlite returns null-prototype rows; the planner only needs plain values.
const plain = JSON.parse(JSON.stringify(source));

const plan = planDalyHubMigration(plain, {
    includeCompleted: args.includes("--include-completed"),
    includeArchived: args.includes("--include-archived"),
});

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "dalyhub-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
writeFileSync(path.join(outDir, "dalyhub-preview.md"), describePlan(plan));
console.log(describePlan(plan));
console.log(`Wrote ${path.join(outDir, "dalyhub-plan.json")} and dalyhub-preview.md. Nothing was sent anywhere.`);
