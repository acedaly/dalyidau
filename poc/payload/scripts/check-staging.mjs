// Proves the Payload staging Worker can't reach production. Run before every staging deploy.
//
//   node scripts/check-staging.mjs            # config only
//   node scripts/check-staging.mjs --online   # also lists the deployed Worker's secret NAMES (never values)
//
// Reads both configurations through Wrangler's own resolver (exactly what `wrangler deploy` would use)
// and fails on any shared database, bucket, Worker name, route, binding to another Worker, provider
// credential, or setting that would make staging publicly reachable.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { unstable_readConfig } from "wrangler";
import { STAGING_HOST } from "./staging-access.mjs";

const here = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(here, "../..");
const staging = unstable_readConfig({ config: path.join(here, "wrangler.jsonc"), env: "staging" });
const production = unstable_readConfig({ config: path.join(repo, "wrangler.jsonc") });
const oldStaging = unstable_readConfig({ config: path.join(repo, "wrangler.jsonc"), env: "staging" });
const poc = unstable_readConfig({ config: path.join(here, "wrangler.jsonc") });

let failures = 0;
const check = (ok, pass, fail) => {
    console.log(`${ok ? "  ✓" : "  ✗"} ${ok ? pass : fail}`);
    if (!ok) failures++;
};

const resources = (c) => ({
    names: new Set([c.name]),
    d1: new Set(c.d1_databases.flatMap((d) => [d.database_id, d.database_name])),
    r2: new Set(c.r2_buckets.map((b) => b.bucket_name)),
});
const mine = resources(staging);
console.log(`Checking "${staging.name}" against production ("${production.name}"), the existing staging ("${oldStaging.name}") and the local PoC\n`);

for (const [label, other] of [["production", production], ["existing staging", oldStaging], ["local PoC", poc]]) {
    const theirs = resources(other);
    check(!theirs.names.has(staging.name), `Worker name differs from ${label}`, `Worker name is ${label}'s`);
    const sharedD1 = [...mine.d1].filter((x) => theirs.d1.has(x));
    check(sharedD1.length === 0, `no D1 database shared with ${label}`, `D1 shared with ${label}: ${sharedD1.join(", ")}`);
    const sharedR2 = [...mine.r2].filter((x) => theirs.r2.has(x));
    check(sharedR2.length === 0, `no R2 bucket shared with ${label}`, `R2 shared with ${label}: ${sharedR2.join(", ")}`);
}
check(
    staging.d1_databases.every((d) => /^dalyidau-payload-staging-/.test(d.database_name) && !/^0{8}-/.test(d.database_id)),
    "every D1 database is a dalyidau-payload-staging-* database",
    "a D1 database isn't one of staging's own",
);
check(staging.r2_buckets.every((b) => /^dalyidau-payload-staging-/.test(b.bucket_name)), "every R2 bucket is a dalyidau-payload-staging-* bucket", "an R2 bucket isn't one of staging's own");

// Nothing public.
check(staging.workers_dev === false, "workers.dev is off", "workers.dev is on");
check(staging.preview_urls === false, "preview URLs are off", "preview URLs are on");
// Access mode (needs the owner's approval to switch on): exactly one route, the staging host, as a custom
// domain. deploy-staging.mjs then refuses to deploy until staging-access.mjs verify confirms Access covers it.
const routes = staging.routes ?? [];
export const accessMode = routes.length > 0;
if (!accessMode) check(!staging.route, "no routes or custom domains", "routes or custom domains are set");
else
    check(
        !staging.route && routes.length === 1 && routes[0].pattern === STAGING_HOST && routes[0].custom_domain === true,
        `access mode: only ${STAGING_HOST} (custom domain); Access is verified before every deploy`,
        `routes other than the single ${STAGING_HOST} custom domain are set`,
    );

