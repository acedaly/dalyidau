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
        name: "Budget amounts are not negative",
        sql: "SELECT id FROM budget_items WHERE estimated_cents < 0 OR paid_cents < 0 OR COALESCE(actual_cents, 0) < 0 LIMIT 20",
        level: "fail",
    },
];

/** Row counts for many tables in one statement (D1 limits UNION terms, so scalar subqueries instead). */
export const countRows = (env, tables, source = {}) => {
    if (tables.length === 0) return {};
    const sql = `SELECT ${tables.map((t) => `(SELECT COUNT(*) FROM ${t}) AS "${t}"`).join(", ")}`;
    return d1Query(env, sql, source)[0][0] ?? {};
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
];
