// Shared helpers for the operations scripts (config checks, backups, verification).
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
    // The applications retired on 9 Nov 2026 (docs/DECOMMISSION_PORTAL_APPS.md): nothing writes their
    // tables any more, so these confirm they're still as they were left, until the owner approves
    // dropping them (docs/pending/0033_drop_retired_portal_app_tables.sql).
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
        name: "Today preferences are valid JSON",
        sql: "SELECT email FROM today_preferences WHERE json_valid(value) = 0 LIMIT 20",
        level: "fail",
    },
    {
        // Intelligence Centre (0025): JSON the Worker validates, and private rows that must stay private.
        name: "Intelligence Centre JSON is valid, and alerts and wallboards belong to their watch areas' owners",
        sql: "SELECT id FROM ic_records WHERE json_valid(metrics) = 0 OR json_valid(attrs) = 0 OR (geometry IS NOT NULL AND json_valid(geometry) = 0) UNION ALL SELECT id FROM ic_watch_areas WHERE json_valid(definition) = 0 UNION ALL SELECT a.id FROM ic_alerts a JOIN ic_watch_areas w ON w.id = a.watch_id WHERE w.email <> a.email UNION ALL SELECT t.id FROM ic_display_tokens t LEFT JOIN ic_wallboards b ON b.id = t.wallboard_id WHERE b.id IS NULL AND t.revoked_at IS NULL LIMIT 20",
        level: "fail",
    },
    {
        // Intelligence Centre 9.1 (0027): one open version per record, and JSON the Worker validates.
        name: "Intelligence Centre history has one current version per record and valid JSON",
        sql: "SELECT record_id AS id FROM ic_record_versions WHERE valid_to IS NULL GROUP BY record_id HAVING COUNT(*) > 1 UNION ALL SELECT id FROM ic_record_versions WHERE json_valid(metrics) = 0 OR json_valid(attrs) = 0 LIMIT 20",
        level: "fail",
    },
    {
        // Rules and their matches belong to the owner of the watch area they name.
        name: "Monitoring rules and matches belong to their owners",
        sql: "SELECT id FROM ic_rules WHERE json_valid(definition) = 0 UNION ALL SELECT r.id FROM ic_rules r JOIN ic_watch_areas w ON w.id = r.watch_id WHERE w.email <> r.email UNION ALL SELECT m.id FROM ic_rule_matches m JOIN ic_rules r ON r.id = m.rule_id WHERE r.email <> m.email LIMIT 20",
        level: "fail",
    },
    {
        name: "Reports, schedules, wallboard views and journey links are valid and belong together",
        sql: "SELECT id FROM ic_reports WHERE json_valid(scope) = 0 UNION ALL SELECT id FROM ic_report_schedules WHERE json_valid(scope) = 0 UNION ALL SELECT v.id FROM ic_wallboard_views v LEFT JOIN ic_wallboards b ON b.id = v.wallboard_id WHERE b.id IS NULL OR json_valid(v.widgets) = 0 UNION ALL SELECT l.id FROM ic_event_links l JOIN ic_watch_areas w ON w.id = l.watch_id WHERE w.email <> l.email LIMIT 20",
        level: "fail",
    },
    {
        name: "Intelligence settings and preferences are valid JSON",
        sql: "SELECT key FROM ai_config WHERE json_valid(value) = 0 UNION ALL SELECT email FROM ai_preferences WHERE json_valid(value) = 0 LIMIT 20",
        level: "fail",
    },
    {
        // The schema refuses this too; a row here would mean a file could be purged that someone chose to keep.
        name: "Attachments kept on purpose are permanent and never scheduled for deletion",
        sql: "SELECT id FROM attachments WHERE keep = 1 AND (retention <> 'permanent' OR purge_after IS NOT NULL) LIMIT 20",
        level: "fail",
    },
    {
        name: "Budget amounts are not negative",
        sql: "SELECT id FROM budget_items WHERE estimated_cents < 0 OR paid_cents < 0 OR COALESCE(actual_cents, 0) < 0 LIMIT 20",
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
    // The Capacities archive (0029).
    "capacities_archive",
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
    // From here on, the tables of the applications retired on 9 Nov 2026 (docs/DECOMMISSION_PORTAL_APPS.md),
    // still backed up and counted until the owner approves dropping them (docs/pending/0033), and the
    // retired Home & Assets' `assets` and Knowledge's `attachments` (their other tables went in 0032).
    "assets",
    // Amplenote publishing (0028) and the MCP gateway's write ledger (0018).
    "amplenote_articles",
    "mcp_writes",
    // Daly Intelligence (0021).
    "ai_config",
    "ai_preferences",
    "ai_usage",
    "ai_alerts",
    "ai_jobs",
    "ai_briefings",
    "attachments",
    // Daly Calendar and the Leave Planner (0022).
    "calendar_preferences",
    "calendars",
    "calendar_members",
    "calendar_events",
    "calendar_event_overrides",
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
    // The Daily Planner's planning hours (0023) and Today (0024).
    "planner_preferences",
    "today_preferences",
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
    // Intelligence Centre 9.1 (0027). Versions, reliability rollups and the cache are history the
    // Centre can't collect again (the cache can); rules, matches, reports, schedules, wallboard
    // views and journey links belong to people. Reports' full text is in R2 (backup:r2).
    "ic_record_versions",
    "ic_geometries",
    "ic_source_daily",
    "ic_rules",
    "ic_rule_matches",
    "ic_reports",
    "ic_report_schedules",
    "ic_wallboard_views",
    "ic_event_links",
    "ic_cache",
];
