// Daly Knowledge and Daly Tasks are retired (docs/DECOMMISSION_KNOWLEDGE_TASKS.md). These are the
// regression tests for the retirement as a whole: nothing of them is visible, their pages and APIs
// answer 410 after the usual sign-in and role checks, their records stay in the database untouched
// (pending an approved cleanup), and the Wedding Planner's own tasks are unaffected. The other
// applications' own retirement checks live with them (today, intelligence, calendar, assets, centre,
// mcp). Every identity and record is fictional.
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { beforeEach, describe, expect, it } from "vitest";
import { VIRTUAL_TABLE_REBUILDS } from "../scripts/lib/virtual-tables.mjs";
import cleanup from "../scripts/sql/decommission-knowledge-tasks-cleanup.sql?raw";
import { PortalApp } from "../src/portal/portal-app";
import { APPLICATIONS } from "../src/shared/portal/applications";
import { FLAG_KEYS } from "../src/shared/portal/flags";
import { PERMISSIONS, ROLE_PERMISSIONS } from "../src/shared/portal/permissions";
import type { PortalPageData } from "../src/shared/portal/types";
import { OWNER, accessToken, apiCall, call, db, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);

const render = async (path: string, email = OWNER) => {
    const response = await call(path, { token: await accessToken({ email }) });
    const html = await response.text();
    const json = /<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(html)?.[1];
    const payload = json ? (JSON.parse(json) as { data: PortalPageData; path: string }) : null;
    return { response, data: payload?.data, html: payload ? renderToString(createElement(PortalApp, { data: payload.data, path: payload.path })) : "" };
};

/** Tables, triggers and the full-text index Knowledge and Tasks kept. They stay until the owner approves their removal. */
const RETAINED = [
    "knowledge_spaces",
    "knowledge_memberships",
    "knowledge_objects",
    "knowledge_relations",
    "knowledge_fts",
    "task_projects",
    "task_project_members",
    "task_items",
    "task_time_blocks",
    "task_estimates",
    "calendar_event_links",
    "asset_task_links",
    "asset_knowledge_links",
    "ai_captures",
    "ai_suggestions",
    "attachments",
    "dalyhub_import_runs",
];

describe("nothing of Knowledge or Tasks is offered", () => {
    it("has no Knowledge or Tasks application, permission or switch", () => {
        expect(APPLICATIONS.map((a) => a.id)).toEqual(["wedding", "calendar", "intelligence", "intelligence-centre", "assets"]);
        expect(PERMISSIONS).not.toContain("knowledge.use" as never);
        expect(PERMISSIONS).not.toContain("tasks.use" as never);
        for (const role of Object.values(ROLE_PERMISSIONS)) expect(role.join(" ")).not.toMatch(/knowledge|tasks\.use/);
        expect(FLAG_KEYS.join(" ")).not.toMatch(/^tasks\.|knowledge/);
        const links = APPLICATIONS.flatMap((a) => a.navigation.flatMap((s) => s.items.map((i) => i.href)));
        expect(links.filter((href) => /^\/portal\/(knowledge|tasks)|calendar\/planner|intelligence\/(capture|inbox|meetings)/.test(href))).toEqual([]);
    });

    it("shows no launcher card, sidebar link or quick-add for them, on any page", async () => {
        for (const path of ["/portal", "/portal/today", "/portal/calendar", "/portal/intelligence", "/portal/assets", "/portal/wedding"]) {
            const { response, html } = await render(path);
            expect(response.status, path).toBe(200);
            expect(html, path).not.toMatch(
                /href="\/portal\/(knowledge|tasks)|data-application="(knowledge|tasks)"|Daly Knowledge|Daly Tasks|Add task|Daily planner/,
            );
        }
    });
});

describe("retired pages and APIs", () => {
    it("answer 410 with a clear message once signed in, and never their records", async () => {
        for (const path of [
            "/portal/knowledge",
            "/portal/knowledge/o/kob_aaaaaaaaaaaaaa",
            "/portal/knowledge/settings",
            "/portal/tasks",
            "/portal/tasks/inbox",
            "/portal/tasks/t/tsk_aaaaaaaaaaaaaa",
            "/portal/calendar/planner",
            "/portal/intelligence/inbox",
            "/portal/intelligence/captures/aic_aaaaaaaaaaaaaa",
        ]) {
            const { response, data } = await render(path);
            expect(response.status, path).toBe(410);
            expect(data?.route, path).toBe("forbidden");
            expect(JSON.stringify(data), path).toMatch(/retired/);
        }
        for (const [method, path] of [
            ["GET", "/api/portal/knowledge/spaces"],
            ["POST", "/api/portal/knowledge/objects"],
            ["GET", "/api/portal/tasks/projects"],
            ["POST", "/api/portal/tasks/tasks"],
            ["GET", "/api/portal/tasks/export"],
            ["POST", "/api/portal/migrations/dalyhub/preview"],
            ["POST", "/api/portal/migrations/dalyhub/runs/dhr_aaaaaaaaaaaaaa/revert"],
        ] as const) {
            const r = await apiCall<{ error: string; message: string }>(method, path, method === "GET" ? undefined : {});
            expect(r.status, `${method} ${path}`).toBe(410);
            expect(r.json).toMatchObject({ error: "retired" });
            expect(r.json.message).toMatch(/Daly Knowledge and Daly Tasks have been retired/);
        }
    });

    it("still need Cloudflare Access: without a valid sign-in nothing says what was there", async () => {
        const anonymous = await call("/api/portal/tasks/projects");
        expect([401, 403]).toContain(anonymous.status);
        expect(await anonymous.text()).not.toMatch(/retired/);
        const page = await call("/portal/knowledge");
        expect(page.status).not.toBe(410);
    });
});

