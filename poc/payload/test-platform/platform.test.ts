// Phase 0 security tests for the combined Worker (platform/compose.ts and platform/hosts.ts).
// Payload is a stand-in that records every request reaching it, so "never reached Payload" is checked
// directly rather than inferred from a status code.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { LEGACY_API_PREFIXES, PAYLOAD_API_SLUGS, routeRequest } from "../platform/hosts";
import { payloadHasDueJobs } from "../platform/compose";
import { OWNER, accessToken, apiCall, call, db, portalEnv, resetPortal } from "../../../test/portal-helpers";
import worker, { payloadCalls } from "./platform-under-test";

beforeEach(async () => {
    await resetPortal();
    payloadCalls.length = 0;
});

const GUEST_HOSTS = ["wedding.daly.id.au", "weddingplanner.daly.id.au"];

/** Administration and Payload paths, with the usual tricks for slipping past a prefix check. */
const ADMIN_PATHS = [
    "/admin",
    "/admin/",
    "/admin/wedding/guests",
    "/admin/collections/users",
    "/ADMIN",
    "/%61dmin",
    "/admin%2fcollections",
    "/assets/../admin",
    "/./admin",
    "//admin",
    "/admin;x",
    "/api/users",
    "/api/users/me",
    "/api/users/login",
    "/api/pages",
    "/api/graphql",
    "/api/graphql-playground",
    "/api/payload-jobs/run",
    "/api/payload-preferences",
    "/api/platform/wedding-page?path=/portal/wedding/guests",
    "/_next/static/chunks/main.js",
    "/_next/image?url=/x",
    "/_next/data/x.json",
    "/cms",
    "/poc/pdf",
    "/portal",
    "/portal/wedding/guests",
    "/api/admin/sync",
    "/api/comms/webhooks/clicksend/secret",
    "/api/amplenote/ingest",
    "/api/integrations/x",
    "/api/display/wallboard",
];

describe("the routing swap is in effect", () => {
    it("sends a signed-in owner's /admin to Payload (proves the existing suites ran through the combined router)", async () => {
        const response = await call("/admin", { token: await accessToken() });
        expect(response.headers.get("X-Poc-Target")).toBe("payload");
        expect(payloadCalls).toEqual(["daly.id.au/admin"]);
    });
});

describe("experiment 6: guest-facing hosts never reach administration", () => {
    for (const host of GUEST_HOSTS) {
        it(`${host}: every administration path is refused and Payload is never called, signed in or not`, async () => {
            const owner = await accessToken();
            for (const path of ADMIN_PATHS) {
                for (const token of [null, owner]) {
                    for (const method of ["GET", "POST"]) {
                        const response = await call(path, { method, token, host, headers: { Origin: `https://${host}` } });
                        // The planner host keeps its own wedding API (behind its own Access destination).
                        if (host === "weddingplanner.daly.id.au" && path.startsWith("/api/portal/")) continue;
                        // A refusal of any kind (404, 405, or the planner host's own 401 sign-in page), never content.
                        expect(response.status, `${method} ${host}${path} → ${response.status}`).toBeGreaterThanOrEqual(401);
                        expect(response.headers.get("X-Poc-Target")).toBeNull();
                    }
                }
            }
            expect(payloadCalls).toEqual([]);
        });
    }

    it("wedding host still serves the guest site's own static files and RSVP API, as today", async () => {
        const env = await portalEnv();
        const ctx = createExecutionContext();
        const asset = await worker.fetch(new Request("https://wedding.daly.id.au/favicon.svg"), env as never, ctx);
        await waitOnExecutionContext(ctx);
        expect(asset.status).toBe(200);
        const rsvp = await call("/api/wedding/rsvp/lookup", { method: "POST", host: "wedding.daly.id.au", body: "{}", headers: { "Content-Type": "application/json", Origin: "https://wedding.daly.id.au" } });
        // Handled by the existing RSVP code (site unpublished in a fresh database → its own 404), not by the router's refusal.
        expect(rsvp.headers.get("Content-Type") ?? "").toContain("application/json");
        expect(payloadCalls).toEqual([]);
    });

    it("never routes a guest host to Payload, whatever the path (exhaustive over generated paths)", () => {
        const config = { SITE_URL: "https://daly.id.au", WEDDING_URL: "https://wedding.daly.id.au", PLANNER_URL: "https://weddingplanner.daly.id.au" };
        const parts = ["admin", "api", "users", "_next", "static", "cms", "graphql", "..", ".", "%2e", "%2F", "wedding", "portal", "payload-jobs", "run", ""];
        let checked = 0;
        for (const a of parts) for (const b of parts) for (const c of parts) {
            for (const host of GUEST_HOSTS) {
                const target = routeRequest(new URL(`https://${host}/${a}/${b}/${c}`), config).target;
                expect(target, `${host}/${a}/${b}/${c}`).not.toBe("payload");
                checked++;
            }
        }
        expect(checked).toBeGreaterThan(8000);
    });
});

