// Authorisation matrix for Payload's own API, against the real Payload in `wrangler dev --local`
// (the platform tests use a stand-in). Every endpoint × method × portal role, plus no identity.
// Run: npx wrangler dev --port 8790 --local --env-file .dev.vars.authz   (test-identity.mjs init, plus
//      SITE_URL=http://localhost:8790 and no ACCESS_DEV_EMAIL), then node e2e-platform/authz.mjs
// Local only: refuses any base URL that isn't localhost. Exits non-zero if any expectation fails.
import { OWNER, token } from "../scripts/test-identity.mjs";

const BASE = process.env.POC_BASE ?? "http://localhost:8790";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE)) throw new Error("Local wrangler dev only.");
// Run wrangler dev with SITE_URL=http://localhost:8790 (.dev.vars.authz): Node fetch drops custom Host headers.
const SITE = { Origin: BASE };
const identity = (email) => (email ? { "Cf-Access-Jwt-Assertion": token(email) } : {});

async function call(method, path, email, body) {
    const response = await fetch(`${BASE}${path}`, {
        method,
        redirect: "manual",
        headers: { ...SITE, ...identity(email), ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, text, cookie: response.headers.get("set-cookie") };
}

// Invented people for each portal role (created through the existing portal API, as the owner).
const PEOPLE = { owner: OWNER, admin: "admin@example.test", editor: "editor@example.test", viewer: "viewer@example.test", stranger: "stranger@example.test", none: null };
for (const role of ["admin", "editor", "viewer"]) {
    const r = await call("POST", "/api/portal/users", OWNER, { email: PEOPLE[role], role });
    if (r.status >= 300 && !/already|exists|conflict/i.test(r.text)) throw new Error(`creating ${role}: ${r.status} ${r.text.slice(0, 120)}`);
}
// A published page to read, created by the owner.
const created = await call("POST", "/api/pages?draft=false", OWNER, { title: "Invented page", slug: `invented-${Date.now()}`, _status: "published" });
const pageId = JSON.parse(created.text)?.doc?.id;

const allowed = (s) => s >= 200 && s < 300;
const refused = (s) => s === 401 || s === 403 || s === 404 || s === 405 || s === 501;
let failures = 0;
const expect = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

// [label, method, path, body, roles allowed (others must be refused)]
const writers = ["owner", "admin"];
const MATRIX = [
    ["read users", "GET", "/api/users", null, ["owner"]],
    ["create user", "POST", "/api/users", { email: "new@example.test" }, []],
    ["Payload login", "POST", "/api/users/login", { email: OWNER, password: "x" }, []],
    ["Payload forgot password", "POST", "/api/users/forgot-password", { email: OWNER }, []],
    ["Payload first register", "POST", "/api/users/first-register", { email: "x@example.test", password: "xxxxxxxx" }, []],
    ["Payload refresh token", "POST", "/api/users/refresh-token", null, []],
    // Only the people who edit the website: file names and alt text can give away drafts (audit L5).
    ["read media", "GET", "/api/media", null, writers],
    ["create media", "POST", "/api/media", { alt: "x" }, writers],
    // Pages are read through the site, never this API: only the people who edit them read them here.
    ["read pages", "GET", "/api/pages", null, writers],
    ["create page", "POST", "/api/pages", () => ({ title: "x", slug: `x-${Date.now()}-${Math.random().toString(36).slice(2)}` }), writers],
    ["update page", "PATCH", `/api/pages/${pageId}`, { title: "changed" }, writers],
    ["delete page", "DELETE", `/api/pages/${pageId}?dry=1`, null, ["owner"]],
    ["read projects", "GET", "/api/projects", null, writers],
    ["create project", "POST", "/api/projects", () => ({ title: "x", summary: "x", slug: `x-${Date.now()}-${Math.random().toString(36).slice(2)}` }), writers],
    // The website's globals (docs/PAYLOAD-FRONTEND-PLAN.md): owners and admins only.
    ["read site settings", "GET", "/api/globals/site-settings", null, writers],
    ["update site settings", "POST", "/api/globals/site-settings", { footerText: "" }, writers],
    ["read navigation", "GET", "/api/globals/navigation", null, writers],
    ["update navigation", "POST", "/api/globals/navigation", { items: [{ label: "Home", type: "url", url: "/" }, { label: "Blog", type: "url", url: "/blog" }, { label: "Contact", type: "url", url: "/contact" }] }, writers],
    ["read homepage", "GET", "/api/globals/homepage", null, writers],
    ["update homepage (draft)", "POST", "/api/globals/homepage?draft=true", { eyebrow: "HELLO, I'M AIDAN", _status: "draft" }, writers],
    ["read jobs", "GET", "/api/payload-jobs", null, []],
    ["queue a job", "POST", "/api/payload-jobs", { taskSlug: "pocHeartbeat", input: { note: "x" } }, []],
    ["run jobs (no secret)", "GET", "/api/payload-jobs/run", null, []],
    ["read migrations", "GET", "/api/payload-migrations", null, []],
    ["create migration record", "POST", "/api/payload-migrations", { name: "x", batch: 99 }, []],
    ["read kv", "GET", "/api/payload-kv", null, []],
    ["read locked documents", "GET", "/api/payload-locked-documents", null, []],
    ["GraphQL", "POST", "/api/graphql", { query: "{ __typename }" }, []],
];

for (const [label, method, path, body, roles] of MATRIX) {
    for (const [role, email] of Object.entries(PEOPLE)) {
        // Run deletes last and only for one allowed role, so the page exists for the others.
        if (method === "DELETE" && role !== "viewer" && role !== "none" && role !== "stranger" && role !== "editor") continue;
        const r = await call(method, path.replace("?dry=1", ""), email, typeof body === "function" ? body() : body);
        const want = roles.includes(role);
        const ok = want ? allowed(r.status) || r.status === 400 /* allowed, but the invented body is invalid */ : refused(r.status);
        expect(`${role.padEnd(8)} ${label}`, ok, `${method} ${path.replace("?dry=1", "")} → ${r.status}`);
        if (r.cookie && /payload-token/i.test(r.cookie)) expect(`${role.padEnd(8)} ${label}: no Payload session cookie`, false, r.cookie.slice(0, 60));
    }
}
// The owner can delete (cleans up).
const del = await call("DELETE", `/api/pages/${pageId}`, OWNER);
expect("owner    delete page", allowed(del.status), `→ ${del.status}`);

// Payload sets no session of its own: every request is re-checked against Cloudflare Access.
const me = await call("GET", "/api/users/me", OWNER);
expect("no Payload session cookie is ever issued", !/payload-token/i.test(me.cookie ?? ""), me.cookie ?? "none");
const afterLogout = await call("POST", "/api/users/logout", OWNER);
expect("logout can't create or clear a Payload session", !/payload-token=[^;]+/i.test(afterLogout.cookie ?? ""), `→ ${afterLogout.status}`);

console.log(failures ? `\n${failures} authorisation check(s) failed.` : "\nAll authorisation checks passed.");
process.exit(failures ? 1 : 0);
