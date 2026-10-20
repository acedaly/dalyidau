// Shared helpers for the operations scripts (config checks, backups, verification, staging seed).
// They shell out to Wrangler, which uses your own Cloudflare login. Nothing here prints secret values.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Minimal JSONC reader for wrangler.jsonc: strips comments outside strings and trailing commas. */
export function readWranglerConfig() {
    const text = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
    let out = "";
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            out += c;
            if (c === "\\") out += text[++i];
            else if (c === '"') inString = false;
        } else if (c === '"') {
            inString = true;
            out += c;
        } else if (c === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            out += "\n";
        } else if (c === "/" && text[i + 1] === "*") {
            i = text.indexOf("*/", i + 2) + 1;
        } else out += c;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The effective settings for an environment ("production" = top level). */
export function environmentConfig(config, env) {
    if (env === "production")
        return { name: config.name, vars: config.vars ?? {}, d1: config.d1_databases ?? [], routes: config.routes ?? [], workersDev: config.workers_dev };
    const block = config.env?.[env];
    if (!block) throw new Error(`No env.${env} in wrangler.jsonc`);
    return {
        name: block.name ?? `${config.name}-${env}`,
        vars: block.vars ?? {},
        d1: block.d1_databases ?? [],
        // routes ARE inherited by named environments unless overridden.
        routes: "routes" in block ? block.routes : (config.routes ?? []),
        workersDev: block.workers_dev ?? config.workers_dev,
    };
}

export const envFlag = (env) => (env === "production" ? '--env=""' : `--env=${env}`);

export function wrangler(args, { input, quiet = false } = {}) {
    const result = spawnSync("npx", ["wrangler", ...args], {
        cwd: ROOT,
        encoding: "utf8",
        input,
        shell: process.platform === "win32",
        maxBuffer: 256 * 1024 * 1024,
    });
    if (!quiet && result.status !== 0) process.stderr.write(result.stderr);
    return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Runs read-only SQL with `wrangler d1 execute --json` and returns the rows of each statement. */
export function d1Query(env, sql, { remote = true, persistTo } = {}) {
    const args = ["d1", "execute", "DB", remote ? "--remote" : "--local", "--json", "--command", sql];
    if (env !== "local") args.push(env === "production" ? "--env=" : `--env=${env}`);
    if (persistTo) args.push("--persist-to", persistTo);
    const result = wrangler(args, { quiet: true });
    if (!result.ok) throw new Error((result.stderr || result.stdout).split("\n").find((l) => l.trim()) ?? "wrangler failed");
    const parsed = JSON.parse(result.stdout);
    return parsed.map((r) => r.results ?? []);
}

export function parseArgs(argv = process.argv.slice(2)) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const [k, v] = a.slice(2).split("=");
            args[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
        } else args._.push(a);
    }
    return args;
}

