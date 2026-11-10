// Rehearses the production cutover and rollback on the isolated staging Worker, with invented data:
//   1. today's Worker (no Payload) deployed, as production runs now;
//   2. cutover: the combined Worker deployed over it;
//   3. rollback: `wrangler rollback` to step 1's version;
//   4. roll forward to the combined Worker (staging is left as it was found).
// At every step it fingerprints the wedding tables in the staging wedding D1 (row counts and a hash of
// every row, read-only), so "no loss or corruption" is checked rather than assumed, and it times each step.
//   node scripts/rehearse-cutover.mjs     (staging only; uses scripts/deploy-staging.mjs for deploys)
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = path.resolve(import.meta.dirname, "..");
const DB = "dalyidau-payload-staging-wedding"; // staging's own; check-staging.mjs proves it isn't production's
const TABLES = ["households", "guests", "guest_events", "rsvp_submissions", "rsvp_answers", "rsvp_travel", "messages", "message_recipients", "portal_users", "feature_flags", "settings", "audit_log"];
const env = { ...process.env, OPEN_NEXT_DEPLOY: "true" };
const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], { cwd: here, encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });

function fingerprint() {
    // One API call for all tables (Cloudflare rate-limits the API: error 7429).
    const raw = wrangler(["d1", "execute", DB, "--remote", "--env", "staging", "--json", "--command", TABLES.map((t) => `SELECT * FROM ${t} ORDER BY rowid`).join("; ")]);
    const results = JSON.parse(raw.slice(raw.indexOf("[")));
    const out = {};
    TABLES.forEach((table, i) => {
        const rows = results[i].results;
        out[table] = { rows: rows.length, sha: createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16) };
    });
    return out;
}
const activeVersion = () => [...wrangler(["deployments", "list", "--env", "staging"]).matchAll(/Version\(s\):\s+\(100%\)\s+([0-9a-f-]{36})/g)].at(-1)?.[1];
function deploy(label, extra = []) {
    const started = Date.now();
    let result = spawnSync("node", ["scripts/deploy-staging.mjs", ...extra], { cwd: here, encoding: "utf8" });
    if (result.status !== 0) {
        console.log(`${label}: deploy failed once (Cloudflare API); retrying`);
        result = spawnSync("node", ["scripts/deploy-staging.mjs", ...extra], { cwd: here, encoding: "utf8" });
    }
    if (result.status !== 0) throw new Error(`${label} failed:\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`);
    const startup = /Worker Startup Time: (\d+) ms/.exec(result.stdout)?.[1];
    return { seconds: Math.round((Date.now() - started) / 1000), startupMs: startup ? Number(startup) : null, version: activeVersion() };
}
function rollback(version, message) {
    const started = Date.now();
    wrangler(["rollback", version, "--env", "staging", "--message", message, "-y"]);
    return { seconds: Math.round((Date.now() - started) / 1000), version: activeVersion() };
}

const steps = [];
const record = (step, detail) => {
    const data = fingerprint();
    steps.push({ step, ...detail, data });
    console.log(`${step.padEnd(34)} version ${detail.version?.slice(0, 8)}  ${detail.seconds ?? "-"} s  startup ${detail.startupMs ?? "-"} ms  guests ${data.guests.rows}  audit ${data.audit_log.rows}`);
};

record("0. before (as found)", { version: activeVersion() });
const baseline = deploy("baseline", ["--baseline"]);
record("1. today's Worker (no Payload)", baseline);
const combined = deploy("cutover");
record("2. cutover to combined Worker", combined);
record("3. rollback to today's Worker", rollback(baseline.version, "rehearsal: rollback to pre-Payload version"));
record("4. roll forward to combined", rollback(combined.version, "rehearsal: roll forward"));
execFileSync("node", ["scripts/check-staging.mjs", "--online"], { cwd: here, stdio: "ignore" });

const same = steps.every((s) => JSON.stringify(s.data) === JSON.stringify(steps[0].data));
console.log(same ? "\nWedding data identical at every step (row counts and row hashes)." : "\nWEDDING DATA CHANGED between steps: see the JSON report.");
mkdirSync(path.join(here, ".poc-results"), { recursive: true });
const file = path.join(here, ".poc-results", `rehearsal-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ steps, same }, null, 2));
console.log(`Report: ${path.relative(process.cwd(), file)}`);
process.exit(same ? 0 : 1);
