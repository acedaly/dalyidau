// Exports a D1 database to a SQL file and proves the file is a usable backup.
//
//   node scripts/db-backup.mjs --env production          # before every deploy that migrates
//   node scripts/db-backup.mjs --env staging
//   node scripts/db-backup.mjs --prune 5                 # keep only the newest 5 backups per environment
//
// Steps: export (read-only on the remote), record row counts, restore the file into a throwaway
// LOCAL database, re-run the integrity checks there and compare row counts. The backup and a
// manifest (sha256, counts) go to backups/, which is git-ignored.
//
// The file contains guests' personal details. backups/ and every file in it are created readable by
// your account only (0700/0600). Keep backups somewhere private and delete old ones once they're
// no longer needed (--prune, docs/PRIVACY.md). Restoring is documented in docs/DATABASE.md.
import { createHash } from "node:crypto";
import {
    appendFileSync,
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verify } from "./db-verify.mjs";
import { ROOT, Report, TABLES, countRows, d1Query, envFlag, parseArgs, wrangler } from "./lib/ops.mjs";
import { SHADOW_SUFFIXES, VIRTUAL_TABLE_REBUILDS } from "./lib/virtual-tables.mjs";

const args = parseArgs();
const dir = join(ROOT, "backups");
// Owner-only, including backups made before this was added.
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o600);

// --prune N: keep the newest N backups (and their manifests) per environment, delete the rest.
if (args.prune !== undefined) {
    const keep = Number(args.prune);
    if (!Number.isInteger(keep) || keep < 1) {
        console.error("--prune needs the number of backups to keep per environment, e.g. --prune 5");
        process.exit(1);
    }
    const byEnv = new Map();
    for (const name of readdirSync(dir)
        .filter((n) => n.endsWith(".sql"))
        .sort()
        .reverse()) {
        const envName = name.replace(/-\d{4}-\d{2}-\d{2}T.*$/, "");
        byEnv.set(envName, [...(byEnv.get(envName) ?? []), name]);
    }
    for (const [envName, names] of byEnv)
        for (const name of names.slice(keep)) {
            rmSync(join(dir, name), { force: true });
            rmSync(join(dir, `${name}.json`), { force: true });
            console.log(`Deleted ${envName} backup ${name}`);
        }
    process.exit(0);
}

// --local [--persist-to dir] backs up a local database instead (used to test this script).
const local = !!args.local;
const env = local ? "local" : (args.env ?? "production");
const source = local ? { remote: false, persistTo: args["persist-to"] } : { remote: true };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = join(dir, `${env}-${stamp}.sql`);
const report = new Report();

console.log(`Backing up the ${env} database to ${file}\n`);

