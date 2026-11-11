// Fingerprints the wedding's records in a D1 database, read-only, so a deploy can prove it left them alone.
//
//   node scripts/wedding-fingerprint.mjs capture <file> [--db dalyidau-production]
//   node scripts/wedding-fingerprint.mjs compare <before> <after>
//
// For each wedding table: the row count and a SHA-256 over every row (ORDER BY rowid). Only counts and
// hashes are written, never guests' details. Guests can RSVP at any time, so a difference isn't
// automatically a fault: `compare` names the tables that changed, and the audit log tells you why.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const WEDDING_TABLES = [
    "households",
    "guests",
    "events",
    "guest_events",
    "rsvp_submissions",
    "rsvp_questions",
    "rsvp_answers",
    "rsvp_travel",
    "seating_tables",
    "seat_assignments",
    "seating_snapshots",
    "message_templates",
    "messages",
    "message_recipients",
    "sms_messages",
    "invitation_artifacts",
    "guest_imports",
    "guest_import_rows",
    "tasks",
    "timeline_items",
    "suppliers",
    "budget_items",
    "portal_users",
    "audit_log",
];

const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

function capture(file, db) {
    const fingerprint = {};
    // Six tables per call: one call for everything is too big a response, one per table trips the API's rate limit.
    for (let i = 0; i < WEDDING_TABLES.length; i += 6) {
        const batch = WEDDING_TABLES.slice(i, i + 6);
        const r = spawnSync("npx", ["wrangler", "d1", "execute", db, "--remote", "--json", "--command", batch.map((t) => `SELECT * FROM ${t} ORDER BY rowid`).join("; ")], {
            encoding: "utf8",
            maxBuffer: 512 * 1024 * 1024,
        });
        if (r.status !== 0) throw new Error(`wrangler failed: ${r.stderr.slice(0, 500)}`);
        JSON.parse(r.stdout).forEach((result, j) => {
            const rows = result.results;
            fingerprint[batch[j]] = { rows: rows.length, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
        });
    }
    writeFileSync(file, JSON.stringify({ db, takenAt: new Date().toISOString(), tables: fingerprint }, null, 2), { mode: 0o600 });
    console.log(Object.entries(fingerprint).map(([t, f]) => `${t}:${f.rows}`).join(" · "));
}

function compare(a, b) {
    const x = JSON.parse(readFileSync(a, "utf8"));
    const y = JSON.parse(readFileSync(b, "utf8"));
    const changed = WEDDING_TABLES.filter((t) => JSON.stringify(x.tables[t]) !== JSON.stringify(y.tables[t]));
    for (const t of changed) console.log(`changed: ${t} ${x.tables[t]?.rows} → ${y.tables[t]?.rows} rows`);
    console.log(changed.length ? `${changed.length} wedding table(s) changed between ${x.takenAt} and ${y.takenAt}` : `✓ all ${WEDDING_TABLES.length} wedding tables identical`);
    process.exitCode = changed.length ? 1 : 0;
}

if (args[0] === "capture") capture(args[1], flag("--db", "dalyidau-production"));
else if (args[0] === "compare") compare(args[1], args[2]);
else {
    console.error("usage: capture <file> [--db name] | compare <before> <after>");
    process.exit(2);
}
