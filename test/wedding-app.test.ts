// Wedding Planner, the installable phone app (docs/PLANNER.md), at /portal/planner on daly.id.au. Retired
// with the portal on 11 Nov 2026 and restored on 13 Nov 2026 as the phone companion to the Payload admin.
// Its first host, weddingplanner.daly.id.au, has no Access destination, so it only redirects here.
import { beforeEach, describe, expect, it } from "vitest";
import type { PlannerPageData } from "../src/shared/planner/types";
import { RETIRED_APP_WORKER, offlineDocument, plannerView, serviceWorkerScript, shellStylesheets } from "../worker/planner/pwa";
import { ORIGIN, accessToken, apiCall, auditActions, call, portalEnv, resetPortal } from "./portal-helpers";

const PLANNER_HOST = "weddingplanner.daly.id.au";

const pageData = <T>(html: string) => {
    const json = /<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(html)?.[1];
    return JSON.parse(json!) as { area: string; data: T; path: string };
};
const onPlannerHost = async (path: string, init: RequestInit & { token?: string | null } = {}) =>
    call(path, { token: await accessToken(), ...init, host: PLANNER_HOST, env: await portalEnv({ PLANNER_URL: `https://${PLANNER_HOST}` }) });

beforeEach(resetPortal);

describe("Wedding Planner at /portal/planner", () => {
    it("serves the app for each of its views, and nothing else under it", async () => {
        const token = await accessToken();
        const home = await call("/portal/planner", { token });
        expect(home.status).toBe(200);
        expect(home.headers.get("Cache-Control")).toBe("no-store");
        expect(home.headers.get("X-Robots-Tag")).toContain("noindex");
        const html = await home.text();
        const payload = pageData<PlannerPageData>(html);
        expect(payload.area).toBe("planner");
        expect(payload.data).toMatchObject({ base: "/portal/planner", view: "home", portalUrl: `${ORIGIN}/admin/wedding` });
        expect(payload.data.context.user.email).toBe("owner@example.com");
        expect(html).toContain('<link rel="manifest" href="/portal/planner/manifest.webmanifest" crossorigin="use-credentials">');
        expect(html).toContain('<link rel="apple-touch-icon" href="/icons/wedding-planner-apple-180.png"');
        expect(html).toContain("assets/planner-");
        for (const view of ["guests", "tasks", "budget", "more", "seating", "timeline", "suppliers"]) {
            const response = await call(`/portal/planner/${view}`, { token });
            expect(response.status, view).toBe(200);
            expect(pageData<PlannerPageData>(await response.text()).data.view).toBe(view);
        }
        for (const path of ["/portal/planner/home", "/portal/planner/nope", "/portal/planner/guests/1"])
            expect((await call(path, { token })).status, path).toBe(404);
        const slash = await call("/portal/planner/guests/", { token });
        expect(slash.status).toBe(301);
        expect(slash.headers.get("Location")).toBe(`${ORIGIN}/portal/planner/guests`);
        expect(plannerView("/")).toBe("home");
    });

    it("needs sign-in like every portal address", async () => {
        for (const path of ["/portal/planner", "/portal/planner/manifest.webmanifest", "/portal/planner/sw.js", "/portal/planner/offline"]) {
            const response = await call(path, { token: null });
            expect(response.status, path).toBe(401);
            expect(await response.text()).not.toContain("page-data");
        }
    });

    it("has a manifest that installs it as Wedding Planner", async () => {
        const response = await call("/portal/planner/manifest.webmanifest", { token: await accessToken() });
        expect(response.headers.get("Content-Type")).toContain("application/manifest+json");
        const manifest = (await response.json()) as Record<string, unknown> & { icons: { sizes: string; purpose: string }[] };
        expect(manifest).toMatchObject({
            name: "Wedding Planner",
            short_name: "Wedding",
            start_url: "/portal/planner",
            scope: "/portal/planner",
            display: "standalone",
        });
        expect(manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
        expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    });

    it("has a service worker that never caches pages or data, and an offline page with neither scripts nor data", async () => {
        const token = await accessToken();
        const sw = await call("/portal/planner/sw.js", { token });
        expect(sw.headers.get("Content-Type")).toContain("javascript");
        expect(sw.headers.get("Service-Worker-Allowed")).toBe("/portal/planner");
        const script = await sw.text();
        expect(script).toMatch(/const CACHE = "planner-[0-9a-f]+";/);
        const precache = JSON.parse(/const PRECACHE = (\[.*\]);/.exec(script)![1]) as string[];
        expect(precache).toContain("/portal/planner/offline");
        expect(precache.some((url) => /^\/assets\/.+\.css$/.test(url))).toBe(true);
        for (const url of precache) expect(url).toMatch(/^(\/portal\/planner\/offline|\/assets\/|\/icons\/|\/theme-init\.js$)/);
        expect(script).not.toMatch(/\/api\/|\/media\//);

        const offline = await (await call("/portal/planner/offline", { token })).text();
        expect(offline).toContain("You're offline");
        expect(offline).not.toContain('type="module"');
        expect(offline).not.toContain('id="page-data"');
        expect(offline).toContain(`href="${ORIGIN}/admin/wedding"`);
    });

    it("builds the worker script and offline page from the app shell", () => {
        const shell = `<html><head><!--app-head-->
      <script type="module" crossorigin src="/assets/planner-abc.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/apps-abc.js">
      <link rel="stylesheet" crossorigin href="/assets/apps-abc.css">
    </head><body><div id="root"><!--app-html--></div><!--app-data--></body></html>`;
        expect(shellStylesheets(shell)).toEqual(["/assets/apps-abc.css"]);
        const offline = offlineDocument(shell, "https://daly.id.au/admin/wedding");
        expect(offline).not.toContain("<script");
        expect(offline).toContain("/assets/apps-abc.css");
        expect(serviceWorkerScript("v1", shell, "/portal/planner")).toContain('"planner-v1"');
    });

    it("reads and writes through the admin's wedding API, audited like any change", async () => {
        const created = await apiCall("POST", "/api/portal/wedding/tasks", { title: "Book the florist" });
        expect(created.status).toBe(201);
        expect(await auditActions()).toContain("task.create");
    });
});

describe("old service workers", () => {
    it("/portal/sw.js still retires the first release's portal-wide worker, without touching the app's cache", async () => {
        const token = await accessToken();
        const retired = await call("/portal/sw.js", { token });
        expect(retired.status).toBe(200);
        const script = await retired.text();
        expect(script).toContain("self.registration.unregister()");
        expect(script).not.toContain('addEventListener("fetch"');
        expect(script).toContain('startsWith("wedding-planner-")');
        expect(RETIRED_APP_WORKER).not.toMatch(/startsWith\("planner-"\)/);
        expect((await call("/portal/manifest.webmanifest", { token })).status).toBe(302);
    });
});

describe("weddingplanner.daly.id.au", () => {
    it("redirects to the same view on daly.id.au and retires the service worker an old install left there", async () => {
        const page = await onPlannerHost("/guests", { token: null });
        expect(page.status).toBe(302);
        expect(page.headers.get("Location")).toBe(`${ORIGIN}/portal/planner/guests`);
        expect(page.headers.get("Cache-Control")).toBe("no-store");
        expect((await onPlannerHost("/", { token: null })).headers.get("Location")).toBe(`${ORIGIN}/portal/planner`);
        expect((await onPlannerHost("/tasks", { token: null })).headers.get("Location")).toBe(`${ORIGIN}/portal/planner/tasks`);
        const sw = await onPlannerHost("/sw.js", { token: null });
        expect(sw.status).toBe(200);
        expect(await sw.text()).toContain("unregister()");
    });

    it("answers no API at all there, even to a signed-in owner", async () => {
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
        expect((await apiCall("GET", "/api/portal/me")).status).toBe(200);
    });
});
