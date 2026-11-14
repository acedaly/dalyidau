// Phase 0 security tests for the combined Worker (platform/compose.ts and platform/hosts.ts).
// Payload is a stand-in that records every request reaching it, so "never reached Payload" is checked
// directly rather than inferred from a status code.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { LEGACY_API_PREFIXES, PAYLOAD_API_SLUGS, routeRequest } from "../platform/hosts";
import { API_CSP, crossSiteWrite, payloadHasDueJobs } from "../platform/compose";
import { OWNER, accessToken, apiCall, call, db, portalEnv, resetPortal } from "../../../test/portal-helpers";
import worker, { payloadCalls, payloadSeen } from "./platform-under-test";

beforeEach(async () => {
    await resetPortal();
    payloadCalls.length = 0;
    payloadSeen.length = 0;
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
                        // A refusal of any kind (404, 405, 401), never content. The old planner host sends people
                        // to the phone app on daly.id.au (behind Access) instead of showing anything itself.
                        const toAdmin = host === "weddingplanner.daly.id.au" && response.status === 302 && response.headers.get("Location") === "https://daly.id.au/portal/planner";
                        if (!toAdmin) expect(response.status, `${method} ${host}${path} → ${response.status}`).toBeGreaterThanOrEqual(401);
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
            for (const path of ["/admin", "/admin/wedding/guests", "/api/users/me", "/api/pages", "/api/graphql"]) {
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
        for (const path of ["/portal/finance", "/portal/calendar", "/portal/wedding/../finance", "https://evil.example/portal/wedding", "/portal/settings/../finance", "/portal/planner"]) {
            expect((await bridge(path, await accessToken())).status, path).toBe(404);
        }
        // A query is passed to the page's loader (the audit log's filters); the path alone is checked.
        expect((await bridge("/portal/audit?action=guest.create", await accessToken())).status).toBe(200);
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
        expect((await call("/api/payload-jobs/run", { token: null })).status).toBe(404);
        expect(payloadCalls).toEqual([]);
    });
});

describe("identity comes only from Cloudflare Access, never from Payload's own session", () => {
    it("refuses Payload's sign-in routes and internal collections to everyone, owner included", async () => {
        const owner = await accessToken();
        for (const path of [
            "/api/users/login", "/api/users/logout", "/api/users/refresh-token", "/api/users/forgot-password", "/api/users/reset-password",
            "/api/users/first-register", "/api/users/unlock", "/api/users/verify/x", "/api/users/init",
            "/api/payload-jobs", "/api/payload-jobs/run", "/api/payload-jobs/1", "/api/payload-migrations", "/api/payload-kv", "/api/payload-locked-documents",
        ]) {
            for (const method of ["GET", "POST"]) {
                const response = await call(path, { method, token: owner, headers: { Origin: "https://daly.id.au" } });
                expect(response.status, `${method} ${path}`).toBe(404);
            }
        }
        expect(payloadCalls).toEqual([]);
    });

    it("still lets the signed-in person reach Payload's ordinary API", async () => {
        expect((await call("/api/users/me", { token: await accessToken() })).status).toBe(200);
        expect((await call("/api/pages", { token: await accessToken() })).status).toBe(200);
        expect(payloadCalls).toEqual(["daly.id.au/api/users/me", "daly.id.au/api/pages"]);
    });

    it("strips Payload's cookie and Authorization header on the way in, keeping other cookies", async () => {
        await call("/admin", {
            token: await accessToken(),
            headers: { Cookie: "payload-token=someone-elses; payload-theme=dark; CF_Authorization=x", Authorization: "JWT someone-elses" },
        });
        await call("/admin", { token: await accessToken(), headers: { Cookie: "payload-token=only" } });
        expect(payloadSeen).toEqual([
            { cookie: "payload-theme=dark; CF_Authorization=x", authorization: null },
            { cookie: null, authorization: null },
        ]);
    });

    it("drops any payload-token cookie Payload tries to set, keeping its other cookies", async () => {
        const response = await call("/admin", { token: await accessToken() });
        const cookies = response.headers.getSetCookie();
        expect(cookies.some((c) => /^payload-token=/.test(c))).toBe(false);
        expect(cookies).toContain("payload-theme=dark; Path=/");
    });

    it("the cron still reaches Payload's job runner directly, with its secret", async () => {
        await db().prepare("DROP TABLE IF EXISTS payload_jobs").run();
        await db().prepare("CREATE TABLE payload_jobs (id integer PRIMARY KEY, completed_at text, has_error integer DEFAULT 0, processing integer DEFAULT 0, wait_until text)").run();
        await db().prepare("INSERT INTO payload_jobs (wait_until) VALUES (NULL)").run();
        const ctx = createExecutionContext();
        await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, { ...(await portalEnv({ PAYLOAD_JOBS_SECRET: "jobs-secret-0123456789abcdef" } as never)), D1: db() } as never, ctx);
        await waitOnExecutionContext(ctx);
        expect(payloadSeen).toEqual([{ cookie: null, authorization: "Bearer jobs-secret-0123456789abcdef" }]);
    });
});

