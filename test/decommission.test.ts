// Every retired application, in one place: Daly Knowledge and Daly Tasks (docs/DECOMMISSION_KNOWLEDGE_TASKS.md),
// Home & Assets and Household Finance (docs/DECOMMISSION_ASSETS_FINANCE.md), and Daly Calendar and the
// Leave Planner, Today, Daly Intelligence, the Intelligence Centre and Amplenote
// (docs/DECOMMISSION_PORTAL_APPS.md). Nothing of them is offered; their pages and APIs answer 410 with
// the message of their retirement (after the usual sign-in and role checks); their public addresses
// answer a plain 410; the database holds exactly what it should; and the wedding site, RSVP, Wedding
// Planner and the blog answer as before. Every identity and record is fictional.
import { beforeEach, describe, expect, it } from "vitest";
import pending0033 from "../docs/pending/0033_drop_retired_portal_app_tables.sql?raw";
import migration0032 from "../docs/pending/0032_drop_retired_tables.sql?raw";
import { APPLICATIONS } from "../src/shared/portal/applications";
import { FLAG_KEYS } from "../src/shared/portal/flags";
import { PERMISSIONS, ROLE_PERMISSIONS } from "../src/shared/portal/permissions";
import { FEATURE_AREAS, PORTAL_SETTINGS_TABS } from "../src/shared/portal/settings-sections";
import type { Household, WeddingEvent } from "../src/shared/portal/types";
import type { Env } from "../worker/env";
import { loadFlags } from "../worker/portal/flags";
import { ORIGIN, OWNER, SECOND_OWNER, accessToken, adminPage, apiCall, call, db, portalEnv, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);

const ADMIN = "admin@example.com";
const EDITOR = "editor@example.com";
const VIEWER = "viewer@example.com";
const PLANNER_HOST = "weddingplanner.daly.id.au";
const WEDDING_HOST = "wedding.daly.id.au";

/**
 * A screen as Payload's admin shows it (the portal's own pages were retired in Phase 3). A retired
 * application's address isn't a screen: the Worker answers it with a plain 410 that says why.
 */
const render = async (path: string, email = OWNER) => {
    const token = await accessToken({ email });
    const page = await adminPage(path, { token });
    if (page.status !== 404) return { response: { status: page.status, headers: new Headers({ "Cache-Control": "no-store" }) }, data: page.data, html: page.html };
    const response = await call(path, { token });
    const html = await response.text();
    const message = /<p>([^<]*)<\/p>/
        .exec(html)?.[1]
        ?.replace(/&amp;/g, "&")
        .replace(/&#39;|&#x27;/g, "'")
        .replace(/&quot;/g, '"');
    return { response, data: response.status === 410 ? { route: "forbidden", message } : undefined, html };
};

const addPeople = async () => {
    for (const [email, role] of [
        [ADMIN, "admin"],
        [EDITOR, "editor"],
        [VIEWER, "viewer"],
    ] as const)
        expect((await apiCall("POST", "/api/portal/users", { email, role })).status).toBe(200);
};

const statements = (sql: string) =>
    sql
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
const droppedBy = (sql: string) => [...sql.matchAll(/^DROP TABLE IF EXISTS (\w+);/gm)].map((m) => m[1]);
const tableNames = async () =>
    new Set((await db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name));

const KNOWLEDGE_TASKS = /Daly Knowledge and Daly Tasks have been retired/;
const ASSETS = /Home & Assets has been retired and replaced by Home in Cloudflare OS/;
const FINANCE = /Household Finance has been retired and replaced by Finances in Cloudflare OS/;
const CALENDAR = /Daly Calendar and the Leave Planner have been retired/;
const TODAY = /Today has been retired/;
const INTELLIGENCE = /Daly Intelligence has been retired/;
const CENTRE = /The Intelligence Centre has been retired, along with its wallboards/;
const AMPLENOTE = /Publishing from Amplenote has been retired: the blog publishes from Capacities/;

/** Anything that would offer a retired application on a page. */
const RETIRED_LINKS =
    /href="\/portal\/(knowledge|tasks|assets|finance|calendar|today|intelligence|intelligence-centre)["/?]|href="\/portal"|data-application="(?!wedding)|Daly Calendar|Daly Intelligence|Intelligence Centre|Amplenote|Home &amp; Assets|Household Finance|Daly Knowledge|Daly Tasks/;