// Nothing else to reach: no service bindings, queues, AI, KV, Durable Object bindings to other scripts, mTLS, etc.
const empty = (value) => value === undefined || (Array.isArray(value) ? value.length === 0 : Object.keys(value ?? {}).length === 0);
for (const key of ["services", "queues", "kv_namespaces", "vectorize", "hyperdrive", "mtls_certificates", "send_email", "dispatch_namespaces", "workflows", "analytics_engine_datasets", "secrets_store_secrets"]) {
    const value = key === "queues" ? [...(staging.queues?.producers ?? []), ...(staging.queues?.consumers ?? [])] : staging[key];
    check(empty(value), `no ${key} bindings`, `${key} bindings are set`);
}
check(!staging.ai, "no AI binding", "an AI binding is set (always remote, always billed)");
check(
    (staging.durable_objects?.bindings ?? []).every((b) => !b.script_name || b.script_name === staging.name),
    "no Durable Object bindings to other Workers",
    "a Durable Object binding points at another Worker",
);

// Behaviour.
const v = staging.vars;
check(v.ENVIRONMENT === "staging", 'ENVIRONMENT is "staging" (test keys and dev identities refused)', `ENVIRONMENT is "${v.ENVIRONMENT}"`);
check(v.EMAIL_DELIVERY === "log" && v.SMS_DELIVERY === "log", "email and SMS are logged, never sent", "a delivery provider is configured");
for (const key of ["WEDDING_URL", "PLANNER_URL"]) check(new URL(v[key]).hostname.endsWith(".invalid"), `${key} is an .invalid address`, `${key} is ${v[key]}`);
if (!accessMode) {
    check(new URL(v.SITE_URL).hostname.endsWith(".invalid"), "SITE_URL is an .invalid address", `SITE_URL is ${v.SITE_URL}`);
    check(/^(?:[^@,\s]+@example\.test,?)+$/.test(v.PORTAL_OWNER_EMAILS ?? ""), "owners are invented example.test addresses", "PORTAL_OWNER_EMAILS isn't invented");
} else {
    check(v.SITE_URL === `https://${STAGING_HOST}`, `SITE_URL is https://${STAGING_HOST}`, `SITE_URL is ${v.SITE_URL}`);
    // A real person signs in through Access, so their address is a secret, never in this public file.
    check(!("PORTAL_OWNER_EMAILS" in v), "owner addresses are a secret, not in vars", "PORTAL_OWNER_EMAILS is in vars: make it a secret");
}
for (const key of ["ACCESS_DEV_EMAIL", "ACCESS_DEV_ALT_EMAIL", "ACCESS_TEST_JWKS", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "MCP_ACCESS_AUD"]) {
    check(!(key in v), `${key} is not set`, `${key} is set in vars`);
}
check(staging.define?.["process.env.NODE_ENV"] === "\"production\"", "built as production (NODE_ENV)", "NODE_ENV isn't production");
check(/entry-staging\.ts$/.test(staging.main ?? ""), "entry is entry-staging.ts (outbound requests refused)", `entry is ${staging.main}`);

if (process.argv.includes("--online")) {
    // Names only. Anything here that isn't on this list (a provider token, an Access secret) fails.
    const ALLOWED = new Set(["PAYLOAD_SECRET", "PAYLOAD_JOBS_SECRET", "RSVP_LINK_SECRET", "COMMS_WEBHOOK_SECRET", ...(accessMode ? ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "PORTAL_OWNER_EMAILS"] : [])]);
    const out = execFileSync("npx", ["wrangler", "secret", "list", "--env", "staging", "--format", "json"], { cwd: here, encoding: "utf8" });
    const names = JSON.parse(out.slice(out.indexOf("["))).map((s) => s.name);
    const extra = names.filter((n) => !ALLOWED.has(n));
    check(extra.length === 0, `deployed secrets are only ${[...ALLOWED].join(", ")} (${names.length} set)`, `unexpected secrets: ${extra.join(", ")}`);
}

console.log(failures ? `\n${failures} problem(s). Don't deploy.` : "\nStaging is isolated from production.");
process.exit(failures ? 1 : 0);
