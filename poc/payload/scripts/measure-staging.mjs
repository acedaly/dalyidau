// Phase 1: request timings for the staging Worker, through a private `wrangler dev --remote --env staging`
// session (the staging build on Cloudflare's edge, staging databases, invented data). Never anything else.
//
//   node scripts/measure-staging.mjs seed [households]  # invented households and guests, through the existing API
//   node scripts/measure-staging.mjs site               # session started with SITE_URL = the preview host
//   node scripts/measure-staging.mjs wedding            # session started with WEDDING_URL = the preview host
//
// Each scenario is timed from here (so it includes the trip to Cloudflare); `baseline` is a static file
// served before any application code runs, so `scenario − baseline` is roughly the Worker's own time.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OWNER, token } from "./test-identity.mjs";

const BASE = "http://localhost:8791";
// The preview host the session runs on (also its SITE_URL or WEDDING_URL); writes must come from it.
const ORIGIN = process.env.STAGING_ORIGIN;
if (!ORIGIN || !/^https:\/\/dalyidau-payload-staging\.[a-z0-9-]+\.workers\.dev$/.test(ORIGIN)) throw new Error("Set STAGING_ORIGIN to the session's preview origin.");
const mode = process.argv[2];
const owner = { "Cf-Access-Jwt-Assertion": token(OWNER) };
const results = path.resolve(import.meta.dirname, "../.poc-results");

async function call(method, route, { headers = {}, body } = {}) {
    const started = performance.now();
    const response = await fetch(`${BASE}${route}`, {
        method,
        redirect: "manual",
        headers: { ...headers, ...(method === "GET" ? {} : { Origin: ORIGIN }), ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, ms: performance.now() - started, text };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function scenario(name, method, route, options = {}, runs = 25) {
    const first = await call(method, route, options);
    const times = [];
    let status = first.status;
    for (let i = 0; i < runs; i++) {
        const r = await call(method, route, typeof options === "function" ? options(i) : options);
        times.push(r.ms);
        status = r.status;
    }
    times.sort((a, b) => a - b);
    const row = { name, route, status, first: Math.round(first.ms), p50: Math.round(pct(times, 50)), p95: Math.round(pct(times, 95)), runs };
    console.log(`${name.padEnd(42)} ${String(status).padEnd(4)} first ${String(row.first).padStart(5)} ms   p50 ${String(row.p50).padStart(4)} ms   p95 ${String(row.p95).padStart(4)} ms`);
    return row;
}

function save(label, rows, extra = {}) {
    mkdirSync(results, { recursive: true });
    const file = path.join(results, `staging-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ label, at: new Date().toISOString(), rows, ...extra }, null, 2));
    console.log(`\nSaved ${path.relative(process.cwd(), file)}`);
}

if (mode === "seed") {
    const households = Number(process.argv[3] ?? 110);
    const post = async (route, body) => {
        const r = await call("POST", route, { headers: owner, body });
        if (r.status >= 300) throw new Error(`POST ${route} → ${r.status} ${r.text.slice(0, 200)}`);
        return JSON.parse(r.text).item;
    };
    const ceremony = await post("/api/portal/wedding/events", { name: "Ceremony", startsAt: "2027-03-20T15:00" });
    const reception = await post("/api/portal/wedding/events", { name: "Reception", startsAt: "2027-03-20T18:00" });
    const first = ["Tess", "Toby", "Pat", "Fern", "Felix", "Fay", "Sam", "Alex", "Jo", "Kim", "Lee", "Max", "Ned", "Ora", "Quinn", "Rae"];
    let guests = 0;
    for (let h = 0; h < households; h++) {
        const surname = `Testfamily${String(h + 1).padStart(3, "0")}`;
        const household = await post("/api/portal/wedding/households", { name: `The ${surname}s` });
        const size = 1 + (h % 4);
        for (let g = 0; g < size; g++) {
            const name = first[(h + g) % first.length];
            await post("/api/portal/wedding/guests", {
                firstName: name,
                lastName: surname,
                email: `${name.toLowerCase()}.${h + 1}@example.test`,
                householdId: household.id,
                events: [ceremony.id, reception.id],
            });
            guests++;
            await new Promise((resolve) => setTimeout(resolve, 150)); // gentle on D1
        }
    }
    await post("/api/portal/users", { email: "viewer@example.test", role: "viewer" });
    const flag = await call("PUT", "/api/portal/flags/wedding.site.public", { headers: owner, body: { enabled: true } });
    console.log(`Seeded ${households} invented households, ${guests} guests and a viewer; wedding.site.public → ${flag.status}.`);
} else if (mode === "site") {
    const rows = [];
    rows.push(await scenario("baseline: static file", "GET", "/favicon.svg"));
    rows.push(await scenario("refused: /admin without identity", "GET", "/admin"));
    rows.push(await scenario("existing: blog home (SSR)", "GET", "/"));
    rows.push(await scenario("existing: portal wedding guests page", "GET", "/portal/wedding/guests", { headers: owner }));
    rows.push(await scenario("existing: API guests list", "GET", "/api/portal/wedding/guests", { headers: owner }));
    rows.push(
        await scenario("existing: API add guest (write + audit)", "POST", "/api/portal/wedding/guests", (i) => ({
            headers: owner,
            body: { firstName: "Timing", lastName: `Write${i ?? "x"}` },
        }), 15),
    );
    rows.push(await scenario("bridge: wedding page data (guests)", "GET", `/api/platform/wedding-page?path=${encodeURIComponent("/portal/wedding/guests")}`, { headers: owner }));
    rows.push(await scenario("Payload: /api/users/me", "GET", "/api/users/me", { headers: owner }));
    rows.push(await scenario("Payload: /api/pages", "GET", "/api/pages", { headers: owner }));
    rows.push(await scenario("Payload: admin dashboard (SSR)", "GET", "/admin", { headers: owner }, 15));
    rows.push(await scenario("Payload: admin wedding guests view (SSR)", "GET", "/admin/wedding/guests", { headers: owner }, 15));
    save("site", rows);
} else if (mode === "wedding") {
    const rows = [];
    rows.push(await scenario("baseline: static file", "GET", "/favicon.svg"));
    rows.push(await scenario("guest site: home", "GET", "/"));
    rows.push(await scenario("guest site: /admin refused", "GET", "/admin"));
    // The lookup is rate limited (20 per client per 10 minutes); stay under it.
    rows.push(await scenario("guest site: RSVP lookup", "POST", "/api/wedding/rsvp/lookup", { body: { code: "NOPE-0000" } }, 10));
    save("wedding", rows);
} else {
    console.log("Usage: measure-staging.mjs seed [households] | site | wedding");
}