describe("nothing of a retired application is offered", () => {
    it("has only Wedding Planner, with no permission, switch, settings section or link for anything else", () => {
        expect(APPLICATIONS.map((a) => a.id)).toEqual(["wedding"]);
        expect(PERMISSIONS.filter((p) => !p.startsWith("wedding.") && !p.startsWith("portal."))).toEqual([]);
        for (const role of Object.values(ROLE_PERMISSIONS))
            expect(role.join(" ")).not.toMatch(/calendar|intelligence|centre|knowledge|tasks\.use|assets|finance/);
        expect(FLAG_KEYS.join(" ")).not.toMatch(/calendar\.|intelligence|amplenote|other_applications|tasks\.|knowledge|assets\./);
        expect(FEATURE_AREAS).toEqual(["wedding", "website"]);
        expect(PORTAL_SETTINGS_TABS).toEqual(["general", "access", "features", "website", "security", "privacy"]);
        const links = APPLICATIONS.flatMap((a) => a.navigation.flatMap((s) => s.items.map((i) => i.href)));
        expect(links.filter((href) => !/^\/portal\/(wedding|planner)(\/|$)/.test(href))).toEqual([]);
    });

    it("sends /portal to the wedding admin in Payload, and no screen links to a retired application", async () => {
        const home = await call("/portal", { token: await accessToken() });
        expect(home.status).toBe(302);
        expect(home.headers.get("Location")).toBe(`${ORIGIN}/admin/wedding`);
        await addPeople();
        for (const email of [OWNER, VIEWER])
            for (const path of [
                "/portal/wedding",
                "/portal/wedding/guests",
                "/portal/wedding/settings",
                "/portal/settings",
                "/portal/settings/access",
                "/portal/settings/features",
                "/portal/settings/website",
                "/portal/settings/security",
                "/portal/audit",
            ]) {
                const { response, html } = await render(path, email);
                expect(response.status, `${path} as ${email}`).toBe(email === VIEWER && path === "/portal/audit" ? 403 : 200);
                expect(html, `${path} as ${email}`).not.toMatch(RETIRED_LINKS);
            }
    });

    it("ignores switches stored while the applications existed, never an error", async () => {
        const now = new Date().toISOString();
        const retired = [
            "calendar.feeds",
            "intelligence_centre.ingestion",
            "intelligence_centre.wallboard",
            "portal.other_applications",
            "website.amplenote.assistant",
            "assets.ai",
        ];
        await db().batch(
            retired.map((key) => db().prepare("INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?, 1, ?, ?)").bind(key, now, OWNER)),
        );
        const flags = await loadFlags(db());
        for (const key of retired) expect(flags, key).not.toHaveProperty(key);
        expect((await render("/portal/settings/features")).response.status).toBe(200);
        expect((await apiCall("PUT", "/api/portal/flags/calendar.feeds", { enabled: false })).status).toBe(404);
        // The stored rows are left as they were.
        expect((await db().prepare("SELECT COUNT(*) AS n FROM feature_flags WHERE enabled = 1").first<{ n: number }>())!.n).toBe(retired.length);
    });
});

