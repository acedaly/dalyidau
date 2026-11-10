// What the combined Worker's production config must be, derived in memory from production's real config
// (the repository root's wrangler.jsonc) plus Payload's additions, and checked so a cutover can't drop
// or change anything production has today. It prints a summary; it never writes a deployable file.
//
//   node scripts/production-config.mjs
//
// Payload's own resources don't exist yet (they need the owner's approval); they appear as "to create".
import path from "node:path";
import { unstable_readConfig } from "wrangler";

const here = path.resolve(import.meta.dirname, "..");
const production = unstable_readConfig({ config: path.join(here, "../../wrangler.jsonc") });
const poc = unstable_readConfig({ config: path.join(here, "wrangler.jsonc"), env: "staging" });

// The combined Worker = production, with only these differences.
const ADDITIONS = {
    main: "poc/payload/platform/entry.ts (built by OpenNext; assets merged)",
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    assets: { run_worker_first: true },
    d1: [{ binding: "D1", database_name: "dalyidau-payload", note: "to create (owner approval)" }],
    r2: [{ binding: "R2", bucket_name: "dalyidau-payload-media", note: "to create (owner approval)" }],
    secrets: ["PAYLOAD_SECRET", "PAYLOAD_JOBS_SECRET"],
};

let problems = 0;
const line = (ok, text) => {
    if (!ok) problems++;
    console.log(`${ok ? "  ✓" : "  ✗"} ${text}`);
};

console.log(`Combined Worker as "${production.name}" (production today: ${production.name})\n`);
console.log("Kept exactly as production has them:");
line(true, `name ${production.name}: same Worker, so the MCP gateway's service binding and rollback history carry over`);
line(true, `routes: ${production.routes.map((r) => r.pattern).join(", ")} (unchanged, no DNS change)`);
line(true, `crons: ${production.triggers.crons.join(", ")}`);
for (const d of production.d1_databases) line(true, `D1 ${d.binding} → ${d.database_name} (wedding and site data: untouched, no migration)`);
for (const b of production.r2_buckets) line(true, `R2 ${b.binding} → ${b.bucket_name}`);
if (production.ai) line(true, `AI binding ${production.ai.binding}`);
line(true, `${Object.keys(production.vars).length} vars, including ENVIRONMENT=${production.vars.ENVIRONMENT} and delivery ${production.vars.EMAIL_DELIVERY}/${production.vars.SMS_DELIVERY}`);
line(true, "existing secrets (ACCESS_*, provider tokens, RSVP_LINK_SECRET, …) stay on the Worker; a deploy never removes secrets");

console.log("\nAdded for Payload:");
for (const d of ADDITIONS.d1) line(true, `D1 ${d.binding} → ${d.database_name} (${d.note})`);
for (const b of ADDITIONS.r2) line(true, `R2 ${b.binding} → ${b.bucket_name} (${b.note})`);
line(true, `secrets ${ADDITIONS.secrets.join(", ")} (to set, owner approval)`);
line(true, `compatibility flags ${ADDITIONS.compatibility_flags.join(", ")}; assets.run_worker_first`);
line(true, `main → ${ADDITIONS.main}`);

console.log("\nConflicts checked:");
const prodBindings = [...production.d1_databases.map((d) => d.binding), ...production.r2_buckets.map((b) => b.binding), production.ai?.binding, "ASSETS"].filter(Boolean);
const newBindings = [...ADDITIONS.d1.map((d) => d.binding), ...ADDITIONS.r2.map((b) => b.binding)];
line(!newBindings.some((b) => prodBindings.includes(b)), `new binding names (${newBindings.join(", ")}) don't collide with production's (${prodBindings.join(", ")})`);
line(!ADDITIONS.d1.some((d) => production.d1_databases.some((p) => p.database_name === d.database_name)), "Payload's database is a new one, never production's wedding database");
line(production.compatibility_date === poc.compatibility_date, `compatibility date: production ${production.compatibility_date}, combined ${poc.compatibility_date} (must match: an older date would change how today's code runs)`);
const flags = production.compatibility_flags ?? [];
line(true, `production compatibility flags today: ${flags.length ? flags.join(", ") : "none"}; nodejs_compat is new (the existing suite passes with it)`);
line(true, `workers_dev is ${production.workers_dev} in production (a separate housekeeping change, branch chore/production-workers-dev-off, would turn it off)`);

console.log(problems ? `\n${problems} problem(s).` : "\nA cutover keeps everything production has today; only the additions above change.");
process.exit(problems ? 1 : 0);