describe("experiment 3: Payload's admin and API fail closed without a portal identity", () => {
    it("refuses /admin and Payload's API with no token, a forged token, an expired token, a wrong audience or no role", async () => {
        const tokens: Array<[string, string | null, number]> = [
            ["none", null, 401],
            ["forged key", await accessToken({ key: "other" }), 403],
            ["expired", await accessToken({ expiresIn: -3600 }), 403],
            ["wrong audience", await accessToken({ aud: ["aud-someone-else"] }), 403],
            ["no portal role", await accessToken({ email: "stranger@example.com" }), 403],
        ];
        for (const [label, token, status] of tokens) {
            for (const path of ["/admin", "/admin/wedding/guests", "/api/users/me", "/api/pages", "/api/graphql", "/api/payload-jobs/run"]) {
                const response = await call(path, { token });
                // GraphQL is switched off: the existing Worker's own 404.
                expect(response.status, `${label} ${path}`).toBe(path === "/api/graphql" ? 404 : status);
            }
        }
        expect(payloadCalls).toEqual([]);
    });

    it("an inactive portal user loses Payload access immediately", async () => {
        await apiCall("POST", "/api/portal/users", { email: "helper@example.com", role: "editor" });
        expect((await call("/admin", { token: await accessToken({ email: "helper@example.com" }) })).status).toBe(200);
        const users = await apiCall<{ users: Array<{ email: string }> }>("GET", "/api/portal/users");
        expect(users.status).toBe(200);
        await apiCall("DELETE", `/api/portal/users/${encodeURIComponent("helper@example.com")}`);
        expect((await call("/admin", { token: await accessToken({ email: "helper@example.com" }) })).status).toBe(403);
    });
});

describe("experiment 4: the existing API keeps its prefixes on the site host", () => {
    it("legacy /api prefixes always win over Payload's REST API", () => {
        for (const slug of PAYLOAD_API_SLUGS) {
            for (const prefix of LEGACY_API_PREFIXES) expect(prefix.startsWith(`/api/${slug}/`)).toBe(false);
        }
        const config = { SITE_URL: "https://daly.id.au", WEDDING_URL: "https://wedding.daly.id.au" };
        for (const prefix of LEGACY_API_PREFIXES) expect(routeRequest(new URL(`https://daly.id.au${prefix}x`), config).target).toBe("legacy");
    });

    it("an unknown /api path goes to the existing Worker's own 404, not Payload", async () => {
        const response = await call("/api/not-a-thing", { token: await accessToken() });
        expect(response.headers.get("X-Poc-Target")).toBeNull();
        expect(payloadCalls).toEqual([]);
    });
});