describe("retired pages and APIs", () => {
    const PAGES: [string, RegExp][] = [
        ["/portal/knowledge", KNOWLEDGE_TASKS],
        ["/portal/tasks/inbox", KNOWLEDGE_TASKS],
        ["/portal/calendar/planner", KNOWLEDGE_TASKS],
        ["/portal/intelligence/captures/aic_aaaaaaaaaaaaaa", KNOWLEDGE_TASKS],
        ["/portal/assets/item/ast_aaaaaaaaaaaaaa", ASSETS],
        ["/portal/finance/transactions", FINANCE],
        ["/portal/calendar", CALENDAR],
        ["/portal/calendar/leave", CALENDAR],
        ["/portal/calendar/leave/planner", CALENDAR],
        ["/portal/calendar/subscriptions", CALENDAR],
        ["/portal/today", TODAY],
        ["/portal/intelligence", INTELLIGENCE],
        ["/portal/intelligence/briefing/weekly", INTELLIGENCE],
        ["/portal/intelligence/settings", INTELLIGENCE],
        ["/portal/intelligence-centre", CENTRE],
        ["/portal/intelligence-centre/map", CENTRE],
        ["/portal/intelligence-centre/wallboards/icb_aaaaaaaaaaaaaa", CENTRE],
    ];
    const APIS: [string, string, RegExp][] = [
        ["GET", "/api/portal/knowledge/spaces", KNOWLEDGE_TASKS],
        ["POST", "/api/portal/tasks/tasks", KNOWLEDGE_TASKS],
        ["POST", "/api/portal/migrations/dalyhub/preview", KNOWLEDGE_TASKS],
        ["POST", "/api/portal/today/plan", KNOWLEDGE_TASKS],
        ["GET", "/api/portal/assets/items", ASSETS],
        ["POST", "/api/portal/assets/tasks", KNOWLEDGE_TASKS],
        ["GET", "/api/portal/finance/overview", FINANCE],
        ["GET", "/api/portal/calendar/calendars", CALENDAR],
        ["POST", "/api/portal/calendar/events", CALENDAR],
        ["GET", "/api/portal/calendar/leave", CALENDAR],
        ["PUT", "/api/portal/calendar/preferences", CALENDAR],
        ["GET", "/api/portal/today", TODAY],
        ["PUT", "/api/portal/today/preferences", TODAY],
        ["GET", "/api/portal/intelligence/settings", INTELLIGENCE],
        ["POST", "/api/portal/intelligence/briefings/daily", INTELLIGENCE],
        ["GET", "/api/portal/centre/records", CENTRE],
        ["POST", "/api/portal/centre/rules", CENTRE],
        ["POST", "/api/portal/centre/wallboards", CENTRE],
        ["GET", "/api/portal/website/amplenote", AMPLENOTE],
        ["POST", "/api/portal/website/amplenote/connect", AMPLENOTE],
        ["DELETE", "/api/portal/website/amplenote/5f0e9b8a-1c2d-4e3f-8a9b-0c1d2e3f4a5b/replacement", AMPLENOTE],
    ];

    it("answer 410 with the message of their retirement once signed in, whatever the role", async () => {
        await addPeople();
        for (const email of [OWNER, SECOND_OWNER, ADMIN, EDITOR, VIEWER])
            for (const [path, message] of PAGES) {
                const { response, data } = await render(path, email);
                expect(response.status, `${path} as ${email}`).toBe(410);
                expect(response.headers.get("Cache-Control")).toBe("no-store");
                expect(data?.route, path).toBe("forbidden");
                expect(JSON.stringify(data), path).toMatch(message);
            }
        for (const email of [OWNER, VIEWER])
            for (const [method, path, message] of APIS) {
                const r = await apiCall<{ error: string; message: string }>(method, path, method === "GET" || method === "DELETE" ? undefined : {}, { email });
                expect(r.status, `${method} ${path} as ${email}`).toBe(410);
                expect(r.headers.get("Cache-Control")).toBe("no-store");
                expect(r.json).toMatchObject({ error: "retired" });
                expect(r.json.message, path).toMatch(message);
            }
    });

    it("still need Cloudflare Access: without a valid sign-in nothing says what was there", async () => {
        for (const [, path] of APIS) {
            const anonymous = await call(path);
            expect([401, 403], path).toContain(anonymous.status);
            expect(await anonymous.text()).not.toMatch(/retired/);
        }
        for (const [path] of PAGES) expect((await call(path)).status, path).toBe(401);
        expect((await call("/portal")).status).toBe(401);
    });

    it("answer a plain 410 at the addresses that never needed sign-in: calendar feeds, wallboards and Amplenote", async () => {
        for (const [method, path] of [
            ["GET", "/calendar/feed/aBcDeFgHiJkLmNoPqRsTuVwXyZ012345.ics"],
            ["HEAD", "/calendar/feed/aBcDeFgHiJkLmNoPqRsTuVwXyZ012345.ics"],
            ["GET", "/display"],
            ["GET", "/api/display/wallboard?v=2"],
            ["POST", "/api/display/renew"],
            ["GET", "/api/display/tiles/5/28/18.mvt"],
            ["POST", "/api/amplenote/ingest"],
            ["GET", "/api/integrations/amplenote/callback?code=x&state=y"],
        ]) {
            const response = await call(path, { method, token: null });
            expect(response.status, `${method} ${path}`).toBe(410);
            expect(response.headers.get("Cache-Control")).toBe("no-store");
            if (method !== "HEAD") expect(await response.text()).toBe("Gone: this address has been retired.");
        }
        // The wedding's own host stays as narrow as it was.
        expect((await call("/api/amplenote/ingest", { method: "POST", host: WEDDING_HOST, token: null })).status).toBe(404);
        expect((await call("/display", { host: WEDDING_HOST, token: null })).status).toBe(404);
    });

    it("leave the Wedding Planner's own tasks, budget and dashboard alone", async () => {
        const created = await apiCall<{ item: { id: string } }>("POST", "/api/portal/wedding/tasks", { title: "Book celebrant", dueDate: "2026-11-01" });
        expect(created.status, created.text).toBe(201);
        expect((await apiCall<{ items: unknown[] }>("GET", "/api/portal/wedding/tasks")).json.items).toHaveLength(1);
        for (const path of ["/portal/wedding/tasks", "/portal/wedding/budget", "/portal/wedding"]) expect((await render(path)).response.status, path).toBe(200);
        // The dashboard (stats and its widget layout) is Wedding Planner's, used by the phone app too.
        const dashboard = await apiCall<{ stats: unknown; widgets: { type: string }[] }>("GET", "/api/portal/dashboard");
        expect(dashboard.status).toBe(200);
        expect(dashboard.json.widgets.map((w) => w.type)).toContain("rsvp-summary");
        const saved = await apiCall<{ widgets: unknown[] }>("PUT", "/api/portal/dashboard", {
            widgets: [{ id: "w-countdown", type: "countdown", size: "sm" }],
        });
        expect(saved.status).toBe(200);
    });
});

