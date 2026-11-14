#!/usr/bin/env node
// Rehearses Payload's pending migrations on a copy of the production Payload database, on this machine.
// docs/PAYLOAD-BACKUP.md ("Rehearsing a migration").
//
//   node scripts/payload-migration-rehearsal.mjs backups/dalyidau-payload-<time>.sql
//
// The file is one made by `npm run payload:backup` (the reordered one, not `.export.sql`). Nothing on
// Cloudflare is read or written: the backup is restored into a throwaway local database, Payload's own
// migration runner applies whatever is pending (exactly what production runs when /admin first opens after
// a deploy), and then every table that existed before is compared, row for row, with what's there after.
// Your local development state is set aside first and put back afterwards, whatever happens.
//
// Exits non-zero if anything a migration must never do has happened: a row lost or changed, a table or
// index gone, SQLite's integrity or foreign-key check failing.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const backup = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!backup || !existsSync(backup)) {
    console.error("Usage: node scripts/payload-migration-rehearsal.mjs <backup.sql>  (a file from `npm run payload:backup`)");
    process.exit(2);
}
const app = path.resolve(import.meta.dirname, "../poc/payload");
const state = path.join(app, ".wrangler/state");
const held = `${state}-held-for-rehearsal-${Date.now()}`;

const d1 = (args) =>
    execFileSync("npx", ["wrangler", "d1", "execute", "D1", "--local", ...args], {
        cwd: app,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
    }).toString();
const query = (sql) => JSON.parse(d1(["--json", "--command", sql]))[0].results;
/** Every table's row count and a hash of its rows (in primary-key order), so a changed row shows as well as a lost one. */
const picture = () => {
    const tables = query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").map(
        (r) => r.name,
    );
    const indexes = query("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
    const rows = {};
    for (const table of tables) {
        const columns = query(`PRAGMA table_info(\`${table}\`)`).map((c) => c.name);
        const data = query(`SELECT * FROM \`${table}\` ORDER BY 1, 2`);
        rows[table] = {
            count: data.length,
            columns,
            hash: (only) =>
                createHash("sha256")
                    .update(JSON.stringify(data.map((r) => only.map((c) => r[c]))))
                    .digest("hex"),
        };
    }
    return { tables, indexes, rows };
};

let failures = 0;
const check = (ok, good, bad) => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${ok ? good : bad}`);
};

const hadState = existsSync(state);
if (hadState) renameSync(state, held);
try {
    d1(["--file", backup, "--yes"]);
    const before = picture();
    const applied = (db) => query("SELECT name FROM payload_migrations ORDER BY id").map((r) => r.name);
    const appliedBefore = applied();
    console.log(
        `Restored ${path.basename(backup)}: ${before.tables.length} tables, ${Object.values(before.rows).reduce((n, t) => n + t.count, 0)} rows, ${appliedBefore.length} migrations applied.`,
    );

    const run = spawnSync("npx", ["cross-env", "NODE_OPTIONS=--no-deprecation", "payload", "migrate"], {
        cwd: app,
        env: { ...process.env, PAYLOAD_SECRET: "local-only", NODE_ENV: "development" },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    check(
        run.status === 0,
        "Payload's migration runner finished",
        `Payload's migration runner failed:\n${(run.stdout + run.stderr).split("\n").slice(-25).join("\n")}`,
    );

    const after = picture();
    const newlyApplied = applied().filter((name) => !appliedBefore.includes(name));
    console.log(`Applied: ${newlyApplied.length ? newlyApplied.join(", ") : "nothing (no migration was pending)"}`);
    check(
        before.tables.every((t) => after.tables.includes(t)),
        "Every table is still there",
        `Tables gone: ${before.tables.filter((t) => !after.tables.includes(t)).join(", ")}`,
    );
    check(
        before.indexes.every((i) => after.indexes.includes(i)),
        "Every index is still there",
        `Indexes gone: ${before.indexes.filter((i) => !after.indexes.includes(i)).join(", ")}`,
    );
    const changed = [];
    for (const table of before.tables) {
        // payload_migrations gains a row per migration applied: that is the one table expected to grow.
        if (table === "payload_migrations" || !after.rows[table]) continue;
        const b = before.rows[table];
        const a = after.rows[table];
        const missingColumns = b.columns.filter((c) => !a.columns.includes(c));
        if (missingColumns.length) changed.push(`${table}: columns gone (${missingColumns.join(", ")})`);
        else if (a.count !== b.count) changed.push(`${table}: ${b.count} rows before, ${a.count} after`);
        // Compared on the columns that existed before: new columns are allowed, a changed value is not.
        else if (a.hash(b.columns) !== b.hash(b.columns)) changed.push(`${table}: a row's existing values changed`);
    }
    check(
        changed.length === 0,
        `Every existing row is intact, value for value (${before.tables.length - 1} tables)`,
        `Existing data changed:\n  ${changed.join("\n  ")}`,
    );
    const added = after.tables.filter((t) => !before.tables.includes(t));
    console.log(`New tables: ${added.length ? added.join(", ") : "none"}`);
    for (const table of before.tables) {
        const extra = after.rows[table]?.columns.filter((c) => !before.rows[table].columns.includes(c)) ?? [];
        if (extra.length) console.log(`New columns on ${table}: ${extra.join(", ")}`);
    }
    check(query("PRAGMA quick_check")[0]?.quick_check === "ok", "SQLite's integrity check passes", "SQLite's integrity check failed");
    const orphans = query("PRAGMA foreign_key_check");
    check(orphans.length === 0, "No row points at a missing parent", `${orphans.length} rows point at a missing parent`);
} finally {
    rmSync(state, { recursive: true, force: true });
    if (hadState) renameSync(held, state);
}
console.log(failures ? `\n${failures} FAILED: do not apply this migration to production.` : "\nRehearsal passed.");
process.exit(failures ? 1 : 0);
