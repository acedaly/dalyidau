// Wedding Planner as an installable app (worker/portal/pwa.ts), and the portal listing only Wedding
// Planner while Portal settings → Features → "Other applications" is off (the default). Hiding is
// navigation only: the other applications' pages, API and MCP tools keep working.
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { beforeEach, describe, expect, it } from "vitest";
import { PortalApp } from "../src/portal/portal-app";
import { isApplicationListed, listedApplications } from "../src/shared/portal/applications";
import { FLAG_DEFINITIONS, defaultFlags } from "../src/shared/portal/flags";
import { FLAG_AREAS } from "../src/shared/portal/settings-sections";
import type { PortalPageData } from "../src/shared/portal/types";
import { type PortalMcpResponse, handleMcpCall } from "../worker/mcp/entrypoint";
import { APP_SCOPE, START_URL, offlineDocument, serviceWorkerScript, shellStylesheets } from "../worker/portal/pwa";
import { accessToken, apiCall, auditActions, portalEnv, call as rawCall, resetPortal } from "./portal-helpers";

const MCP_AUD = "aud-mcp-gateway-0123456789abcdef";
const OTHER_APPS = ["calendar", "intelligence", "intelligence-centre", "assets", "finance"];

const renderPage = (html: string) => {
    const json = /<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(html)?.[1];
    const payload = JSON.parse(json!) as { data: PortalPageData; path: string };
    return { data: payload.data, html: renderToString(createElement(PortalApp, { data: payload.data, path: payload.path })) };
};
const page = async (path: string) => renderPage(await (await rawCall(path, { token: await accessToken() })).text());
const setOtherApplications = async (enabled: boolean) =>
    expect((await apiCall("PUT", "/api/portal/flags/portal.other_applications", { enabled })).status).toBe(200);

beforeEach(resetPortal);

describe("only Wedding Planner in the portal's navigation", () => {
    it("is a reversible switch that defaults off and lives in Portal settings → Features", () => {
        expect(FLAG_DEFINITIONS["portal.other_applications"].default).toBe(false);
        expect(FLAG_AREAS["portal.other_applications"]).toBe("portal");
        const owner = { permissions: ["wedding.view", "calendar.use", "intelligence.use", "centre.use", "assets.use", "finance.use"] as const };
        expect(listedApplications(owner, defaultFlags()).map((a) => a.id)).toEqual(["wedding"]);
        expect(listedApplications(owner, { "portal.other_applications": true }).map((a) => a.id)).toEqual(["wedding", ...OTHER_APPS]);
        expect(isApplicationListed("today", defaultFlags())).toBe(false);
    });

    it("lists only Wedding Planner on the launcher and in the sidebar until switched on, then everything again", async () => {
        const home = await page("/portal");
        expect(home.data).toMatchObject({ route: "portal-home", applications: ["wedding"] });
        expect(home.html).toContain('data-application="wedding"');
        for (const app of OTHER_APPS) expect(home.html).not.toContain(`data-application="${app}"`);
        expect(home.html).not.toContain('data-portal-link="today"');
        expect(home.html).not.toContain('href="/portal/today"');
        const wedding = await page("/portal/wedding");
        expect(wedding.html).not.toContain('href="/portal/today"');
        expect(wedding.html).toContain('href="/portal/wedding/guests"');

        await setOtherApplications(true);
        expect(await auditActions()).toContain("flag.update");
        const all = await page("/portal");
        for (const app of ["wedding", ...OTHER_APPS]) expect(all.html).toContain(`data-application="${app}"`);
        expect(all.html).toContain('data-portal-link="today"');
        expect((await page("/portal/wedding")).html).toContain('href="/portal/today"');
    });

    it("keeps the hidden applications' pages, API and MCP tools working", async () => {
        const token = await accessToken();
        for (const path of ["/portal/today", "/portal/calendar", "/portal/intelligence", "/portal/intelligence-centre", "/portal/assets", "/portal/finance"])
            expect((await rawCall(path, { token })).status, path).toBe(200);
        // Inside a hidden application, its own navigation is still there.
        expect((await page("/portal/calendar")).html).toContain('href="/portal/calendar/leave"');
        expect((await apiCall("GET", "/api/portal/calendar/calendars")).status).toBe(200);
        const mcp = (await handleMcpCall(await portalEnv({ MCP_ACCESS_AUD: MCP_AUD }), {
            assertion: await accessToken({ aud: [MCP_AUD] }),
            tool: "calendar_list_calendars",
            input: {},
        })) as PortalMcpResponse;
        expect(mcp.ok).toBe(true);
    });
});