describe("the wedding site, RSVP, Wedding Planner and the blog answer as before", () => {
    const publicPost = async (path: string, body: unknown, host?: string) => {
        const response = await call(path, {
            method: "POST",
            host,
            token: null,
            headers: { Origin: host ? `https://${host}` : ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
            body: JSON.stringify(body),
        });
        return {
            status: response.status,
            json: (await response.json()) as { household?: { householdName: string; guests: { firstName: string }[] }; error?: string },
        };
    };

    it("serves the wedding site, Save the Date and RSVP once switched on, as before", async () => {
        await apiCall("PUT", "/api/portal/settings/wedding", {
            partnerOne: "Robin",
            partnerTwo: "Jules",
            date: "2027-03-20",
            location: "Southern Highlands",
            timeZone: "Australia/Sydney",
        });
        const ceremony = (
            await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", {
                name: "Ceremony",
                startsAt: "2027-03-20T15:00",
                venueName: "The Chapel",
            })
        ).json.item;
        const household = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: "Alex & Blake" })).json.item;
        await apiCall("POST", "/api/portal/wedding/guests", { firstName: "Alex", householdId: household.id, events: [ceremony.id] });

        // Unpublished: indistinguishable from a missing page.
        expect((await call("/", { host: WEDDING_HOST, token: null })).status).toBe(404);
        expect((await call("/save-the-date/calendar", { host: WEDDING_HOST, token: null })).status).toBe(404);
        expect((await publicPost("/api/wedding/rsvp/lookup", { code: household.rsvpCode }, WEDDING_HOST)).status).toBe(404);

        for (const flag of ["wedding.site.public", "rsvp.native"])
            expect((await apiCall("PUT", `/api/portal/flags/${flag}`, { enabled: true })).status).toBe(200);
        const site = await call("/", { host: WEDDING_HOST, token: null });
        expect(site.status).toBe(200);
        expect(await site.text()).toContain("Robin");
        expect((await call("/rsvp", { host: WEDDING_HOST, token: null })).status).toBe(200);
        // The wedding's own calendar file (not Daly Calendar's): one event, from Wedding Planner's settings.
        const ics = await call("/save-the-date/calendar", { host: WEDDING_HOST, token: null });
        expect(ics.status).toBe(200);
        expect(ics.headers.get("Content-Type")).toContain("text/calendar");
        expect(await ics.text()).toMatch(/BEGIN:VCALENDAR[\s\S]*BEGIN:VEVENT[\s\S]*END:VCALENDAR/);
        expect((await call("/save-the-date", { host: WEDDING_HOST, token: null })).status).toBe(200);
        const lookup = await publicPost("/api/wedding/rsvp/lookup", { code: household.rsvpCode }, WEDDING_HOST);
        expect(lookup.status, JSON.stringify(lookup.json)).toBe(200);
        expect(lookup.json.household?.guests.map((g) => g.firstName)).toEqual(["Alex"]);
    });

    it("serves the phone app on daly.id.au only; its old address redirects there and answers no API", async () => {
        const token = await accessToken();
        expect((await call("/portal/planner", { token })).status).toBe(200);
        expect((await call("/portal/planner/guests", { token })).status).toBe(200);
        const env: Env = await portalEnv({ PLANNER_URL: `https://${PLANNER_HOST}` });
        const onHost = (path: string) => call(path, { token, host: PLANNER_HOST, env });
        expect((await onHost("/")).status).toBe(302);
        for (const path of ["/api/portal/dashboard", "/api/portal/wedding/guests", "/api/portal/me", "/api/portal/calendar/calendars", "/api/portal/today"])
            expect((await onHost(path)).status, path).toBe(404);
    });

    it("keeps every published article online whichever publisher wrote it, Amplenote's included", async () => {
        const now = "2026-10-01T00:00:00.000Z";
        await db().batch([
            db().prepare("DELETE FROM posts"),
            db()
                .prepare(
                    "INSERT INTO posts (id, slug, title, summary, body_html, published_at, content_hash, synced_at, source) VALUES ('cap-1', 'from-capacities', 'From Capacities', 'One', '<p>Written in Capacities.</p>', ?1, 'h1', ?1, 'capacities'), ('amp-1', 'from-amplenote', 'From Amplenote', 'Two', '<p>Written in Amplenote.</p>', ?1, 'h2', ?1, 'amplenote')",
                )
                .bind(now),
            db().prepare("INSERT INTO slug_redirects (from_slug, post_id, created_at) VALUES ('old-amplenote-address', 'amp-1', ?)").bind(now),
        ]);
        const blog = await (await call("/blog", { token: null })).text();
        expect(blog).toContain("From Capacities");
        expect(blog).toContain("From Amplenote");
        const article = await call("/blog/from-amplenote", { token: null });
        expect(article.status).toBe(200);
        expect(await article.text()).toContain("Written in Amplenote.");
        const moved = await call("/blog/old-amplenote-address", { token: null });
        expect(moved.status).toBe(301);
        expect(moved.headers.get("Location")).toContain("/blog/from-amplenote");
        expect(await (await call("/feed.xml", { token: null })).text()).toContain("from-amplenote");
        expect(await (await call("/sitemap.xml", { token: null })).text()).toContain("from-amplenote");
        expect((await call("/", { token: null })).status).toBe(200);
        expect((await call("/api/health", { token: null })).status).toBe(200);
    });
});

