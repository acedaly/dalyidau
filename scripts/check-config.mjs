// Checks that an environment is configured safely for the portal, without printing any secret.
//
//   node scripts/check-config.mjs                       # production config + secret names
//   node scripts/check-config.mjs --env staging
//   node scripts/check-config.mjs --url https://daly.id.au --team <team>.cloudflareaccess.com
//   node scripts/check-config.mjs --env staging --offline     # config file only (used in CI)
//
// It reads wrangler.jsonc, lists secret NAMES with `wrangler secret list` (values are never fetched),
// and optionally probes the live URL without credentials to confirm the portal refuses access.
import { Report, envFlag, environmentConfig, parseArgs, readWranglerConfig, wrangler } from "./lib/ops.mjs";

const args = parseArgs();
const env = args.env ?? "production";
const report = new Report();
const config = readWranglerConfig();
const target = environmentConfig(config, env);
const production = environmentConfig(config, "production");

console.log(`Checking ${env} (Worker "${target.name}")\n`);

// --- wrangler.jsonc ---------------------------------------------------------------------------------

report.check(target.vars.ENVIRONMENT === env, `ENVIRONMENT is "${env}"`, `ENVIRONMENT is "${target.vars.ENVIRONMENT}", expected "${env}"`);
for (const name of ["ACCESS_DEV_EMAIL", "ACCESS_DEV_ALT_EMAIL", "ACCESS_TEST_JWKS", "RSVP_LINK_SECRET", "AI_PROVIDER"]) {
    report.check(!(name in target.vars), `${name} is not set in vars`, `${name} is set in vars: remove it, it is for local development/tests only`);
}
// Provider credentials are secrets; a plain var would be visible in the dashboard and in wrangler.jsonc.
for (const name of [
    "FASTMAIL_API_TOKEN",
    "SMTP_USERNAME",
    "SMTP_PASSWORD",
    "SMTP2GO_API_KEY",
    "CLICKSEND_USERNAME",
    "CLICKSEND_API_KEY",
    "COMMS_WEBHOOK_SECRET",
]) {
    report.check(
        !(name in target.vars),
        `${name} is not a plain var`,
        `${name} is set in vars: make it a secret (npx wrangler secret put ${name} ${envFlag(env)})`,
    );
}
const delivery = target.vars.EMAIL_DELIVERY ?? "off";
report.check(
    delivery !== "log",
    `EMAIL_DELIVERY is "${delivery}"`,
    `EMAIL_DELIVERY is "log", which only works outside production`,
    env === "production" ? "fail" : "warn",
);

const sms = target.vars.SMS_DELIVERY ?? "off";
report.check(sms !== "log", `SMS_DELIVERY is "${sms}"`, `SMS_DELIVERY is "log", which only works outside production`, env === "production" ? "fail" : "warn");

// Daly Intelligence (docs/INTELLIGENCE.md): bindings are optional and their absence keeps every AI feature off.
const block = env === "production" ? config : (config.env?.[env] ?? {});
const ai = block.ai?.binding === "AI";
const vectors = (block.vectorize ?? []).find((v) => v.binding === "VECTORS");
report.info(
    `Workers AI binding: ${ai ? "present" : "absent (Intelligence can't run)"}; Vectorize: ${vectors ? `index ${vectors.index_name}` : "absent (keyword search only)"}`,
);
if (env !== "production" && vectors) {
    const prodVectors = (config.vectorize ?? []).find((v) => v.binding === "VECTORS");
    report.check(!prodVectors || prodVectors.index_name !== vectors.index_name, "Uses its own Vectorize index", "Shares the production Vectorize index!");
}

const db = target.d1.find((d) => d.binding === "DB");
report.check(!!db, `D1 binding DB → ${db?.database_name}`, "No D1 binding called DB");
if (env === "production") {
    const wedding = new URL(target.vars.WEDDING_URL ?? "https://invalid.invalid");
    const customDomain = (target.routes ?? []).some((route) => typeof route === "object" && route.custom_domain && route.pattern === wedding.hostname);
    report.check(
        wedding.protocol === "https:" && wedding.hostname === "wedding.daly.id.au",
        `Wedding origin is ${wedding.origin}`,
        "WEDDING_URL must be https://wedding.daly.id.au",
    );
    report.check(customDomain, `Custom domain ${wedding.hostname} is configured`, `No custom-domain route claims ${wedding.hostname}`);
}
if (env !== "production") {
    const prodDb = production.d1.find((d) => d.binding === "DB");
    report.check(db && prodDb && db.database_id !== prodDb.database_id, "Uses its own D1 database, not production's", "Shares the production D1 database!");
    const customDomains = (target.routes ?? []).filter((r) => r.custom_domain || (typeof r === "object" && r.pattern));
    report.check(
        customDomains.length === 0,
        "Has no routes of its own (production custom domains are not inherited)",
        `Would claim routes: ${customDomains.map((r) => r.pattern).join(", ")}`,
    );
    report.check(target.name !== production.name, `Worker name "${target.name}" differs from production`, "Same Worker name as production!");
}