describe("Phase 1 hardening: cross-site writes, closed paths and headers", () => {
    it("refuses a Payload write a page on another site triggered, before Payload sees it, even for the signed-in owner", async () => {
        const token = await accessToken();
        const attacks: Array<Record<string, string>> = [
            { Origin: "https://evil.example" },
            { Origin: "null" },
            { Origin: "https://wedding.daly.id.au" },
            { "Sec-Fetch-Site": "cross-site" },
            { "Sec-Fetch-Site": "same-site", Origin: "https://daly.id.au" },
        ];
        for (const path of ["/api/posts", "/api/posts/1", "/api/media", "/api/globals/navigation", "/admin/collections/posts/1"]) {
            for (const method of ["POST", "PATCH", "DELETE"]) {
                for (const headers of attacks) {
                    const form = new FormData();
                    form.set("_payload", JSON.stringify({ title: "x", _status: "published" }));
                    const response = await call(path, { method, token, headers, body: method === "DELETE" ? undefined : form });
                    expect(response.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(403);
                    expect(((await response.json()) as { error: string }).error).toBe("cross_site");
                }
            }
        }
        expect(payloadCalls).toEqual([]);
    });

    it("still lets the admin itself, and scripts that aren't a browser page, write", async () => {
        const token = await accessToken();
        const sameOrigin = await call("/api/posts", { method: "POST", token, headers: { Origin: "https://daly.id.au", "Sec-Fetch-Site": "same-origin" }, body: "{}" });
        expect(sameOrigin.status).toBe(200);
        const script = await call("/api/posts", { method: "POST", token, body: "{}" });
        expect(script.status).toBe(200);
        // Reads are unaffected by where they come from (Access still decides who may read).
        const read = await call("/api/posts", { token, headers: { "Sec-Fetch-Site": "cross-site" } });
        expect(read.status).toBe(200);
        expect(payloadCalls).toEqual(["daly.id.au/api/posts", "daly.id.au/api/posts", "daly.id.au/api/posts"]);
    });

    it("a cross-site write without a sign-in is still refused by the sign-in check, not let through", async () => {
        const response = await call("/api/posts", { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" });
        expect(response.status).toBe(401);
        expect(payloadCalls).toEqual([]);
    });

    it("closes /cms, /poc and the raw page templates on every host, signed in or not", async () => {
        const token = await accessToken();
        for (const host of ["daly.id.au", "wedding.daly.id.au", "weddingplanner.daly.id.au", "dalyidau.example.workers.dev"]) {
            for (const path of ["/cms", "/cms/", "/cms/x", "/CMS/x", "/poc/", "/poc/pdf", "/shell.html", "/shell-portal.html", "/shell-wedding.html", "/shell-planner.html", "/SHELL.HTML", "/%73hell.html", "/shell%2ehtml", "//shell.html", "/%63ms/x", "/shell.html%"]) {
                const response = await call(path, { token, host });
                expect(response.status, `${host}${path}`).toBe(404);
                expect(await response.text(), `${host}${path}`).not.toContain("<!doctype");
            }
        }
        expect(payloadCalls).toEqual([]);
        // An ordinary page whose address merely starts with those letters is the site's, not closed.
        const config = { SITE_URL: "https://daly.id.au" };
        expect(routeRequest(new URL("https://daly.id.au/cmstuff"), config).target).toBe("legacy");
        expect(routeRequest(new URL("https://daly.id.au/pocket"), config).target).toBe("legacy");
    });

    it("gives Payload's API a no-script sandbox policy and the site's baseline headers; the admin keeps its own policy", async () => {
        const token = await accessToken();
        const api = await call("/api/media/file/picture.png", { token });
        expect(api.headers.get("Content-Security-Policy")).toBe(API_CSP);
        expect(api.headers.get("Content-Security-Policy")).toContain("sandbox");
        expect(api.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(api.headers.get("Permissions-Policy")).toContain("camera=()");
        expect(api.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
        expect(api.headers.get("X-Frame-Options")).toBe("DENY");
        const admin = await call("/admin", { token });
        // The stand-in sets none; the real admin's nonce policy comes from Payload's middleware and is left alone.
        expect(admin.headers.get("Content-Security-Policy")).toBeNull();
        expect(admin.headers.get("Permissions-Policy")).toContain("camera=()");
    });
});

describe("crossSiteWrite", () => {
    const site = "https://daly.id.au";
    const req = (method: string, headers: Record<string, string> = {}) => new Request("https://daly.id.au/api/posts", { method, headers });
    it("treats reads as never cross-site writes", () => {
        for (const method of ["GET", "HEAD", "OPTIONS"]) expect(crossSiteWrite(req(method, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }), site)).toBe(false);
    });
    it("refuses writes labelled as coming from elsewhere, by either header", () => {
        expect(crossSiteWrite(req("POST", { Origin: "https://evil.example" }), site)).toBe(true);
        expect(crossSiteWrite(req("POST", { "Sec-Fetch-Site": "cross-site" }), site)).toBe(true);
        expect(crossSiteWrite(req("PUT", { "Sec-Fetch-Site": "same-site", Origin: site }), site)).toBe(true);
        expect(crossSiteWrite(req("PATCH", { Origin: "http://daly.id.au" }), site)).toBe(true);
        expect(crossSiteWrite(req("POST", { Origin: "null", "Sec-Fetch-Site": "same-origin" }), site)).toBe(true);
        expect(crossSiteWrite(req("POST", { Origin: "https://daly.id.au:8443" }), site)).toBe(true);
    });
    it("accepts same-origin writes and writes with no browser labels", () => {
        expect(crossSiteWrite(req("POST", { Origin: site, "Sec-Fetch-Site": "same-origin" }), site)).toBe(false);
        expect(crossSiteWrite(req("DELETE", { Origin: site }), site)).toBe(false);
        expect(crossSiteWrite(req("POST"), site)).toBe(false);
    });
});
