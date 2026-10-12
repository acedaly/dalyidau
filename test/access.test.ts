import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultFlags } from "../src/shared/portal/flags";
import { verifyAccessJwt } from "../worker/portal/access";
import { loadPortalPage } from "../worker/portal/pages";
import { AUD, ORIGIN, OWNER, SECOND_OWNER, TEAM, accessToken, apiCall, auditActions, call, db, portalEnv, resetPortal, testKeys } from "./portal-helpers";

const config = { teamDomain: TEAM, audiences: [AUD] };
const keyFor = async (kid: string) => {
    const { good } = await testKeys();
    if (kid !== good.kid) return null;
    return crypto.subtle.importKey("jwk", good.jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
};

describe("Access JWT verification", () => {
    it("accepts a valid token and lower-cases the email", async () => {
        const result = await verifyAccessJwt(await accessToken({ email: "Owner@Example.COM" }), config, keyFor);
        expect(result).toEqual({ ok: true, identity: { email: "owner@example.com", subject: "user-123" } });
    });

    it.each([
        ["expired", { expiresIn: -3600 }, "expired"],
        ["not yet valid", { notBefore: 3600 }, "not_yet_valid"],
        ["for another application", { aud: "someone-elses-aud" }, "wrong_audience"],
        ["from another team", { iss: "https://evil.cloudflareaccess.com" }, "wrong_issuer"],
        ["signed with an unknown key", { key: "other" as const }, "unknown_key"],
        ["a service token without an email", { email: null }, "no_email"],
    ])("rejects a token that is %s", async (_label, options, reason) => {
        const result = await verifyAccessJwt(await accessToken(options), config, keyFor);
        expect(result).toEqual({ ok: false, reason });
    });

    it("rejects a token whose signature doesn't match its key id", async () => {
        // Signed by the rogue key but claiming to be the trusted one.
        const token = await accessToken({ key: "other", kid: "test-key-1" });
        expect(await verifyAccessJwt(token, config, keyFor)).toEqual({ ok: false, reason: "bad_signature" });
    });

    it("rejects alg=none and HMAC tokens", async () => {
        for (const alg of ["none", "HS256"]) {
            const token = await accessToken({ alg });
            expect(await verifyAccessJwt(token, config, keyFor)).toEqual({ ok: false, reason: "unsupported_alg" });
        }
    });

    it("rejects tampered claims", async () => {
        const [h, , s] = (await accessToken()).split(".");
        const forged = btoa(JSON.stringify({ email: "attacker@example.com", aud: [AUD], iss: `https://${TEAM}`, exp: 9_999_999_999 })).replace(/=+$/, "");
        expect(await verifyAccessJwt(`${h}.${forged}.${s}`, config, keyFor)).toEqual({ ok: false, reason: "bad_signature" });
    });

    it("rejects malformed tokens", async () => {
        for (const token of ["", "abc", "a.b", "a.b.c.d", "!!.??.**"]) {
            expect((await verifyAccessJwt(token, config, keyFor)).ok).toBe(false);
        }
    });
});

describe("portal access control", () => {
    beforeEach(resetPortal);

    it("fails closed in production when Access isn't configured", async () => {
        const page = await SELF.fetch("https://daly.id.au/portal/wedding", { redirect: "manual" });
        expect(page.status).toBe(403);
        expect(page.headers.get("Cache-Control")).toBe("no-store");
        expect(await page.text()).not.toContain("page-data");

        const api = await SELF.fetch("https://daly.id.au/api/portal/me", { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } });
        expect(api.status).toBe(403);
        // Which check failed is logged, never returned.
        expect(await api.json()).toEqual({ error: "forbidden" });
    });

    it("ignores the test key set in production, so a self-signed token never works there", async () => {
        const response = await call("/api/portal/me", { token: await accessToken(), env: await portalEnv({ ENVIRONMENT: "production" }) });
        // With ACCESS_TEST_JWKS ignored, the Worker tries the real team's keys, which it can't reach here.
        expect([401, 403]).toContain(response.status);
    });

    it("refuses requests without a token", async () => {
        expect((await call("/portal/wedding")).status).toBe(401);
        expect((await call("/api/portal/wedding/guests")).status).toBe(401);
    });

    it("refuses a verified identity that has no role", async () => {
        const response = await call("/portal/wedding", { token: await accessToken({ email: "stranger@example.com" }) });
        expect(response.status).toBe(403);
        expect(await response.text()).toContain("been given access to the portal");
    });

    it("lets configured owners in, privately", async () => {
        for (const email of [OWNER, SECOND_OWNER]) {
            const response = await call("/portal/wedding", { token: await accessToken({ email }) });
            expect(response.status).toBe(200);
            expect(response.headers.get("Cache-Control")).toBe("no-store");
            expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
            const html = await response.text();
            expect(html).toContain('<script type="application/json" id="page-data">');
            expect(html).toContain("Dashboard");
            expect(html).toContain("/assets/portal-");
        }
        const me = await apiCall<{ user: { role: string; permissions: string[] } }>("GET", "/api/portal/me");
        expect(me.json.user.role).toBe("owner");
        expect(me.json.user.permissions).toContain("portal.users.manage");
    });

    it("drops owner rights when an email is removed from PORTAL_OWNER_EMAILS", async () => {
        await call("/portal/wedding", { token: await accessToken({ email: SECOND_OWNER }) });
        const env = await portalEnv({ PORTAL_OWNER_EMAILS: OWNER });
        const response = await call("/portal/wedding", { token: await accessToken({ email: SECOND_OWNER }), env });
        expect(response.status).toBe(403);
    });

    it("enforces roles on the API", async () => {
        await apiCall("POST", "/api/portal/users", { email: "viewer@example.com", role: "viewer" });
        const read = await apiCall("GET", "/api/portal/wedding/guests", undefined, { email: "viewer@example.com" });
        expect(read.status).toBe(200);
        const write = await apiCall("POST", "/api/portal/wedding/guests", { firstName: "Nope" }, { email: "viewer@example.com" });
        expect(write.status).toBe(403);
        const budget = await apiCall("GET", "/api/portal/wedding/budget-items", undefined, { email: "viewer@example.com" });
        expect(budget.status).toBe(403);
        const page = await call("/portal/wedding/budget", { token: await accessToken({ email: "viewer@example.com" }) });
        expect(page.status).toBe(403);
    });

    it("does not list or open an application without its registered permission", async () => {
        const env = await portalEnv();
        const user = { email: "portal-only@example.com", name: null, role: "viewer" as const, permissions: [] };
        const launcher = await loadPortalPage("/portal", new URL(`${ORIGIN}/portal`), env, user, defaultFlags());
        expect(launcher.data).toEqual({ route: "portal-home", applications: [] });

        const wedding = await loadPortalPage("/portal/wedding", new URL(`${ORIGIN}/portal/wedding`), env, user, defaultFlags());
        expect(wedding.status).toBe(403);
        expect(wedding.data).toMatchObject({ route: "forbidden" });
    });

    it("suspends inactive people", async () => {
        await apiCall("POST", "/api/portal/users", { email: "former@example.com", role: "editor", active: false });
        expect((await apiCall("GET", "/api/portal/me", undefined, { email: "former@example.com" })).status).toBe(403);
    });

    it("refuses cross-site and non-JSON writes", async () => {
        const token = await accessToken();
        const noOrigin = await call("/api/portal/wedding/guests", {
            method: "POST",
            token,
            headers: { "Content-Type": "application/json" },
            body: '{"firstName":"A"}',
        });
        expect(noOrigin.status).toBe(403);
        const evil = await call("/api/portal/wedding/guests", {
            method: "POST",
            token,
            headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
            body: '{"firstName":"A"}',
        });
        expect(evil.status).toBe(403);
        const form = await call("/api/portal/wedding/guests", {
            method: "POST",
            token,
            headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
            body: "firstName=A",
        });
        expect(form.status).toBe(415);
        const count = await db().prepare("SELECT COUNT(*) AS n FROM guests").first<{ n: number }>();
        expect(count?.n).toBe(0);
    });

    it("only honours the development bypass in development with a localhost SITE_URL", async () => {
        const devEnv = await portalEnv({
            ENVIRONMENT: "development",
            SITE_URL: "http://localhost:8787",
            ACCESS_DEV_EMAIL: OWNER,
            ACCESS_TEAM_DOMAIN: "",
            ACCESS_AUD: "",
        });
        expect((await call("/api/portal/me", { env: devEnv })).status).toBe(200);
        expect((await call("/api/portal/me", { env: { ...devEnv, SITE_URL: "https://daly.id.au" } })).status).toBe(403);
        expect((await call("/api/portal/me", { env: { ...devEnv, ENVIRONMENT: "production" } })).status).toBe(403);
        expect((await call("/api/portal/me", { env: { ...devEnv, ENVIRONMENT: "staging" } })).status).toBe(403);
    });

    it("never lets people change their own role or configured owners", async () => {
        expect((await apiCall("POST", "/api/portal/users", { email: SECOND_OWNER, role: "viewer" })).status).toBe(422);
        expect((await apiCall("POST", "/api/portal/users", { email: OWNER, role: "viewer" })).status).toBe(422);
    });

    it("requires a valid token on workers.dev and preview hostnames too", async () => {
        for (const host of ["dalyidau.example.workers.dev", "abc123-dalyidau.example.workers.dev"]) {
            expect((await call("/portal/wedding", { host })).status).toBe(401);
            expect((await call("/api/portal/wedding/guests", { host })).status).toBe(401);
            expect((await call("/portal/wedding", { host, token: await accessToken() })).status).toBe(200);
        }
    });

    it("refuses API requests started by another site, even reads", async () => {
        const token = await accessToken();
        for (const site of ["cross-site", "same-site"]) {
            const response = await call("/api/portal/export/guests.csv", { token, headers: { "Sec-Fetch-Site": site } });
            expect(response.status).toBe(403);
        }
        expect((await call("/api/portal/me", { token, headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
        expect(await auditActions()).not.toContain("export.guests");
    });

    it("never lets portal responses be cached, including errors", async () => {
        const token = await accessToken();
        const responses = [
            await call("/portal/wedding", { token }),
            await call("/portal/wedding/nope", { token }),
            await call("/portal/wedding"),
            await call("/api/portal/me", { token }),
            await call("/api/portal/me"),
            await call("/api/portal/nope", { token }),
            await call("/api/portal/export/guests.csv", { token }),
        ];
        for (const response of responses) expect(response.headers.get("Cache-Control")).toBe("no-store");
    });

    it("keeps owner emails and Access settings out of the page for other users", async () => {
        await apiCall("POST", "/api/portal/users", { email: "viewer@example.com", role: "viewer" });
        const html = await (await call("/portal/settings", { token: await accessToken({ email: "viewer@example.com" }) })).text();
        expect(html).not.toContain(OWNER);
        expect(html).not.toContain(SECOND_OWNER);
        expect(html).not.toContain(AUD);
        expect(html).not.toContain(TEAM);
    });

    it("lets only owners and admins change where the RSVP button sends guests", async () => {
        await apiCall("POST", "/api/portal/users", { email: "editor@example.com", role: "editor" });
        const body = { externalUrl: "https://evil.example/rsvp", deadline: "", collectDietary: true, collectMessage: true };
        expect((await apiCall("PUT", "/api/portal/settings/rsvp", body, { email: "editor@example.com" })).status).toBe(403);
    });

    it("protects every portal endpoint: no token → 401, viewer writing → 403", async () => {
        await apiCall("POST", "/api/portal/users", { email: "viewer@example.com", role: "viewer" });
        const writes: [string, string][] = [
            ["POST", "/api/portal/wedding/guests"],
            ["PATCH", "/api/portal/wedding/guests/gst_x"],
            ["DELETE", "/api/portal/wedding/guests/gst_x"],
            ["PUT", "/api/portal/wedding/guests/gst_x/rsvp"],
            ["POST", "/api/portal/wedding/guests/bulk"],
            ["POST", "/api/portal/wedding/guests/import"],
            ["POST", "/api/portal/wedding/guests/import/preview"],
            ["POST", "/api/portal/wedding/households/invitations"],
            ["DELETE", "/api/portal/wedding/households/hh_x"],
            ["POST", "/api/portal/wedding/households/hh_x/code"],
            ["POST", "/api/portal/wedding/households/hh_x/invitation"],
            ["POST", "/api/portal/wedding/events"],
            ["POST", "/api/portal/wedding/tasks"],
            ["POST", "/api/portal/wedding/timeline"],
            ["POST", "/api/portal/wedding/templates"],
            ["POST", "/api/portal/wedding/custom-fields"],
            ["POST", "/api/portal/wedding/messages"],
            ["POST", "/api/portal/wedding/messages/msg_x/send"],
            ["POST", "/api/portal/wedding/messages/msg_x/unschedule"],
            ["POST", "/api/portal/wedding/rsvp-questions"],
            ["PATCH", "/api/portal/wedding/rsvp-questions/rq_x"],
            ["DELETE", "/api/portal/wedding/rsvp-questions/rq_x"],
            ["PUT", "/api/portal/settings/wedding"],
            ["PUT", "/api/portal/settings/website"],
            ["PUT", "/api/portal/settings/rsvp"],
            ["PUT", "/api/portal/settings/privacy"],
            ["PUT", "/api/portal/flags/rsvp.native"],
            ["POST", "/api/portal/users"],
            ["POST", "/api/portal/privacy/restore"],
            ["POST", "/api/portal/privacy/erase"],
            ["POST", "/api/portal/privacy/retention"],
            ["POST", "/api/portal/wedding/rsvp-test/lookup"],
        ];
        for (const [method, path] of writes) {
            const anonymous = await call(path, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" });
            expect(anonymous.status, `${method} ${path} without a token`).toBe(401);
            const viewer = await apiCall(method, path, {}, { email: "viewer@example.com" });
            expect(viewer.status, `${method} ${path} as viewer`).toBe(403);
        }
        for (const path of [
            "/api/portal/export/guests.csv",
            "/api/portal/export/invitations.csv",
            "/api/portal/export/all.json",
            "/api/portal/wedding/guests/imports",
            "/api/portal/wedding/guests/imports/imp_x/report.csv",
            "/api/portal/audit",
            "/api/portal/users",
            "/api/portal/privacy/deleted",
            "/api/portal/wedding/budget-items",
        ]) {
            expect((await call(path)).status, path).toBe(401);
            expect((await apiCall("GET", path, undefined, { email: "viewer@example.com" })).status, `${path} as viewer`).toBe(403);
        }
    });

    it("keeps /portal out of robots.txt", async () => {
        const robots = await (await SELF.fetch("https://daly.id.au/robots.txt")).text();
        expect(robots).toContain("Disallow: /portal");
    });
});
