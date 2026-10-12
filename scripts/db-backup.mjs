// Exports a D1 database to a SQL file and proves the file is a usable backup.
//
//   node scripts/db-backup.mjs --env production          # before every deploy that migrates
//   node scripts/db-backup.mjs --env staging
//
// Steps: export (read-only on the remote), record row counts, restore the file into a throwaway
// LOCAL database, re-run the integrity checks there and compare row counts. The backup and a
// manifest (sha256, counts) go to backups/, which is git-ignored.
//
// The file contains guests' personal details. Keep it somewhere private, and delete old backups
// once they're no longer needed (docs/PRIVACY.md). Restoring is documented in docs/DATABASE.md.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verify } from "./db-verify.mjs";
import { ROOT, Report, TABLES, countRows, d1Query, envFlag, parseArgs, wrangler } from "./lib/ops.mjs";

const args = parseArgs();
// --local [--persist-to dir] backs up a local database instead (used to test this script).
const local = !!args.local;
const env = local ? "local" : (args.env ?? "production");
const source = local ? { remote: false, persistTo: args["persist-to"] } : { remote: true };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(ROOT, "backups");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${env}-${stamp}.sql`);
const report = new Report();

console.log(`Backing up the ${env} database to ${file}\n`);

// 1. Row counts on the live database, just before the export.
const tables = new Set(d1Query(env, "SELECT name FROM sqlite_master WHERE type = 'table'", source)[0].map((r) => r.name));
const present = TABLES.filter((t) => tables.has(t));
const remoteCounts = countRows(env, present, source);

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
const exported = wrangler([
    "d1",
    "export",
    "DB",
    ...(local ? ["--local", "--env="] : ["--remote", envFlag(env).replace(/"/g, "")]),
    ...(exportCwd ? ["--cwd", exportCwd] : []),
    "--output",
    file,
]);
if (exportCwd) rmSync(exportCwd, { recursive: true, force: true });
if (!exported.ok) {
    report.fail("Export failed");
    report.finish();
    process.exit(1);
}
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
);
report.info(`Manifest: ${file}.json`);
report.finish();