export const migrationFiles = () =>
    readdirSync(join(ROOT, "migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort();

const colour = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
export const green = colour(32);
export const red = colour(31);
export const yellow = colour(33);

export class Report {
    failures = 0;
    warnings = 0;
    pass(message) {
        console.log(`${green("✓")} ${message}`);
    }
    fail(message) {
        this.failures++;
        console.log(`${red("✗")} ${message}`);
    }
    warn(message) {
        this.warnings++;
        console.log(`${yellow("!")} ${message}`);
    }
    info(message) {
        console.log(`  ${message}`);
    }
    check(condition, ok, bad, level = "fail") {
        if (condition) this.pass(ok);
        else this[level](bad);
    }
    finish() {
        console.log(
            `\n${this.failures ? red(`${this.failures} problem(s)`) : green("No problems")}${this.warnings ? `, ${yellow(`${this.warnings} warning(s)`)}` : ""}.`,
        );
        process.exitCode = this.failures ? 1 : 0;
    }
}

/** The app-level integrity checks shared by db-verify and the backup check. Each returns rows that indicate a problem. */
export const INTEGRITY_CHECKS = [
    { name: "Foreign keys", sql: "PRAGMA foreign_key_check", level: "fail" },
    {
        name: "Guest JSON columns are valid",
        sql: "SELECT id FROM guests WHERE json_valid(tags) = 0 OR json_valid(custom) = 0 LIMIT 20",
        level: "fail",
    },
    {
        name: "Invitations point at live guests and events",
        sql: "SELECT ge.guest_id, ge.event_id FROM guest_events ge LEFT JOIN guests g ON g.id = ge.guest_id LEFT JOIN events e ON e.id = ge.event_id WHERE g.id IS NULL OR e.id IS NULL LIMIT 20",
        level: "fail",
    },
    {
        name: "Active guests aren't left in deleted households",
        sql: "SELECT g.id FROM guests g JOIN households h ON h.id = g.household_id WHERE g.deleted_at IS NULL AND h.deleted_at IS NOT NULL LIMIT 20",
        level: "warn",
    },
    {
        name: "RSVP codes are unique and well-formed",
        sql: "SELECT rsvp_code FROM households WHERE length(rsvp_code) < 6 OR rsvp_code GLOB '*[^A-Z0-9]*' LIMIT 20",
        level: "fail",
    },
    {
        name: "Knowledge documents and properties are valid JSON",
        sql: "SELECT id FROM knowledge_objects WHERE json_valid(content_json) = 0 OR json_valid(properties_json) = 0 LIMIT 20",
        level: "fail",
    },
    {
        name: "Every knowledge space has an owner",
        sql: "SELECT s.id FROM knowledge_spaces s WHERE NOT EXISTS (SELECT 1 FROM knowledge_memberships m WHERE m.space_id = s.id AND m.role = 'owner') LIMIT 20",
        level: "fail",
    },
    {
        // Rebuild with KNOWLEDGE_FTS_REBUILD (worker/knowledge/search.ts) if this ever fails.
        name: "The knowledge search index covers every object",
        sql: "SELECT o.id FROM knowledge_objects o LEFT JOIN knowledge_fts f ON f.rowid = o.search_rowid WHERE f.rowid IS NULL LIMIT 20",
        level: "warn",
    },
    {
        name: "Knowledge templates and saved views are valid JSON",
        sql: "SELECT id FROM knowledge_templates WHERE json_valid(content_json) = 0 OR json_valid(properties_json) = 0 UNION ALL SELECT id FROM knowledge_saved_views WHERE json_valid(definition_json) = 0 LIMIT 20",
        level: "fail",
    },
    {
        // Never shown (every read joins membership), and removed with the membership; any left are stale.
        name: "Knowledge favourites belong to current members",
        sql: "SELECT f.object_id FROM knowledge_favourites f LEFT JOIN knowledge_memberships m ON m.space_id = f.space_id AND m.email = f.email WHERE m.email IS NULL LIMIT 20",
        level: "warn",
    },
    {
        name: "Every Tasks project has an owner, and personal projects only their owner",
        sql: "SELECT p.id FROM task_projects p WHERE NOT EXISTS (SELECT 1 FROM task_project_members m WHERE m.project_id = p.id AND m.role = 'owner') OR (p.kind = 'personal' AND (SELECT COUNT(*) FROM task_project_members m WHERE m.project_id = p.id) <> 1) LIMIT 20",
        level: "fail",
    },
    {
        // depth is maintained by the Worker; a subtask is always one level below its parent, in the same project.
        name: "Subtasks sit one level below a parent in the same project",
        sql: "SELECT c.id FROM task_items c JOIN task_items p ON p.id = c.parent_id WHERE c.depth <> p.depth + 1 OR c.project_id <> p.project_id OR c.section_id IS NOT p.section_id LIMIT 20",
        level: "fail",
    },
    {
        name: "Repeating tasks have a valid rule and a date",
        sql: "SELECT id FROM task_items WHERE recurrence_json IS NOT NULL AND (json_valid(recurrence_json) = 0 OR json_extract(recurrence_json, '$.anchor') IS NULL OR due_date IS NULL) LIMIT 20",
        level: "fail",
    },
    {
        // Never shown (every read joins membership); removing a member deletes them. Any left are stale.
        name: "Task reminders belong to current project members",
        sql: "SELECT r.id FROM task_reminders r JOIN task_items t ON t.id = r.task_id LEFT JOIN task_project_members m ON m.project_id = t.project_id AND m.email = r.owner_email WHERE m.email IS NULL LIMIT 20",
        level: "warn",
    },
    {
        // Only shared projects share templates (worker/tasks/templates.ts checks this on every write).
        name: "Shared task templates belong to shared projects",
        sql: "SELECT t.id FROM task_templates t JOIN task_projects p ON p.id = t.shared_project_id WHERE p.kind <> 'shared' LIMIT 20",
        level: "warn",
    },
    {
        // Exceptions are later occurrences of a repeat; one left on a task that no longer repeats is harmless but stale.
        name: "Repeat exceptions belong to repeating tasks",
        sql: "SELECT e.task_id FROM task_recurrence_exceptions e JOIN task_items t ON t.id = e.task_id WHERE t.recurrence_json IS NULL LIMIT 20",
        level: "warn",
    },
    {
        // A claim older than an hour means a delivery run died part-way; the next run takes it over.
        name: "No reminder emails stuck mid-delivery",
        sql: "SELECT id FROM task_reminders WHERE delivery_status = 'pending' AND claimed_at IS NOT NULL AND claimed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour') LIMIT 20",
        level: "warn",
    },
    {
        // Milestone 3: a goal is reached only through its members, so it must always have an owner.
        name: "Every goal has an owner, and personal goals only their owner",
        sql: "SELECT g.id FROM task_goals g WHERE NOT EXISTS (SELECT 1 FROM task_goal_members m WHERE m.goal_id = g.id AND m.role = 'owner') OR (g.kind = 'personal' AND (SELECT COUNT(*) FROM task_goal_members m WHERE m.goal_id = g.id) <> 1) LIMIT 20",
        level: "fail",
    },
    {
        // Triggers refuse these on insert; a project made personal since would be removed from shared goals by the Worker.
        name: "Shared goals draw only on shared projects",
        sql: "SELECT l.id FROM task_goal_links l JOIN task_goals g ON g.id = l.goal_id AND g.kind = 'shared' LEFT JOIN task_projects p ON p.id = l.project_id LEFT JOIN task_items t ON t.id = l.task_id LEFT JOIN task_projects tp ON tp.id = t.project_id WHERE p.kind = 'personal' OR tp.kind = 'personal' LIMIT 20",
        level: "fail",
    },
    {
        name: "Routines are built on repeating top-level tasks",
        sql: "SELECT r.id FROM task_routines r JOIN task_items t ON t.id = r.task_id WHERE t.recurrence_json IS NULL OR t.parent_id IS NOT NULL LIMIT 20",
        level: "warn",
    },
    {
        // Leaving a project, or being made a viewer, removes someone from its routines' turns in the same batch.
        name: "People taking turns can be assigned in the routine's project",
        sql: "SELECT rp.routine_id FROM task_routine_participants rp JOIN task_routines r ON r.id = rp.routine_id JOIN task_items t ON t.id = r.task_id LEFT JOIN task_project_members m ON m.project_id = t.project_id AND m.email = rp.email AND m.role <> 'viewer' WHERE m.email IS NULL LIMIT 20",
        level: "warn",
    },
    {
        // Daly Calendar (0022): every calendar reachable by its owner, subscriptions only on subscription calendars.
        name: "Every calendar has an owner member, and each subscription has a subscription calendar",
        sql: "SELECT c.id FROM calendars c WHERE NOT EXISTS (SELECT 1 FROM calendar_members m WHERE m.calendar_id = c.id AND m.role = 'owner') UNION ALL SELECT s.id FROM calendar_subscriptions s JOIN calendars c ON c.id = s.calendar_id WHERE c.source <> 'subscription' LIMIT 20",
        level: "fail",
    },
    {
        // Leaving a calendar deletes the person's reminders on it in the same batch.
        name: "Calendar reminders belong to current members of the event's calendar",
        sql: "SELECT r.id FROM calendar_reminders r JOIN calendar_events e ON e.id = r.event_id LEFT JOIN calendar_members m ON m.calendar_id = e.calendar_id AND m.email = r.email WHERE m.email IS NULL LIMIT 20",
        level: "warn",
    },
    {
        name: "Leave bookings use the same person's leave types, and leave settings are valid JSON",
        sql: "SELECT b.id FROM leave_bookings b JOIN leave_types t ON t.id = b.leave_type_id WHERE t.email <> b.email UNION ALL SELECT email FROM leave_profiles WHERE json_valid(pattern) = 0 OR json_valid(settings) = 0 UNION ALL SELECT id FROM leave_types WHERE json_valid(accrual) = 0 LIMIT 20",
        level: "fail",
    },
    {
        // Today (0024): preferences and reviews are JSON the Worker validates; a damaged one falls back to defaults.
        name: "Today preferences and reviews are valid JSON",
        sql: "SELECT email FROM today_preferences WHERE json_valid(value) = 0 UNION ALL SELECT email FROM daily_reviews WHERE json_valid(priorities) = 0 OR json_valid(summary) = 0 LIMIT 20",
        level: "fail",
    },
    {
        // Intelligence Centre (0025): JSON the Worker validates, and private rows that must stay private.
        name: "Intelligence Centre JSON is valid, and alerts and wallboards belong to their watch areas' owners",
        sql: "SELECT id FROM ic_records WHERE json_valid(metrics) = 0 OR json_valid(attrs) = 0 OR (geometry IS NOT NULL AND json_valid(geometry) = 0) UNION ALL SELECT id FROM ic_watch_areas WHERE json_valid(definition) = 0 UNION ALL SELECT a.id FROM ic_alerts a JOIN ic_watch_areas w ON w.id = a.watch_id WHERE w.email <> a.email UNION ALL SELECT t.id FROM ic_display_tokens t LEFT JOIN ic_wallboards b ON b.id = t.wallboard_id WHERE b.id IS NULL AND t.revoked_at IS NULL LIMIT 20",
        level: "fail",
    },
    {
        // Daily Planner (0023): triggers remove blocks when someone leaves a project or a task moves.
        // A row here is a block whose owner was since made a viewer (the planner already hides those).
        name: "Time blocks belong to people who can still work on their task",
        sql: "SELECT b.id FROM task_time_blocks b JOIN task_items t ON t.id = b.task_id LEFT JOIN task_project_members m ON m.project_id = t.project_id AND m.email = b.owner_email AND m.role <> 'viewer' WHERE b.status = 'scheduled' AND m.email IS NULL LIMIT 20",
        level: "warn",
    },
    {
        name: "Intelligence settings and preferences are valid JSON",
        sql: "SELECT key FROM ai_config WHERE json_valid(value) = 0 UNION ALL SELECT email FROM ai_preferences WHERE json_valid(value) = 0 UNION ALL SELECT id FROM ai_suggestions WHERE json_valid(payload) = 0 LIMIT 20",
        level: "fail",
    },
    {
        // The schema refuses this too; a row here would mean a file could be purged that someone chose to keep.
        name: "Attachments kept on purpose are permanent and never scheduled for deletion",
        sql: "SELECT id FROM attachments WHERE keep = 1 AND (retention <> 'permanent' OR purge_after IS NOT NULL) LIMIT 20",
        level: "fail",
    },
    {
        name: "Knowledge attachments point at objects that still exist",
        sql: "SELECT a.id FROM attachments a LEFT JOIN knowledge_objects o ON o.id = a.object_id WHERE a.purpose = 'knowledge' AND a.status <> 'deleted' AND o.id IS NULL LIMIT 20",
        level: "warn",
    },
    {
        // A claim this old belongs to a runner that died; the next cron run takes it over.
        name: "No Intelligence jobs stuck mid-run",
        sql: "SELECT id FROM ai_jobs WHERE status = 'running' AND claimed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour') LIMIT 20",
        level: "warn",
    },
    {
        name: "Budget amounts are not negative",
        sql: "SELECT id FROM budget_items WHERE estimated_cents < 0 OR paid_cents < 0 OR COALESCE(actual_cents, 0) < 0 LIMIT 20",
        level: "fail",
    },
    {
        // Kept in step by the Worker: a private asset has no shares, a household one has the household row.
        name: "Home & Assets sharing matches each asset's visibility",
        sql: "SELECT a.id FROM assets a WHERE (a.visibility = 'private' AND EXISTS (SELECT 1 FROM asset_shares s WHERE s.asset_id = a.id)) OR (a.visibility = 'household' AND NOT EXISTS (SELECT 1 FROM asset_shares s WHERE s.asset_id = a.id AND s.email = '*')) OR (a.visibility = 'selected' AND EXISTS (SELECT 1 FROM asset_shares s WHERE s.asset_id = a.id AND s.email = '*')) LIMIT 20",
        level: "fail",
    },
    {
        name: "Nobody holds a share of an asset they own",
        sql: "SELECT s.asset_id FROM asset_shares s JOIN assets a ON a.id = s.asset_id WHERE lower(s.email) = lower(a.owner_email) LIMIT 20",
        level: "fail",
    },
    {
        name: "Home & Assets files are under private/assets/ and belong to at most one record",
        sql: "SELECT id FROM asset_files WHERE r2_key NOT LIKE 'private/assets/%' OR ((asset_id IS NOT NULL) + (location_id IS NOT NULL) + (policy_id IS NOT NULL)) > 1 LIMIT 20",
        level: "fail",
    },
    {
        // Worked out from the schedule's own rule (src/shared/assets/engine.ts); stale only if a write was interrupted.
        name: "Maintenance schedules have an interval",
        sql: "SELECT id FROM asset_schedules WHERE interval_count IS NULL AND interval_km IS NULL LIMIT 20",
        level: "fail",
    },
    {
        name: "Each maintenance schedule has at most one open record",
        sql: "SELECT schedule_id FROM asset_maintenance WHERE schedule_id IS NOT NULL AND status IN ('open', 'requested', 'scheduled', 'in_progress') GROUP BY schedule_id HAVING COUNT(*) > 1 LIMIT 20",
        level: "fail",
    },
    {
        // A claim left by an interrupted request; the next attempt clears it after two minutes.
        name: "No stale Home & Assets task claims",
        sql: "SELECT id FROM asset_task_links WHERE task_id LIKE 'pending_%' AND created_at < datetime('now', '-1 hour') LIMIT 20",
        level: "warn",
    },
    {
        name: "Home & Assets JSON columns are valid",
        sql: "SELECT id FROM assets WHERE json_valid(tags) = 0 OR json_valid(custom) = 0 OR json_valid(depreciation) = 0 UNION ALL SELECT asset_id FROM asset_vehicles WHERE json_valid(specs) = 0 LIMIT 20",
        level: "fail",
    },
];

/**
 * Row counts for many tables (D1 limits UNION terms, so scalar subqueries instead), 50 to a
 * statement: D1 refuses a result with more than 100 columns, and there are more tables than that.
 */
export const countRows = (env, tables, source = {}) => {
    const counts = {};
    for (let i = 0; i < tables.length; i += 50) {
        const sql = `SELECT ${tables
            .slice(i, i + 50)
            .map((t) => `(SELECT COUNT(*) FROM ${t}) AS "${t}"`)
            .join(", ")}`;
        Object.assign(counts, d1Query(env, sql, source)[0][0] ?? {});
    }
    return counts;
};

export const TABLES = [
    "posts",
    "sources",
    "slug_redirects",
    "media",
    "entity_cache",
    "sync_runs",
    "meta",
    "portal_users",
    "audit_log",
    "feature_flags",
    "settings",
    "dashboard_layouts",
    "households",
    "guests",
    "events",
    "guest_events",
    "custom_fields",
    "rsvp_submissions",
    "rate_limits",
    "message_templates",
    "messages",
    "message_recipients",
    "tasks",
    "timeline_items",
    "suppliers",
    "budget_items",
    "knowledge_spaces",
    "knowledge_memberships",
    "knowledge_object_types",
    "knowledge_objects",
    "knowledge_revisions",
    "knowledge_relations",
    "knowledge_tags",
    "knowledge_object_tags",
    "knowledge_audit",
    "knowledge_collections",
    "knowledge_collection_items",
    "knowledge_pins",
    "knowledge_favourites",
    "knowledge_saved_views",
    "knowledge_templates",
    // Daly Tasks (0015–0017): counted before the export and compared after the test restore.
    "task_projects",
    "task_project_members",
    "task_sections",
    "task_items",
    "task_completions",
    "task_comments",
    "task_knowledge_links",
    "task_reminders",
    "task_templates",
    "task_project_reviews",
    "task_project_knowledge_links",
    "task_goals",
    "task_goal_members",
    "task_goal_links",
    "task_goal_milestones",
    "task_goal_progress",
    "task_routines",
    "task_routine_participants",
    // The MCP gateway's write ledger (0018).
    "mcp_writes",
    // DalyHub migration provenance (0019).
    "dalyhub_import_runs",
    "dalyhub_import_items",
    // Daly Intelligence (0021). ai_semantic_index is derived (Vectorize is rebuilt from Knowledge)
    // but is an ordinary table, so it's backed up and counted like the rest.
    "ai_config",
    "ai_preferences",
    "ai_exclusions",
    "ai_usage",
    "ai_alerts",
    "ai_jobs",
    "ai_semantic_index",
    "ai_captures",
    "ai_transcripts",
    "ai_transcript_parts",
    "ai_suggestions",
    "ai_briefings",
    "attachments",
    // Daly Calendar and the Leave Planner (0022).
    "calendar_preferences",
    "calendars",
    "calendar_members",
    "calendar_events",
    "calendar_event_overrides",
    "calendar_event_links",
    "calendar_reminders",
    "calendar_notifications",
    "calendar_subscriptions",
    "calendar_feeds",
    "calendar_custom_dates",
    "calendar_activity",
    "leave_profiles",
    "leave_types",
    "leave_adjustments",
    "leave_scenarios",
    "leave_bookings",
    "leave_shares",
    // The Daily Planner (0023).
    "planner_preferences",
    "task_estimates",
    "task_time_blocks",
    // Today (0024).
    "today_preferences",
    "daily_reviews",
    // Intelligence Centre (0025). Public records can be collected again; watch areas, alerts,
    // preferences, wallboards and display credentials (hashes only) can't.
    "ic_sources",
    "ic_fetch_runs",
    "ic_records",
    "ic_changes",
    "ic_series",
    "ic_watch_areas",
    "ic_alerts",
    "ic_preferences",
    "ic_config",
    "ic_briefings",
    "ic_wallboards",
    "ic_display_tokens",
];