// 1. The schema and row counts on the live database, just before the export.
const schema = d1Query(env, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid", source)[0];
const tables = new Set(schema.filter((r) => r.type === "table").map((r) => r.name));
const present = TABLES.filter((t) => tables.has(t));
const remoteCounts = countRows(env, present, source);
// `wrangler d1 export` refuses a database with any virtual table (FTS5 search), so those, and the
// shadow tables FTS5 keeps their data in, are rebuilt after a restore instead of exported.
const virtual = schema.filter((r) => r.type === "table" && /^CREATE VIRTUAL TABLE/i.test(r.sql ?? ""));
const derived = new Set(virtual.flatMap((v) => [v.name, ...SHADOW_SUFFIXES.map((suffix) => `${v.name}${suffix}`)]));
const internal = (name) => /^(sqlite_|_cf_)/.test(name);
const schemaObjects = (rows) =>
    rows
        .filter((r) => !internal(r.name) && !(r.type === "index" && !r.sql))
        .map((r) => `${r.type} ${r.name}`)
        .sort();

// 2. Export.
// `d1 export` has no --persist-to, so a local export from a custom state directory runs from a
// temporary working directory whose .wrangler/state points at it.
let exportCwd = null;
if (local && source.persistTo) {
    exportCwd = mkdtempSync(join(tmpdir(), "dalyidau-export-"));
    copyFileSync(join(ROOT, "wrangler.jsonc"), join(exportCwd, "wrangler.jsonc"));
    mkdirSync(join(exportCwd, ".wrangler"));
    symlinkSync(resolve(source.persistTo), join(exportCwd, ".wrangler", "state"));
}
const ordinary = schema.filter((r) => r.type === "table" && !derived.has(r.name) && !internal(r.name)).map((r) => r.name);
const exported = wrangler([
    "d1",
    "export",
    "DB",
    ...(local ? ["--local", "--env="] : ["--remote", envFlag(env).replace(/"/g, "")]),
    ...(exportCwd ? ["--cwd", exportCwd] : []),
    // With virtual tables present, name every ordinary table: the only export D1 allows.
    ...(virtual.length ? ordinary.flatMap((t) => ["--table", t]) : []),
    "--output",
    file,
]);
if (exported.ok && virtual.length) {
    // A per-table export has the tables and their rows but not indexes, triggers or views.
    const extras = schema.filter((r) => ["index", "trigger", "view"].includes(r.type) && r.sql && !derived.has(r.tbl_name) && !internal(r.name));
    const rebuilds = virtual.map((v) => {
        const statements = VIRTUAL_TABLE_REBUILDS[v.name];
        if (!statements) report.warn(`${v.name} has no rebuild statement: it will be restored empty`);
        return [`${v.sql};`, ...(statements ?? []).map((sql) => `${sql};`)].join("\n");
    });
    appendFileSync(
        file,
        [
            "",
            "-- Indexes, triggers and views (not included in a per-table export).",
            ...extras.map((r) => `${r.sql};`),
            "-- Virtual tables, recreated and rebuilt from the tables above.",
            ...rebuilds,
            "",
        ].join("\n"),
    );
    report.info(`Exported ${ordinary.length} tables; ${virtual.map((v) => v.name).join(", ")} rebuilt on restore`);
}
if (exportCwd) rmSync(exportCwd, { recursive: true, force: true });
if (!exported.ok) {
    report.fail("Export failed");
    report.finish();
    process.exit(1);
}
chmodSync(file, 0o600);
const bytes = statSync(file).size;
const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
report.check(bytes > 0, `Exported ${(bytes / 1024).toFixed(1)} KB (sha256 ${sha256.slice(0, 16)}…)`, "The export is empty");

// 3. Restore into a throwaway local database and check it.
const scratch = mkdtempSync(join(tmpdir(), "dalyidau-backup-check-"));
try {
    const restored = wrangler(["d1", "execute", "DB", "--local", "--env=", "--persist-to", scratch, "--file", file, "--yes"], { quiet: true });
    report.check(restored.ok, "The backup restores into an empty database", `The backup doesn't restore: ${restored.stderr.split("\n").find((l) => l.trim())}`);
    if (restored.ok) {
        const localCounts = countRows("local", present, { remote: false, persistTo: scratch });
        const mismatched = present.filter((t) => localCounts[t] !== remoteCounts[t]);
        // A write between counting and exporting can legitimately add rows; fewer rows never can.
        const lost = mismatched.filter((t) => (localCounts[t] ?? 0) < remoteCounts[t]);
        report.check(lost.length === 0, "Every table has at least as many rows as the live database", `Rows missing from the backup in: ${lost.join(", ")}`);
        if (mismatched.length && !lost.length) report.warn(`Row counts changed while exporting (${mismatched.join(", ")}); the backup is newer, not short.`);
        const restoredSchema = schemaObjects(d1Query("local", "SELECT type, name, tbl_name, sql FROM sqlite_master", { remote: false, persistTo: scratch })[0]);
        const absent = schemaObjects(schema).filter((name) => !restoredSchema.includes(name));
        report.check(
            absent.length === 0,
            "Every table, index, trigger and view is in the restored copy",
            `Missing from the restored copy: ${absent.join(", ")}`,
        );
        await verify({ env: "local", remote: false, persistTo: scratch, report });
    }
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

writeFileSync(
    `${file}.json`,
    JSON.stringify(
        { env, createdAt: new Date().toISOString(), file: file.replace(`${ROOT}/`, ""), bytes, sha256, rowCounts: remoteCounts, ok: report.failures === 0 },
        null,
        2,
    ),
    { mode: 0o600 },
);
report.info(`Manifest: ${file}.json`);
report.finish();