describe("the scheduled job", () => {
    it("runs only the blog's sync and wedding messages: retired applications' records are left alone", async () => {
        const now = new Date().toISOString();
        await db().batch([
            db().prepare("DELETE FROM calendars"),
            db()
                .prepare(
                    "INSERT INTO calendars (id, name, kind, source, owner_email, created_by, updated_by, created_at, updated_at) VALUES ('cal_aaaaaaaaaaaaaa', 'Mine', 'personal', 'local', ?, ?, ?, ?, ?)",
                )
                .bind(OWNER, OWNER, OWNER, now, now),
        ]);
        const { default: worker } = await import("../worker/index");
        const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
        const ctx = createExecutionContext();
        await worker.scheduled({ scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry() {} } as never, await portalEnv(), ctx);
        await waitOnExecutionContext(ctx);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM calendars").first<{ n: number }>())!.n).toBe(1);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM ic_fetch_runs").first<{ n: number }>())!.n).toBe(0);
    });
});

describe("the database", () => {
    const DROPPED = droppedBy(migration0032);
    const PENDING = droppedBy(pending0033);

    it("the held-back drop (docs/pending/0032) names exactly the approved tables of the earlier retirements, and nothing is dropped yet", async () => {
        expect(DROPPED).toHaveLength(84);
        // Every asset_ and knowledge_ table but the two that kept tables still name in foreign keys.
        expect(DROPPED.filter((t) => t.startsWith("asset_"))).toHaveLength(19);
        expect(DROPPED.filter((t) => t.startsWith("finance_"))).toHaveLength(9);
        expect(DROPPED.filter((t) => t.startsWith("knowledge_"))).toHaveLength(15);
        expect(DROPPED).not.toContain("asset_locations");
        expect(DROPPED).not.toContain("knowledge_spaces");
        expect(DROPPED.filter((t) => t.startsWith("task_"))).toHaveLength(31);
        expect(DROPPED.filter((t) => !/^(asset|finance|knowledge|task)_/.test(t)).sort()).toEqual([
            "ai_captures",
            "ai_exclusions",
            "ai_semantic_index",
            "ai_suggestions",
            "ai_transcript_parts",
            "ai_transcripts",
            "calendar_event_links",
            "daily_reviews",
            "dalyhub_import_items",
            "dalyhub_import_runs",
        ]);
        expect(statements(migration0032).every((s) => /^(DROP TABLE IF EXISTS \w+|PRAGMA defer_foreign_keys = ON)$/.test(s))).toBe(true);
        // Held back (no deleting production data without fresh approval): every table is still there.
        expect(Object.keys(import.meta.glob("../migrations/*.sql")).filter((m) => /drop/i.test(m))).toEqual([]);
        const tables = await tableNames();
        for (const table of DROPPED) expect(tables.has(table), table).toBe(true);
        // The wedding's tasks, and what 0032 would deliberately keep, are still there.
        for (const table of ["tasks", "dashboard_layouts", "capacities_archive", "entity_cache", "posts", "guests", ...PENDING])
            expect(tables.has(table), table).toBe(true);
    });

    it("keeps foreign keys sound: no table 0032 would keep names one it would drop, so the database check and restores would still work", async () => {
        expect((await db().prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
        const tables = [...(await tableNames())].filter((t) => !t.startsWith("_cf_") && !t.startsWith("sqlite_") && !DROPPED.includes(t) && !t.startsWith("knowledge_fts"));
        for (const table of tables) {
            const parents = (await db().prepare(`SELECT "table" AS parent FROM pragma_foreign_key_list(?)`).bind(table).all<{ parent: string }>()).results;
            for (const { parent } of parents) expect(DROPPED, `${table} → ${parent}`).not.toContain(parent);
        }
        // A kept row naming a kept parent can still be written, as a restore does.
        const now = new Date().toISOString();
        await db()
            .prepare(
                "INSERT INTO knowledge_spaces (id, name, kind, personal_owner, created_by, created_at, updated_at) VALUES ('ksp_aaaaaaaaaaaaaa', 'x', 'personal', ?, ?, ?, ?)",
            )
            .bind(OWNER, OWNER, now, now)
            .run();
        await db().prepare("DELETE FROM knowledge_spaces").run();
    });

    // Last: it drops tables, and resetPortal clears some of them.
    it("the pending cleanup (docs/pending/0033) drops only unused tables: everything kept still works afterwards", async () => {
        expect(statements(pending0033).every((s) => /^(DROP TABLE IF EXISTS \w+|PRAGMA defer_foreign_keys = ON)$/.test(s))).toBe(true);
        expect(PENDING.filter((t) => DROPPED.includes(t))).toEqual([]);
        await db().batch([...statements(migration0032), ...statements(pending0033)].map((sql) => db().prepare(sql)));
        const tables = await tableNames();
        for (const table of PENDING) expect(tables.has(table), table).toBe(false);
        for (const table of [
            "tasks",
            "events",
            "guests",
            "households",
            "posts",
            "capacities_archive",
            "entity_cache",
            "dashboard_layouts",
            "feature_flags",
            "audit_log",
        ])
            expect(tables.has(table), table).toBe(true);
        expect((await db().prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
        for (const path of ["/api/portal/wedding/tasks", "/api/portal/wedding/guests", "/api/portal/dashboard", "/api/portal/me"]) {
            const r = await apiCall("GET", path);
            expect(r.status, `${path}: ${r.text}`).toBe(200);
        }
        for (const path of ["/portal/wedding", "/portal/settings/website", "/portal/settings/features"])
            expect((await render(path)).response.status, path).toBe(200);
        expect((await apiCall("POST", "/api/portal/website/capacities/archive", {})).status).toBe(200);
        expect((await call("/blog", { token: null })).status).toBe(200);
        // And the scheduled job still runs.
        const { default: worker } = await import("../worker/index");
        const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
        const ctx = createExecutionContext();
        await worker.scheduled({ scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry() {} } as never, await portalEnv(), ctx);
        await waitOnExecutionContext(ctx);
    });
});