describe("installable Wedding Planner", () => {
    it("links the manifest from every portal page, with the app's icons", async () => {
        const html = await (await rawCall("/portal/wedding", { token: await accessToken() })).text();
        expect(html).toContain('<link rel="manifest" href="/portal/manifest.webmanifest" crossorigin="use-credentials"');
        expect(html).toContain('<link rel="apple-touch-icon" href="/icons/wedding-planner-apple-180.png"');
    });

    it("serves a manifest that launches straight into the wedding dashboard", async () => {
        const response = await rawCall("/portal/manifest.webmanifest", { token: await accessToken() });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toContain("application/manifest+json");
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        const manifest = (await response.json()) as Record<string, unknown> & { icons: { src: string; sizes: string; purpose: string }[] };
        expect(manifest).toMatchObject({
            id: "/portal/wedding",
            start_url: "/portal/wedding",
            scope: "/portal",
            display: "standalone",
            name: "Wedding Planner",
        });
        expect(START_URL.startsWith(APP_SCOPE)).toBe(true);
        expect(manifest.icons.some((i) => i.sizes === "192x192")).toBe(true);
        expect(manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "any")).toBe(true);
        expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    });

    it("keeps the manifest, service worker and offline page behind sign-in", async () => {
        for (const path of ["/portal/manifest.webmanifest", "/portal/sw.js", "/portal/offline"]) {
            const response = await rawCall(path, { token: null });
            expect(response.status, path).toBeGreaterThanOrEqual(401);
            expect(await response.text()).not.toContain("Wedding Planner");
        }
    });

    it("serves a service worker for the whole portal that never caches pages or data", async () => {
        const response = await rawCall("/portal/sw.js", { token: await accessToken() });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toContain("javascript");
        expect(response.headers.get("Service-Worker-Allowed")).toBe("/portal");
        const script = await response.text();
        expect(script).toMatch(/const CACHE = "wedding-planner-[0-9a-f]+";/);
        const precache = JSON.parse(/const PRECACHE = (\[.*\]);/.exec(script)![1]) as string[];
        expect(precache).toContain("/portal/offline");
        expect(precache.some((url) => /^\/assets\/.+\.css$/.test(url))).toBe(true);
        // Only the offline page and static files: never a portal page, the API or media.
        for (const url of precache) expect(url).toMatch(/^(\/portal\/offline|\/assets\/|\/icons\/|\/theme-init\.js$)/);
        expect(script).not.toMatch(/\/api\/|\/media\//);
    });

    it("has an offline page with no scripts or data, only the portal's stylesheet", async () => {
        const response = await rawCall("/portal/offline", { token: await accessToken() });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("You're offline");
        expect(html).toContain("data-portal-offline");
        expect(html).not.toContain('type="module"');
        expect(html).not.toContain("modulepreload");
        expect(html).not.toContain('id="page-data"');
        expect(html).toMatch(/<link rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/);
    });

    it("builds the worker script and offline page from the portal shell", () => {
        const shell = `<html><head><!--app-head-->
      <script type="module" crossorigin src="/assets/portal-abc.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/apps-abc.js">
      <link rel="stylesheet" crossorigin href="/assets/apps-abc.css">
    </head><body><div id="root"><!--app-html--></div><!--app-data--></body></html>`;
        expect(shellStylesheets(shell)).toEqual(["/assets/apps-abc.css"]);
        const offline = offlineDocument(shell, "AD");
        expect(offline).not.toContain("<script");
        expect(offline).toContain("/assets/apps-abc.css");
        expect(offline).toContain("<title>Offline · Wedding Planner</title>");
        expect(serviceWorkerScript("v1", shell)).toContain('"wedding-planner-v1"');
    });
});
