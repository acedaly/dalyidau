// The retired admin apps (Phase 3: Payload at daly.id.au/admin is the only administration). The portal's
// pages and Wedding Planner, the installable phone app, at /portal/planner and weddingplanner.daly.id.au,
// no longer serve anything of their own: people are sent to Payload, an installed app's service worker
// removes itself, and the API is closed on the app's address.
import { describe, expect, it } from "vitest";
import { ORIGIN, accessToken, apiCall, call, portalEnv, resetPortal } from "./portal-helpers";

const PLANNER_HOST = "weddingplanner.daly.id.au";
const onPlannerHost = async (path: string, init: RequestInit & { token?: string | null } = {}) =>
    call(path, { token: await accessToken(), ...init, host: PLANNER_HOST, env: await portalEnv({ PLANNER_URL: `https://${PLANNER_HOST}` }) });

describe("the retired portal", () => {
    it("sends /portal and the phone app's pages to the wedding admin in Payload, after sign-in", async () => {
        await resetPortal();
        const token = await accessToken();
        for (const path of ["/portal", "/portal/planner", "/portal/planner/guests", "/portal/planner/offline"]) {
            const response = await call(path, { token });
            expect(response.status, path).toBe(302);
            expect(response.headers.get("Location"), path).toBe(`${ORIGIN}/admin/wedding`);
        }
        expect((await call("/portal", { token: null })).status).toBe(401);
    });

    it("serves a service worker that removes installed copies of the old apps", async () => {
        const token = await accessToken();
        for (const path of ["/portal/sw.js", "/portal/planner/sw.js"]) {
            const response = await call(path, { token });
            expect(response.status, path).toBe(200);
            expect(response.headers.get("Content-Type")).toContain("javascript");
            const script = await response.text();
            expect(script).toContain("unregister()");
            expect(script).not.toMatch(/cache\.(put|add)/);
        }
    });
});

describe("weddingplanner.daly.id.au, retired", () => {
    it("sends people to the wedding admin in Payload and retires the app's service worker", async () => {
        const page = await onPlannerHost("/guests", { token: null });
        expect(page.status).toBe(302);
        expect(page.headers.get("Location")).toBe("https://daly.id.au/admin/wedding");
        expect(page.headers.get("Cache-Control")).toBe("no-store");
        const sw = await onPlannerHost("/sw.js", { token: null });
        expect(sw.status).toBe(200);
        expect(await sw.text()).toContain("unregister()");
    });

    it("answers no API at all there, even to a signed-in owner", async () => {
        await resetPortal();
        for (const path of ["/api/portal/me", "/api/portal/dashboard", "/api/portal/wedding/guests"]) {
            const response = await onPlannerHost(path);
            expect(response.status, path).toBe(404);
            expect(await response.text()).not.toContain("guest");
        }
        const write = await onPlannerHost("/api/portal/wedding/tasks", {
            method: "POST",
            headers: { Origin: `https://${PLANNER_HOST}`, "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Should not exist" }),
        });
        expect(write.status).toBe(404);
        // The same API still works for Payload's screens on daly.id.au.
        expect((await apiCall("GET", "/api/portal/me")).status).toBe(200);
    });
});
