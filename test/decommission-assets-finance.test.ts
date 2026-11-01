// Home & Assets and Household Finance are retired (docs/DECOMMISSION_ASSETS_FINANCE.md), replaced by
// Home and Finances in Cloudflare OS. These are the regression tests for the retirement as a whole:
// nothing of them is offered, their pages and APIs answer 410 with a message that names them (after
// the usual sign-in and role checks), settings stored while they existed still load, and their
// records stay in the database untouched. Every identity and record is fictional.
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { beforeEach, describe, expect, it } from "vitest";
import { PortalApp } from "../src/portal/portal-app";
import { APPLICATIONS } from "../src/shared/portal/applications";
import { FLAG_KEYS } from "../src/shared/portal/flags";
import { PERMISSIONS, ROLE_PERMISSIONS } from "../src/shared/portal/permissions";
import { FEATURE_AREAS } from "../src/shared/portal/settings-sections";
import type { PortalPageData } from "../src/shared/portal/types";
import { loadFlags } from "../worker/portal/flags";
import { OWNER, SECOND_OWNER, accessToken, apiCall, call, db, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);

const ADMIN = "admin@example.com";
const EDITOR = "editor@example.com";

const render = async (path: string, email = OWNER) => {
    const response = await call(path, { token: await accessToken({ email }) });
    const html = await response.text();
    const json = /<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(html)?.[1];
    const payload = json ? (JSON.parse(json) as { data: PortalPageData; path: string }) : null;
    return { response, data: payload?.data, html: payload ? renderToString(createElement(PortalApp, { data: payload.data, path: payload.path })) : "" };
};

const ASSETS_MESSAGE = /Home & Assets has been retired and replaced by Home in Cloudflare OS/;
const FINANCE_MESSAGE = /Household Finance has been retired and replaced by Finances in Cloudflare OS/;

/** Tables the two applications kept. They stay until the owner approves their removal. */
const RETAINED = [
    "assets",
    "asset_preferences",
    "asset_categories",
    "asset_locations",
    "asset_shares",
    "asset_vehicles",
    "asset_maintenance",
    "asset_schedules",
    "asset_policies",
    "asset_warranties",
    "asset_files",
    "asset_notifications",
    "asset_activity",
    "finance_accounts",
    "finance_categories",
    "finance_imports",
    "finance_import_rows",
    "finance_transactions",
    "finance_transfers",
    "finance_reconciliations",
    "finance_activity",
];