// --- Secrets (names only) --------------------------------------------------------------------------

const listed = args.offline ? null : wrangler(["secret", "list", envFlag(env).replace(/"/g, ""), "--format", "json"], { quiet: true });
if (!listed) {
    report.info("Secrets not checked (--offline)");
} else if (!listed.ok) {
    report.warn(
        `Couldn't list secrets (${(listed.stderr.split("\n").find((l) => l.trim()) ?? "wrangler error").trim()}). Run \`npx wrangler login\`, or the Worker isn't deployed yet.`,
    );
} else {
    let names = [];
    try {
        names = JSON.parse(listed.stdout).map((s) => s.name);
    } catch {
        report.warn("Couldn't read the secret list");
    }
    for (const name of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "PORTAL_OWNER_EMAILS", "RSVP_LINK_SECRET"]) {
        report.check(names.includes(name), `Secret ${name} is set`, `Secret ${name} is missing: npx wrangler secret put ${name} ${envFlag(env)}`);
    }
    // Chosen providers need their credentials (names only; values are never read).
    const needed = [
        ...(delivery === "fastmail" ? ["FASTMAIL_API_TOKEN"] : []),
        ...(delivery === "smtp" ? ["SMTP_USERNAME", "SMTP_PASSWORD"] : []),
        ...(delivery === "smtp2go" ? ["SMTP2GO_API_KEY", "COMMS_WEBHOOK_SECRET"] : []),
        ...(sms === "clicksend" ? ["CLICKSEND_USERNAME", "CLICKSEND_API_KEY", "COMMS_WEBHOOK_SECRET"] : []),
    ];
    for (const name of [...new Set(needed)])
        report.check(
            names.includes(name),
            `Secret ${name} is set`,
            `Secret ${name} is missing for the chosen provider: npx wrangler secret put ${name} ${envFlag(env)}`,
        );
    for (const name of ["ACCESS_DEV_EMAIL", "ACCESS_DEV_ALT_EMAIL", "ACCESS_TEST_JWKS"]) {
        report.check(!names.includes(name), `No ${name} secret`, `${name} is set as a secret: delete it (npx wrangler secret delete ${name} ${envFlag(env)})`);
    }
    for (const name of ["ADMIN_TOKEN", "CAPACITIES_API_TOKEN"]) {
        report.check(names.includes(name), `Secret ${name} is set`, `Secret ${name} is missing (needed by the blog)`, "warn");
    }
}

// --- Live probes (no credentials) -------------------------------------------------------------------

if (args.url) {
    const base = String(args.url).replace(/\/+$/, "");
    const probe = async (path, init) => {
        try {
            return await fetch(`${base}${path}`, { redirect: "manual", ...init });
        } catch (error) {
            return { status: 0, error, headers: new Headers() };
        }
    };
    const health = await probe("/api/health");
    report.check(health.status === 200, `${base}/api/health answers 200`, `${base}/api/health answered ${health.status}`);

    // With Access in front, an unauthenticated request is redirected to the Access login (302/303)
    // or blocked (403). Without Access, the Worker itself answers 401 (configured) or 403 (not configured).
    const portal = await probe("/portal/wedding");
    const location = portal.headers.get("location") ?? "";
    if ([301, 302, 303].includes(portal.status) && location.includes("cloudflareaccess.com")) report.pass("/portal redirects to the Cloudflare Access login");
    else if (portal.status === 401)
        report.warn("/portal is reachable without Access in front (the Worker refused it: 401). Check the Access application covers /portal.");
    else if (portal.status === 404) report.warn("/portal answered 404: the portal isn't deployed at this URL yet");
    else if (portal.status === 403) report.fail("/portal answered 403 without credentials: Access isn't in front, or the Worker's Access secrets are missing");
    else report.fail(`/portal answered ${portal.status} without credentials. It must never be 200.`);

    const api = await probe("/api/portal/me");
    if (api.status !== 404)
        report.check(api.status !== 200, `/api/portal/me refuses unauthenticated requests (${api.status})`, "/api/portal/me answered 200 without credentials!");

    const wedding = await probe("/wedding");
    report.info(`/wedding answers ${wedding.status} (${wedding.status === 404 ? "unpublished" : wedding.status === 200 ? "published" : "check"})`);
}

if (args.team) {
    const team = String(args.team)
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "");
    try {
        const certs = await (await fetch(`https://${team}/cdn-cgi/access/certs`)).json();
        report.check(
            Array.isArray(certs.keys) && certs.keys.length > 0,
            `Access team ${team} publishes signing keys`,
            `Access team ${team} has no signing keys`,
        );
    } catch {
        report.fail(`Couldn't fetch https://${team}/cdn-cgi/access/certs`);
    }
}

report.finish();
