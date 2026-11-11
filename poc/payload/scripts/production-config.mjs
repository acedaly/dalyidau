// Checks the combined Worker's production config (poc/payload/wrangler.jsonc env.production) against
// production's real config (the repository root's wrangler.jsonc): a deploy may add Payload's bindings,
// flags and run_worker_first, and must change nothing else. Exits 1 on any difference. CI runs it
// before every production deploy (.github/workflows/deploy.yml).
//
//   node scripts/production-config.mjs
import path from "node:path";
import { unstable_readConfig } from "wrangler";

const here = path.resolve(import.meta.dirname, "..");
const root = unstable_readConfig({ config: path.join(here, "../../wrangler.jsonc") });
const combined = unstable_readConfig({ config: path.join(here, "wrangler.jsonc"), env: "production" });

let problems = 0;
const line = (ok, text) => {
    if (!ok) problems++;
    console.log(`${ok ? "  ✓" : "  ✗"} ${text}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const strip = (list, keys) => (list ?? []).map((item) => Object.fromEntries(keys.map((k) => [k, item[k] ?? null])));
const byBinding = (list, binding) => (list ?? []).find((b) => b.binding === binding);

console.log(`Combined Worker "${combined.name}" against production "${root.name}"\n`);
line(combined.name === root.name, `name ${combined.name} (same Worker: rollback history and the MCP gateway's service binding carry over)`);
line(same(strip(combined.routes, ["pattern", "custom_domain"]), strip(root.routes, ["pattern", "custom_domain"])), `routes ${combined.routes.map((r) => r.pattern).join(", ")}`);
line(same(combined.triggers?.crons, root.triggers?.crons), `crons ${combined.triggers?.crons?.join(", ")}`);
line(same(combined.vars, root.vars), `${Object.keys(combined.vars).length} vars identical (ENVIRONMENT=${combined.vars.ENVIRONMENT})`);
line(combined.compatibility_date === root.compatibility_date, `compatibility date ${combined.compatibility_date} (production ${root.compatibility_date})`);
line(combined.workers_dev === false && combined.preview_urls === false, "workers.dev and preview URLs off");
line(combined.keep_vars === root.keep_vars, `keep_vars ${combined.keep_vars}`);
line(same(combined.observability, root.observability), "observability identical (query strings redacted)");
line(same(combined.define, root.define), "define identical");
const db = byBinding(combined.d1_databases, "DB");
const rootDb = byBinding(root.d1_databases, "DB");
line(db?.database_id === rootDb?.database_id && db?.database_name === rootDb?.database_name, `DB → ${db?.database_name} (the site and wedding database, unchanged)`);
line(path.resolve(here, db?.migrations_dir ?? "") === path.resolve(here, "../../migrations"), "DB migrations are the repository's own (applied from the root config, never from here)");
line(same(byBinding(combined.r2_buckets, "MEDIA")?.bucket_name, byBinding(root.r2_buckets, "MEDIA")?.bucket_name), `MEDIA → ${byBinding(combined.r2_buckets, "MEDIA")?.bucket_name}`);
for (const kind of ["services", "kv_namespaces", "queues", "durable_objects", "ai", "vectorize", "send_email", "workflows"]) {
    const a = combined[kind];
    const b = root[kind];
    line(same(a?.bindings ?? a ?? [], b?.bindings ?? b ?? []), `${kind}: same as production`);
}

console.log("\nPayload's additions:");
const d1 = byBinding(combined.d1_databases, "D1");
line(d1?.database_name === "dalyidau-payload" && d1.database_id !== rootDb?.database_id, `D1 → ${d1?.database_name} (Payload's own database, never the site's)`);
line(byBinding(combined.r2_buckets, "R2")?.bucket_name === "dalyidau-payload-media", "R2 → dalyidau-payload-media (Payload's own bucket)");
line(combined.d1_databases.length === 2 && combined.r2_buckets.length === 2, "no other database or bucket");
line(same([...combined.compatibility_flags].sort(), ["global_fetch_strictly_public", "nodejs_compat"]), `flags ${combined.compatibility_flags.join(", ")}`);
line(combined.assets?.run_worker_first === true && combined.assets?.binding === "ASSETS", "assets: run_worker_first (the Worker decides what each host may reach)");
line(/platform\/entry\.ts$/.test(combined.main), `main ${path.relative(here, combined.main)}`);

console.log(problems ? `\n${problems} problem(s): don't deploy.` : "\nProduction config OK: only Payload's additions differ.");
process.exit(problems ? 1 : 0);
