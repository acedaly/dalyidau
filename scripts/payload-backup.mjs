// Backs up Payload's D1 database (dalyidau-payload: the blog, pages, projects, homepage, navigation,
// settings, users and media records) and proves the file restores. docs/PAYLOAD-BACKUP.md.
//
//   node scripts/payload-backup.mjs                      # production (read-only on the remote)
//   node scripts/payload-backup.mjs --database dalyidau-payload-staging
//
// Steps: count every table's rows on the remote, export, reorder the export so it restores
// (scripts/d1-export-reorder.py: D1 exports a child table's rows before its parent table), restore the
// reordered file into a throwaway LOCAL database, then compare every table's row count, the schema and
// SQLite's integrity and foreign-key checks. The restorable file, the raw export and a manifest go to
// backups/ (git-ignored, owner-only). Nothing is written to the remote database.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, Report, parseArgs, wrangler } from "./lib/ops.mjs";

const args = parseArgs();
const database = typeof args.database === "string" ? args.database : "dalyidau-payload";
const dir = join(ROOT, "backups");
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o600);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const raw = join(dir, `${database}-${stamp}.export.sql`);
const file = join(dir, `${database}-${stamp}.sql`);
const report = new Report();

// A scratch config naming only this database, so local commands can't touch anything else.
const scratch = mkdtempSync(join(tmpdir(), "dalyidau-payload-backup-"));
const config = join(scratch, "wrangler.json");
writeFileSync(
    config,
    JSON.stringify({
        name: "payload-backup-check",
        compatibility_date: "2025-01-01",
        d1_databases: [{ binding: "D1", database_name: database, database_id: "00000000-0000-0000-0000-000000000000" }],
    }),
);
const state = join(scratch, "state");

const query = (sql, remote) => {
    const target = remote ? ["--remote"] : ["--local", "--config", config, "--persist-to", state];
    const result = wrangler(["d1", "execute", database, ...target, "--json", "--command", sql], { quiet: true });
    if (!result.ok) {
        let detail = (result.stderr || result.stdout).trim();
        try {
            const { error } = JSON.parse(result.stdout);
            detail = [error.text, ...(error.notes ?? []).map((n) => n.text)].join(" ");
        } catch {}
        throw new Error(detail || "wrangler failed");
    }
    return JSON.parse(result.stdout).map((r) => r.results ?? []);
};
const internal = (name) => /^(sqlite_|_cf_)/.test(name);
const schemaOf = (remote) =>
    query("SELECT type, name FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name", remote)[0].filter((r) => !internal(r.name));
const countsOf = (tables, remote) => {
    if (!tables.length) return {};
    // One statement per table: D1 refuses a long compound SELECT.
    const sql = tables.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM "${t}";`).join(" ");
    return Object.fromEntries(query(sql, remote).map(([r]) => [r.t, r.n]));
};

console.log(`Backing up ${database} to ${file}\n`);
try {
    // 1. Schema and row counts on the live database, just before the export.
    const schema = schemaOf(true);
    const tables = schema.filter((r) => r.type === "table").map((r) => r.name);
    const remoteCounts = countsOf(tables, true);
    report.info(`${tables.length} tables, ${Object.values(remoteCounts).reduce((a, b) => a + b, 0)} rows on the remote`);

    // 2. Export (read-only), then reorder.
    const exported = wrangler(["d1", "export", database, "--remote", "--output", raw]);
    if (!exported.ok) throw new Error("Export failed");
    chmodSync(raw, 0o600);
    const reordered = spawnSync("python3", ["-I", join(ROOT, "scripts", "d1-export-reorder.py"), raw], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    if (reordered.status !== 0) throw new Error(`Reordering failed: ${reordered.stderr}`);
    writeFileSync(file, reordered.stdout, { mode: 0o600 });
    const bytes = statSync(file).size;
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    report.check(bytes > 0, `Exported ${(bytes / 1024).toFixed(1)} KB (sha256 ${sha256.slice(0, 16)}…)`, "The export is empty");

    // 3. Restore into a throwaway local database and compare.
    const restored = wrangler(["d1", "execute", database, "--local", "--config", config, "--persist-to", state, "--file", file, "--yes"], { quiet: true });
    report.check(restored.ok, "The backup restores into an empty database", `The backup doesn't restore: ${restored.stderr.split("\n").find((l) => l.trim())}`);
    let ok = restored.ok;
    if (restored.ok) {
        const localCounts = countsOf(tables, false);
        const lost = tables.filter((t) => (localCounts[t] ?? -1) < remoteCounts[t]);
        const changed = tables.filter((t) => localCounts[t] !== remoteCounts[t]);
        report.check(
            lost.length === 0,
            `Every table's rows are in the restored copy (${tables.length} tables)`,
            `Rows missing from the backup in: ${lost.join(", ")}`,
        );
        if (changed.length && !lost.length) report.warn(`Row counts changed while exporting (${changed.join(", ")}); the backup is newer, not short.`);
        const restoredNames = new Set(schemaOf(false).map((r) => `${r.type} ${r.name}`));
        const absent = schema.map((r) => `${r.type} ${r.name}`).filter((n) => !restoredNames.has(n));
        report.check(absent.length === 0, "Every table and index is in the restored copy", `Missing from the restored copy: ${absent.join(", ")}`);
        const integrity = query("PRAGMA quick_check", false)[0];
        report.check(integrity.length === 1 && integrity[0].quick_check === "ok", "SQLite quick check: ok", `Integrity check: ${JSON.stringify(integrity)}`);
        const orphans = query("PRAGMA foreign_key_check", false)[0];
        report.check(orphans.length === 0, "No rows point at missing parents", `Foreign-key problems: ${JSON.stringify(orphans.slice(0, 5))}`);
        ok = lost.length === 0 && absent.length === 0 && orphans.length === 0;
    }
    writeFileSync(
        `${file}.json`,
        JSON.stringify(
            {
                database,
                createdAt: new Date().toISOString(),
                file: file.replace(`${ROOT}/`, ""),
                rawExport: raw.replace(`${ROOT}/`, ""),
                bytes,
                sha256,
                rowCounts: remoteCounts,
                ok: ok && report.failures === 0,
            },
            null,
            2,
        ),
        { mode: 0o600 },
    );
    report.info(`Manifest: ${file}.json`);
} catch (error) {
    report.fail(error instanceof Error ? error.message : String(error));
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
report.finish();
