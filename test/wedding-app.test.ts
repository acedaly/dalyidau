// Wedding Planner, the installable phone app (docs/PLANNER.md), at /portal/planner and on its own
// address (PLANNER_URL), and the portal opening on Wedding Planner, its only application since the
// others were retired (docs/DECOMMISSION_PORTAL_APPS.md).
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { beforeEach, describe, expect, it } from "vitest";
import { PortalApp } from "../src/portal/portal-app";
import type { PlannerPageData } from "../src/shared/planner/types";
import type { PortalPageData } from "../src/shared/portal/types";
import { offlineDocument, plannerView, serviceWorkerScript, shellStylesheets } from "../worker/planner/pwa";
import { accessToken, auditActions, portalEnv, call as rawCall, resetPortal } from "./portal-helpers";

const PLANNER_HOST = "weddingplanner.daly.id.au";

const pageData = <T>(html: string) => {
    const json = /<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(html)?.[1];
    return JSON.parse(json!) as { area: string; data: T; path: string };
};
const renderPage = (html: string) => {
    const payload = pageData<PortalPageData>(html);
    return { data: payload.data, html: renderToString(createElement(PortalApp, { data: payload.data, path: payload.path })) };
};
const page = async (path: string) => renderPage(await (await rawCall(path, { token: await accessToken() })).text());
/** A request to Wedding Planner's own address. */
const onHost = async (path: string, init: RequestInit & { token?: string | null } = {}) =>
    rawCall(path, { token: await accessToken(), ...init, host: PLANNER_HOST, env: await portalEnv({ PLANNER_URL: `https://${PLANNER_HOST}` }) });

beforeEach(resetPortal);

describe("the portal opens on Wedding Planner", () => {
    it("sends /portal to Wedding Planner's dashboard, after sign-in", async () => {
        const response = await rawCall("/portal", { token: await accessToken() });
        expect(response.status).toBe(302);
        expect(response.headers.get("Location")).toBe("https://daly.id.au/portal/wedding");
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect((await rawCall("/portal", { token: null })).status).toBe(401);
    });

    it("lists only Wedding Planner's own pages and the portal's, with the phone app one tap away", async () => {
        const wedding = await page("/portal/wedding");
        expect(wedding.data.route).toBe("dashboard");
        expect(wedding.html).toContain('href="/portal/wedding/guests"');
        expect(wedding.html).toContain('href="/portal/planner"');
        expect(wedding.html).toContain('href="/portal/settings"');
        expect(wedding.html).not.toMatch(/href="\/portal\/(today|calendar|intelligence|intelligence-centre)["/?]|href="\/portal"/);
        // Portal settings keeps Wedding Planner's navigation, so there's always a way back.
        expect((await page("/portal/settings")).html).toContain('href="/portal/wedding/guests"');
    });
});