describe("experiment 2: the wedding-page bridge reuses the portal's loader and protections", () => {
    const bridge = (path: string, token: string | null) => call(`/api/platform/wedding-page?path=${encodeURIComponent(path)}`, { token });

    it("gives an owner the guests screen's data, with RSVP codes", async () => {
        const household = (await apiCall<{ item: { id: string } }>("POST", "/api/portal/wedding/households", { name: "The Testers" })).json.item;
        await apiCall("POST", "/api/portal/wedding/guests", { firstName: "Tess", lastName: "Tester", householdId: household.id });
        const response = await bridge("/portal/wedding/households", await accessToken());
        expect(response.status).toBe(200);
        const body = (await response.json()) as { data: { route: string; context: { user: { email: string } } }; styles: string[] };
        expect(body.data.route).toBe("households");
        expect(body.data.context.user.email).toBe(OWNER);
        expect(JSON.stringify(body)).toContain("rsvpCode");
        expect(body.styles.length).toBeGreaterThan(0);
    });

    it("hides RSVP codes from a viewer, as the portal does", async () => {
        await apiCall("POST", "/api/portal/wedding/households", { name: "The Testers" });
        await apiCall("POST", "/api/portal/users", { email: "viewer@example.com", role: "viewer" });
        const response = await bridge("/portal/wedding/households", await accessToken({ email: "viewer@example.com" }));
        expect(response.status).toBe(200);
        expect(JSON.stringify(await response.json())).not.toMatch(/"rsvpCode":"[^"]/);
    });

    it("refuses strangers and anything that isn't a wedding screen", async () => {
        expect((await bridge("/portal/wedding/guests", null)).status).toBe(401);
        expect((await bridge("/portal/wedding/guests", await accessToken({ email: "stranger@example.com" }))).status).toBe(403);
        for (const path of ["/portal/finance", "/portal/calendar", "/portal/wedding/../finance", "https://evil.example/portal/wedding", "/portal/wedding/guests?x=1"]) {
            expect((await bridge(path, await accessToken())).status, path).toBe(404);
        }
    });
});

describe("experiment 5: scheduled work runs through the combined Worker", () => {
    // Payload's job table, as its migration creates it, in the test database standing in for Payload's D1.
    const jobsTable = async () => {
        await db().prepare("DROP TABLE IF EXISTS payload_jobs").run();
        await db()
            .prepare(
                `CREATE TABLE payload_jobs (id integer PRIMARY KEY NOT NULL, input text, completed_at text, total_tried numeric DEFAULT 0,
                 has_error integer DEFAULT false, error text, task_slug text, queue text DEFAULT 'default', wait_until text,
                 processing integer DEFAULT false, updated_at text NOT NULL DEFAULT '', created_at text NOT NULL DEFAULT '')`,
            )
            .run();
    };
    const cron = async (env: unknown) => {
        const ctx = createExecutionContext();
        await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env as never, ctx);
        await waitOnExecutionContext(ctx);
    };

    it("an ordinary cron run never starts Payload: nothing due, no table, or no Payload database", async () => {
        await jobsTable();
        const base = await portalEnv({ PAYLOAD_JOBS_SECRET: "jobs-secret-0123456789abcdef" } as never);
        // Finished, failed, running and future jobs are not due.
        await db()
            .prepare(
                `INSERT INTO payload_jobs (task_slug, completed_at, has_error, processing, wait_until) VALUES
                 ('a', '2026-01-01T00:00:00Z', 0, 0, NULL), ('b', NULL, 1, 0, NULL), ('c', NULL, 0, 1, NULL), ('d', NULL, 0, 0, '2999-01-01T00:00:00Z')`,
            )
            .run();
        await cron({ ...base, D1: db() });
        await cron({ ...base });
        await db().prepare("DROP TABLE payload_jobs").run();
        await cron({ ...base, D1: db() });
        expect(payloadCalls).toEqual([]);
        expect(await payloadHasDueJobs(db())).toBe(false);
    });

    it("runs Payload's queue from the cron, with the secret, only when a job is due", async () => {
        await jobsTable();
        await db().prepare("INSERT INTO payload_jobs (task_slug, wait_until) VALUES ('pocHeartbeat', '2020-01-01T00:00:00Z')").run();
        await cron({ ...(await portalEnv({ PAYLOAD_JOBS_SECRET: "jobs-secret-0123456789abcdef" } as never)), D1: db() });
        expect(payloadCalls).toEqual(["daly.id.au/api/payload-jobs/run"]);
        // Without the secret, nothing runs it.
        payloadCalls.length = 0;
        await cron({ ...(await portalEnv()), D1: db() });
        expect(payloadCalls).toEqual([]);
        // And the same route from outside never reaches Payload without passing the gate.
        expect((await call("/api/payload-jobs/run", { token: null })).status).toBe(401);
        expect(payloadCalls).toEqual([]);
    });
});
