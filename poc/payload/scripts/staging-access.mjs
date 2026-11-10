// Staging behind real Cloudflare Access, prepared but not enabled (attaching a hostname needs the owner's approval).
//
//   CF_ACCESS_READ_TOKEN=… node scripts/staging-access.mjs verify   # BEFORE attaching: Access must already cover the host
//   node scripts/staging-access.mjs probe                            # AFTER attaching: nothing answers without Access
//
// verify needs a read-only API token from the owner ("Access: Apps and Policies Read" for the account).
// Wrangler's own sign-in can't read Access. The token is read from the environment only, never stored or printed.
// deploy-staging.mjs runs `verify` automatically whenever the staging config has a route, and refuses to deploy
// unless it passes. That's how "Access is enforced before the hostname becomes reachable" is guaranteed.
import process from "node:process";

export const STAGING_HOST = "payload-staging.daly.id.au";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "9fd9c764b89b09bcc55f18ed1429781a";

/** Does this Access application protect the whole host (any path), with a real allow policy and no bypass? */
export function protectsWholeHost(app, host = STAGING_HOST) {
    const domains = [app.domain, ...(app.self_hosted_domains ?? []), ...(app.destinations ?? []).map((d) => d.uri)].filter(Boolean);
    const whole = domains.some((d) => d === host || d === `${host}/` || d === `${host}/*`);
    const policies = app.policies ?? [];
    const allows = policies.filter((p) => p.decision === "allow");
    const bypass = policies.some((p) => p.decision === "bypass" || p.decision === "non_identity");
    const everyone = allows.some((p) => (p.include ?? []).some((rule) => "everyone" in rule));
    return { ok: app.type === "self_hosted" && whole && allows.length > 0 && !bypass && !everyone, whole, allows: allows.length, bypass, everyone, aud: app.aud };
}

async function verify() {
    const token = process.env.CF_ACCESS_READ_TOKEN;
    if (!token) {
        console.error("Set CF_ACCESS_READ_TOKEN (read-only Access token from the owner). Without it, staging stays unreachable.");
        process.exit(2);
    }
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/apps?per_page=100`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    if (!body.success) {
        console.error(`Access API refused: ${JSON.stringify(body.errors)}`);
        process.exit(1);
    }
    const matches = body.result.map((app) => ({ name: app.name, ...protectsWholeHost(app) })).filter((m) => m.whole);
    for (const m of matches) console.log(`${m.ok ? "✓" : "✗"} ${m.name}: allow policies ${m.allows}, bypass ${m.bypass}, everyone ${m.everyone}`);
    const good = matches.find((m) => m.ok);
    if (!good) {
        console.error(`No Access application protects all of ${STAGING_HOST} with an allow policy (and no bypass or "everyone"). Don't attach the hostname.`);
        process.exit(1);
    }
    console.log(`Access protects ${STAGING_HOST}. Set ACCESS_AUD for staging to this application's AUD (not printed here; copy it from the dashboard).`);
}

async function probe() {
    let failures = 0;
    for (const path of ["/", "/admin", "/admin/wedding/guests", "/api/users/me", "/api/pages", "/api/platform/wedding-page?path=/portal/wedding", "/api/portal/wedding/guests", "/portal/wedding"]) {
        const response = await fetch(`https://${STAGING_HOST}${path}`, { redirect: "manual" });
        const location = response.headers.get("location") ?? "";
        const toAccess = response.status >= 300 && response.status < 400 && /\.cloudflareaccess\.com\//.test(location);
        const ok = toAccess || response.status === 401 || response.status === 403;
        if (!ok) failures++;
        console.log(`${ok ? "✓" : "✗"} ${path} → ${response.status}${toAccess ? " (Access sign-in)" : ""}`);
    }
    console.log(failures ? `\n${failures} path(s) answered without Access. Detach the hostname now.` : `\nEvery path needs Access.`);
    process.exit(failures ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const command = process.argv[2];
    if (command === "verify") await verify();
    else if (command === "probe") await probe();
    else console.log("Usage: staging-access.mjs verify | probe");
}