describe("Wedding Planner at /portal/planner", () => {
    it("serves the app for each of its views, and nothing else under it", async () => {
        const token = await accessToken();
        const home = await rawCall("/portal/planner", { token });
        expect(home.status).toBe(200);
        expect(home.headers.get("Cache-Control")).toBe("no-store");
        const html = await home.text();
        const payload = pageData<PlannerPageData>(html);
        expect(payload.area).toBe("planner");
        expect(payload.data).toMatchObject({ base: "/portal/planner", view: "home", portalUrl: "https://daly.id.au/portal/wedding" });
        expect(payload.data.context.user.email).toBe("owner@example.com");
        expect(html).toContain('<link rel="manifest" href="/portal/planner/manifest.webmanifest" crossorigin="use-credentials">');
        expect(html).toContain('<link rel="apple-touch-icon" href="/icons/wedding-planner-apple-180.png"');
        expect(html).toContain("assets/planner-");
        for (const view of ["guests", "tasks", "budget", "more", "seating", "timeline", "suppliers"]) {
            const response = await rawCall(`/portal/planner/${view}`, { token });
            expect(response.status, view).toBe(200);
            expect(pageData<PlannerPageData>(await response.text()).data.view).toBe(view);
        }
        for (const path of ["/portal/planner/home", "/portal/planner/nope", "/portal/planner/guests/1"])
            expect((await rawCall(path, { token })).status, path).toBe(404);
        expect(plannerView("/")).toBe("home");
    });

    it("needs sign-in like every portal address", async () => {
        for (const path of ["/portal/planner", "/portal/planner/manifest.webmanifest", "/portal/planner/sw.js", "/portal/planner/offline"]) {
            const response = await rawCall(path, { token: null });
            expect(response.status, path).toBe(401);
            expect(await response.text()).not.toContain("page-data");
        }
    });

    it("has a manifest that installs it as Wedding Planner", async () => {
        const response = await rawCall("/portal/planner/manifest.webmanifest", { token: await accessToken() });
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
        const sw = await rawCall("/portal/planner/sw.js", { token });
        expect(sw.headers.get("Content-Type")).toContain("javascript");
        expect(sw.headers.get("Service-Worker-Allowed")).toBe("/portal/planner");
        const script = await sw.text();
        expect(script).toMatch(/const CACHE = "planner-[0-9a-f]+";/);
        const precache = JSON.parse(/const PRECACHE = (\[.*\]);/.exec(script)![1]) as string[];
        expect(precache).toContain("/portal/planner/offline");
        expect(precache.some((url) => /^\/assets\/.+\.css$/.test(url))).toBe(true);
        for (const url of precache) expect(url).toMatch(/^(\/portal\/planner\/offline|\/assets\/|\/icons\/|\/theme-init\.js$)/);
        expect(script).not.toMatch(/\/api\/|\/media\//);

        const offline = await (await rawCall("/portal/planner/offline", { token })).text();
        expect(offline).toContain("You're offline");
        expect(offline).not.toContain('type="module"');
        expect(offline).not.toContain('id="page-data"');
        expect(offline).toContain('href="https://daly.id.au/portal/wedding"');
    });

    it("builds the worker script and offline page from the app shell", () => {
        const shell = `<html><head><!--app-head-->
      <script type="module" crossorigin src="/assets/planner-abc.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/apps-abc.js">
      <link rel="stylesheet" crossorigin href="/assets/apps-abc.css">
    </head><body><div id="root"><!--app-html--></div><!--app-data--></body></html>`;
        expect(shellStylesheets(shell)).toEqual(["/assets/apps-abc.css"]);
        const offline = offlineDocument(shell, "https://daly.id.au/portal/wedding");
        expect(offline).not.toContain("<script");
        expect(offline).toContain("/assets/apps-abc.css");
        expect(serviceWorkerScript("v1", shell, "")).toContain('"planner-v1"');
        expect(serviceWorkerScript("v1", shell, "")).toContain('"/offline"');
    });

    it("retires the first release's portal-wide service worker; the portal itself is no longer installable", async () => {
        const token = await accessToken();
        const retired = await rawCall("/portal/sw.js", { token });
        expect(retired.status).toBe(200);
        const script = await retired.text();
        expect(script).toContain("self.registration.unregister()");
        expect(script).not.toContain('addEventListener("fetch"');
        expect((await rawCall("/portal/manifest.webmanifest", { token })).status).toBe(404);
        expect((await rawCall("/portal/offline", { token })).status).toBe(404);
        expect(await (await rawCall("/portal/wedding", { token })).text()).not.toContain('rel="manifest"');
    });
});

describe("Wedding Planner on its own address", () => {
    it("serves the app at the root, with its own manifest and service worker", async () => {
        const home = await onHost("/");
        expect(home.status).toBe(200);
        expect(pageData<PlannerPageData>(await home.text()).data).toMatchObject({ base: "", view: "home" });
        expect(pageData<PlannerPageData>(await (await onHost("/guests")).text()).data.view).toBe("guests");
        const manifest = (await (await onHost("/manifest.webmanifest")).json()) as Record<string, unknown>;
        expect(manifest).toMatchObject({ start_url: "/", scope: "/" });
        const sw = await onHost("/sw.js");
        expect(sw.headers.get("Service-Worker-Allowed")).toBe("/");
        expect(await sw.text()).toContain('const OFFLINE = "/offline";');
        expect((await onHost("/guests/")).headers.get("Location")).toBe(`https://${PLANNER_HOST}/guests`);
    });

    it("answers only the app and the wedding API there", async () => {
        for (const path of ["/portal", "/portal/wedding", "/portal/planner", "/wedding", "/feed.xml", "/home"])
            expect((await onHost(path)).status, path).toBe(404);
        expect((await onHost("/api/portal/wedding/guests")).status).toBe(200);
        expect((await onHost("/api/portal/dashboard")).status).toBe(200);
        for (const path of ["/api/portal/calendar/calendars", "/api/portal/users", "/api/portal/audit", "/api/admin/sync"])
            expect((await onHost(path)).status, path).toBe(404);
    });

    it("accepts changes from its own origin, recorded in the audit log like any portal change", async () => {
        const headers = { "Content-Type": "application/json" };
        const created = await onHost("/api/portal/wedding/tasks", {
            method: "POST",
            headers: { ...headers, Origin: `https://${PLANNER_HOST}` },
            body: JSON.stringify({ title: "Book the florist" }),
        });
        expect(created.status).toBe(201);
        expect(await auditActions()).toContain("task.create");
        const foreign = await onHost("/api/portal/wedding/tasks", {
            method: "POST",
            headers: { ...headers, Origin: "https://evil.example" },
            body: JSON.stringify({ title: "x" }),
        });
        expect(foreign.status).toBe(403);
    });

    it("refuses everyone until Cloudflare Access protects the address, and says where the app is meanwhile", async () => {
        const response = await onHost("/", { token: null });
        expect(response.status).toBe(401);
        const html = await response.text();
        expect(html).toContain("Sign-in isn't set up for this address yet.");
        expect(html).toContain('href="https://daly.id.au/portal/planner"');
        expect(html).not.toContain("page-data");
        expect((await onHost("/api/portal/wedding/guests", { token: null })).status).toBe(401);
    });
});