describe("records kept for the approved cleanup", () => {
    it("keeps every Knowledge, Tasks, planner and capture table, and the routes don't touch their rows", async () => {
        const tables = new Set(
            (await db().prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all<{ name: string }>()).results.map((r) => r.name),
        );
        for (const table of RETAINED) expect(tables.has(table), table).toBe(true);
        const now = new Date().toISOString();
        await db().batch([
            db()
                .prepare(
                    "INSERT INTO knowledge_spaces (id, name, kind, personal_owner, created_by, created_at, updated_at) VALUES ('ksp_aaaaaaaaaaaaaa', 'Mine', 'personal', ?, ?, ?, ?)",
                )
                .bind(OWNER, OWNER, now, now),
            db()
                .prepare(
                    "INSERT INTO task_projects (id, name, kind, is_inbox, inbox_owner, created_by, updated_by, created_at, updated_at) VALUES ('tpj_aaaaaaaaaaaaaa', 'Inbox', 'personal', 1, ?, ?, ?, ?, ?)",
                )
                .bind(OWNER, OWNER, OWNER, now, now),
        ]);
        await apiCall("DELETE", "/api/portal/knowledge/spaces/ksp_aaaaaaaaaaaaaa");
        await apiCall("PATCH", "/api/portal/tasks/projects/tpj_aaaaaaaaaaaaaa", { name: "Changed" });
        expect(await db().prepare("SELECT name FROM knowledge_spaces").first()).toEqual({ name: "Mine" });
        expect(await db().prepare("SELECT name FROM task_projects").first()).toEqual({ name: "Inbox" });
        // The scheduled jobs leave them alone too.
        const { default: worker } = await import("../worker/index");
        const { createExecutionContext, waitOnExecutionContext, env } = await import("cloudflare:test");
        const ctx = createExecutionContext();
        await worker.scheduled({ scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry() {} } as never, env as never, ctx);
        await waitOnExecutionContext(ctx);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM knowledge_spaces").first<{ n: number }>())!.n).toBe(1);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM task_projects").first<{ n: number }>())!.n).toBe(1);
    });
});

describe("backups of the retired records", () => {
    it("can still rebuild the Knowledge search index after a restore", async () => {
        for (const sql of VIRTUAL_TABLE_REBUILDS.knowledge_fts) await db().prepare(sql).run();
        expect((await db().prepare("SELECT COUNT(*) AS n FROM knowledge_fts").first<{ n: number }>())!.n).toBe(0);
    });
});

describe("the Wedding Planner's own tasks", () => {
    it("are a different feature, and still work", async () => {
        const created = await apiCall<{ item: { id: string; title: string; status: string } }>("POST", "/api/portal/wedding/tasks", {
            title: "Book celebrant",
            dueDate: "2026-11-01",
        });
        expect(created.status, created.text).toBe(201);
        const done = await apiCall<{ item: { status: string } }>("PATCH", `/api/portal/wedding/tasks/${created.json.item.id}`, { status: "done" });
        expect(done.json.item.status).toBe("done");
        expect((await apiCall<{ items: unknown[] }>("GET", "/api/portal/wedding/tasks")).json.items).toHaveLength(1);
        const page = await render("/portal/wedding/tasks");
        expect(page.response.status).toBe(200);
        expect(page.data?.route).toBe("tasks");
        expect(JSON.stringify(page.data)).toContain("Book celebrant");
    });
});

// Last: it drops tables, and resetPortal clears some of them.
describe("the approved cleanup (scripts/sql, never a migration)", () => {
    it("drops only retired tables: every retained application still works afterwards", async () => {
        const statements = cleanup
            .split("\n")
            .filter((line) => !line.startsWith("--"))
            .join("\n")
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean);
        await db().batch(statements.map((sql) => db().prepare(sql)));
        const left = (await db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name);
        expect(
            left.filter((t) =>
                /^(knowledge_|task_|dalyhub_)|^ai_(captures|suggestions|transcript)|^(attachments|calendar_event_links|asset_task_links|asset_knowledge_links)$/.test(
                    t,
                ),
            ),
        ).toEqual([]);
        for (const table of ["planner_preferences", "today_preferences", "ai_briefings", "ai_usage", "tasks", "posts", "capacities_archive"])
            expect(left).toContain(table);
        for (const path of [
            "/api/portal/today?date=2026-11-02",
            "/api/portal/calendar/events?from=2026-11-01&to=2026-11-30",
            "/api/portal/calendar/leave",
            "/api/portal/assets/overview",
            "/api/portal/assets/notifications",
            "/api/portal/wedding/tasks",
            "/api/portal/intelligence/settings",
        ]) {
            const r = await apiCall("GET", path);
            expect(r.status, `${path}: ${r.text}`).toBe(200);
        }
        expect((await call("/blog")).status).toBe(200);
    });
});
