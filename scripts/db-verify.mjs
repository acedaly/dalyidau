// Read-only health check of a D1 database: migrations applied, foreign keys, and the app's own
// integrity rules. Safe to run against production; it never writes.
//
//   node scripts/db-verify.mjs --env production      # the live database (remote)
//   node scripts/db-verify.mjs --env staging
//   node scripts/db-verify.mjs --local [--persist-to .wrangler/state]
import { INTEGRITY_CHECKS, Report, countRows, d1Query, migrationFiles, parseArgs } from "./lib/ops.mjs";

export async function verify({ env, remote, persistTo, report = new Report() }) {
    const query = (sql) => d1Query(env, sql, { remote, persistTo })[0];

    // Migrations
    const expected = migrationFiles();
    let applied = [];
    try {
        applied = query("SELECT name FROM d1_migrations ORDER BY id").map((r) => r.name);
    } catch (error) {
        report.fail(`Couldn't read d1_migrations: ${error.message}`);
        return report;
    }
    const missing = expected.filter((m) => !applied.includes(m));
    const unknown = applied.filter((m) => !expected.includes(m));
    report.check(missing.length === 0, `All ${expected.length} migrations applied`, `Not yet applied: ${missing.join(", ")}`, "warn");
    report.check(
        unknown.length === 0,
        "No migrations applied that this checkout doesn't know about",
        `Applied but not in this checkout: ${unknown.join(", ")}`,
    );
    const prefix = applied.every((name, i) => name === expected[i]);
    report.check(prefix, "Migrations were applied in order", "Migrations were applied out of order");

    // Only run portal checks once the portal tables exist.
    const tables = new Set(query("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
    try {
        const quick = query("PRAGMA quick_check");
        const ok = quick.length === 1 && Object.values(quick[0])[0] === "ok";
        report.check(ok, "SQLite quick_check: ok", `SQLite quick_check reported: ${JSON.stringify(quick).slice(0, 200)}`);
    } catch {
        report.info("quick_check isn't available on this database");
    }
    for (const check of INTEGRITY_CHECKS) {
        const needs = [...check.sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)].map((m) => m[1]).filter((t) => !t.startsWith("pragma"));
        if (needs.some((t) => !tables.has(t))) continue;
        let rows;
        try {
            rows = query(check.sql);
        } catch (error) {
            report.warn(`${check.name}: couldn't run (${error.message})`);
            continue;
        }
        report.check(rows.length === 0, check.name, `${check.name}: ${rows.length} problem row(s), e.g. ${JSON.stringify(rows.slice(0, 3))}`, check.level);
    }

    // Sizes, for a sense of scale (counts only, never contents).
    const counts = ["guests", "households", "events", "audit_log", "posts"].filter((t) => tables.has(t));
    if (counts.length) {
        const sizes = countRows(env, counts, { remote, persistTo });
        report.info(counts.map((t) => `${t}: ${sizes[t]}`).join(" · "));
    }
    return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = parseArgs();
    const local = !!args.local;
    const env = local ? "local" : (args.env ?? "production");
    console.log(`Verifying ${local ? "the local" : `the ${env} (remote)`} database\n`);
    const report = await verify({ env, remote: !local, persistTo: args["persist-to"] });
    report.finish();
}