describe("nothing of Home & Assets or Household Finance is offered", () => {
    it("has no application, permission, switch or navigation link for them", () => {
        expect(APPLICATIONS.map((a) => a.id)).not.toContain("assets" as never);
        expect(APPLICATIONS.map((a) => a.id)).not.toContain("finance" as never);
        expect(PERMISSIONS).not.toContain("assets.use" as never);
        expect(PERMISSIONS).not.toContain("finance.use" as never);
        for (const role of Object.values(ROLE_PERMISSIONS)) expect(role.join(" ")).not.toMatch(/assets|finance/);
        expect(FLAG_KEYS.join(" ")).not.toMatch(/assets\./);
        expect(FEATURE_AREAS).not.toContain("assets" as never);
        const links = APPLICATIONS.flatMap((a) => a.navigation.flatMap((s) => s.items.map((i) => i.href)));
        expect(links.filter((href) => /^\/portal\/(assets|finance)(\/|$)/.test(href))).toEqual([]);
    });

    it("shows no launcher card, sidebar link or section for them, on any page", async () => {
        await apiCall("PUT", "/api/portal/flags/portal.other_applications", { enabled: true });
        for (const path of ["/portal", "/portal/today", "/portal/calendar", "/portal/calendar/settings", "/portal/settings/features", "/portal/wedding"]) {
            const { response, html } = await render(path);
            expect(response.status, path).toBe(200);
            expect(html, path).not.toMatch(/href="\/portal\/(assets|finance)|data-application="(assets|finance)"|Home &amp; Assets|Household Finance/);
        }
    });

    it("Today has no Home & Assets section", async () => {
        const { data } = await render("/portal/today");
        expect(data?.route).toBe("today");
        expect(data).not.toHaveProperty("assets");
    });
});

describe("retired pages and APIs", () => {
    it("answer 410 with a message naming what replaced them, once signed in, whatever the role", async () => {
        await apiCall("POST", "/api/portal/users", { email: ADMIN, role: "admin" });
        await apiCall("POST", "/api/portal/users", { email: EDITOR, role: "editor" });
        for (const email of [OWNER, SECOND_OWNER, ADMIN, EDITOR]) {
            for (const [path, message] of [
                ["/portal/assets", ASSETS_MESSAGE],
                ["/portal/assets/maintenance", ASSETS_MESSAGE],
                ["/portal/assets/item/ast_aaaaaaaaaaaaaa", ASSETS_MESSAGE],
                ["/portal/assets/property/alo_aaaaaaaaaaaaaa", ASSETS_MESSAGE],
                ["/portal/finance", FINANCE_MESSAGE],
                ["/portal/finance/transactions", FINANCE_MESSAGE],
                ["/portal/finance/accounts/fac_aaaaaaaaaaaaaa", FINANCE_MESSAGE],
                ["/portal/finance/import/fim_aaaaaaaaaaaaaa", FINANCE_MESSAGE],
            ] as const) {
                const { response, data } = await render(path, email);
                expect(response.status, `${path} as ${email}`).toBe(410);
                expect(data?.route, path).toBe("forbidden");
                expect(JSON.stringify(data), path).toMatch(message);
            }
        }
        for (const [method, path, message] of [
            ["GET", "/api/portal/assets/overview", ASSETS_MESSAGE],
            ["GET", "/api/portal/assets/items", ASSETS_MESSAGE],
            ["POST", "/api/portal/assets/items", ASSETS_MESSAGE],
            ["GET", "/api/portal/assets/files/afl_aaaaaaaaaaaaaa/content", ASSETS_MESSAGE],
            ["GET", "/api/portal/finance/overview", FINANCE_MESSAGE],
            ["POST", "/api/portal/finance/accounts", FINANCE_MESSAGE],
            ["GET", "/api/portal/finance/transactions", FINANCE_MESSAGE],
            // Retired earlier with Knowledge and Tasks: they keep that answer.
            ["POST", "/api/portal/assets/tasks", /Daly Knowledge and Daly Tasks have been retired/],
            ["GET", "/api/portal/assets/items/ast_aaaaaaaaaaaaaa/knowledge", /Daly Knowledge and Daly Tasks have been retired/],
        ] as const) {
            const r = await apiCall<{ error: string; message: string }>(method, path, method === "GET" ? undefined : {});
            expect(r.status, `${method} ${path}`).toBe(410);
            expect(r.headers.get("Cache-Control")).toBe("no-store");
            expect(r.json).toMatchObject({ error: "retired" });
            expect(r.json.message).toMatch(message);
        }
    });

    it("still need Cloudflare Access: without a valid sign-in nothing says what was there", async () => {
        for (const path of ["/api/portal/assets/overview", "/api/portal/finance/overview"]) {
            const anonymous = await call(path);
            expect([401, 403], path).toContain(anonymous.status);
            expect(await anonymous.text()).not.toMatch(/retired/);
        }
        for (const path of ["/portal/assets", "/portal/finance"]) expect((await call(path)).status, path).not.toBe(410);
    });

    it("leave the Wedding Planner's budget alone", async () => {
        const page = await render("/portal/wedding/budget");
        expect(page.response.status).toBe(200);
    });
});

describe("settings stored while they existed", () => {
    it("still load: retired switches and calendar overlay choices are ignored, never an error", async () => {
        const now = new Date().toISOString();
        await db().batch([
            db()
                .prepare("INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('assets.ai', 1, ?, ?), ('assets.reminders.email', 1, ?, ?)")
                .bind(now, OWNER, now, OWNER),
            db()
                .prepare("INSERT INTO calendar_preferences (email, value, updated_at) VALUES (?, ?, ?)")
                .bind(
                    OWNER,
                    JSON.stringify({
                        timeZone: "Australia/Sydney",
                        weekStart: 0,
                        overlays: { holidays: false, school: true, leave: true, sharedLeave: true, assets: true },
                    }),
                    now,
                ),
        ]);
        const flags = await loadFlags(db());
        expect(Object.keys(flags).join(" ")).not.toMatch(/assets\./);
        expect((await render("/portal/settings/features")).response.status).toBe(200);
        const prefs = await apiCall<{ preferences: { weekStart: number; overlays: Record<string, boolean> } }>("GET", "/api/portal/calendar/preferences");
        expect(prefs.status).toBe(200);
        // The person's own choices survive; only the retired one is dropped.
        expect(prefs.json.preferences.weekStart).toBe(0);
        expect(prefs.json.preferences.overlays).toEqual({ holidays: false, school: true, leave: true, sharedLeave: true });
        expect((await apiCall("GET", "/api/portal/calendar/events?from=2026-11-01&to=2026-11-30")).status).toBe(200);
        expect((await render("/portal/calendar")).response.status).toBe(200);
        // An old browser tab that still sends the retired choice saves the rest.
        const saved = await apiCall<{ preferences: { overlays: Record<string, boolean> } }>("PUT", "/api/portal/calendar/preferences", {
            preferences: { ...prefs.json.preferences, overlays: { ...prefs.json.preferences.overlays, assets: true } },
        });
        expect(saved.status, saved.text).toBe(200);
        expect(saved.json.preferences.overlays).not.toHaveProperty("assets");
        // The stored switch rows are left as they were.
        expect((await db().prepare("SELECT COUNT(*) AS n FROM feature_flags WHERE key LIKE 'assets.%'").first<{ n: number }>())!.n).toBe(2);
    });
});

describe("records kept for an approved cleanup", () => {
    it("keeps every table, and neither the routes nor the scheduled jobs touch their rows", async () => {
        const tables = new Set((await db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name));
        for (const table of RETAINED) expect(tables.has(table), table).toBe(true);
        const now = new Date().toISOString();
        await db().batch([
            db()
                .prepare(
                    "INSERT INTO assets (id, owner_email, name, category, deleted_at, created_by, created_at, updated_by, updated_at) VALUES ('ast_aaaaaaaaaaaaaa', ?, 'Camper', 'trailers', ?, ?, ?, ?, ?)",
                )
                .bind(OWNER, "2026-01-01T00:00:00.000Z", OWNER, now, OWNER, now),
            db()
                .prepare(
                    "INSERT INTO finance_accounts (id, owner_email, name, kind, created_by, created_at, updated_by, updated_at) VALUES ('fac_aaaaaaaaaaaaaa', ?, 'Everyday', 'transaction', ?, ?, ?, ?)",
                )
                .bind(OWNER, OWNER, now, OWNER, now),
        ]);
        await apiCall("DELETE", "/api/portal/assets/items/ast_aaaaaaaaaaaaaa");
        await apiCall("PATCH", "/api/portal/finance/accounts/fac_aaaaaaaaaaaaaa", { name: "Changed" });
        // The scheduled jobs leave them alone too (the old one purged deleted assets).
        const { default: worker } = await import("../worker/index");
        const { createExecutionContext, waitOnExecutionContext, env } = await import("cloudflare:test");
        const ctx = createExecutionContext();
        await worker.scheduled({ scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry() {} } as never, env as never, ctx);
        await waitOnExecutionContext(ctx);
        expect(await db().prepare("SELECT name, deleted_at FROM assets").all()).toMatchObject({
            results: [{ name: "Camper", deleted_at: "2026-01-01T00:00:00.000Z" }],
        });
        expect(await db().prepare("SELECT name FROM finance_accounts").all()).toMatchObject({ results: [{ name: "Everyday" }] });
    });
});
