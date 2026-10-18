// Portal settings: the central home for feature switches, the sections each role sees, the old
// settings addresses, and that moving the switches changed nothing about their storage,
// permissions or audit trail.
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { beforeEach, describe, expect, it } from "vitest";
import { PortalApp } from "../src/portal/portal-app";
import { APPLICATIONS } from "../src/shared/portal/applications";
import { FLAG_DEFINITIONS, FLAG_KEYS, type FlagKey } from "../src/shared/portal/flags";
import { ROLE_PERMISSIONS, type Role } from "../src/shared/portal/permissions";
import {
    FEATURE_AREAS,
    FEATURE_AREA_DETAILS,
    FLAG_AREAS,
    PORTAL_SETTINGS_SECTIONS,
    PORTAL_SETTINGS_TABS,
    SETTINGS_REDIRECTS,
    featuresHref,
    flagsInArea,
    visibleSettingsTabs,
} from "../src/shared/portal/settings-sections";
import type { PortalPageData } from "../src/shared/portal/types";
import { ORIGIN, OWNER, accessToken, apiCall, auditActions, call, db, portalEnv, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);

const ADMIN = "admin@example.com";
const EDITOR = "editor@example.com";
const VIEWER = "viewer@example.com";

const addPeople = async () => {
    for (const [email, role] of [
        [ADMIN, "admin"],
        [EDITOR, "editor"],
        [VIEWER, "viewer"],
    ] as const) {
        expect((await apiCall("POST", "/api/portal/users", { email, role })).status).toBe(200);
    }
};

const pageData = (html: string) => {
    const json = /<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(html)?.[1];
    return JSON.parse(json!) as { area: string; data: PortalPageData; path: string };
};

/** Fetches a portal page and renders it from the data the Worker sent, as the browser would. */
const open = async (path: string, email = OWNER, env?: Awaited<ReturnType<typeof portalEnv>>) => {
    const response = await call(path, { token: await accessToken({ email }), env });
    const html = await response.text();
    const payload = response.status === 302 ? null : pageData(html);
    return {
        response,
        html,
        data: payload?.data,
        rendered: payload ? renderToString(createElement(PortalApp, { data: payload.data, path: payload.path })) : "",
    };
};

const settingsData = (data: PortalPageData | undefined) => {
    expect(data?.route).toBe("portal-settings");
    return data as Extract<PortalPageData, { route: "portal-settings" }>;
};

const flagRows = async () =>
    (await db().prepare("SELECT key, enabled, updated_at, updated_by FROM feature_flags ORDER BY key").all<Record<string, unknown>>()).results;

describe("settings sections and switch areas", () => {
    it("places every feature switch in exactly one area belonging to a real application", () => {
        expect(Object.keys(FLAG_AREAS).sort()).toEqual([...FLAG_KEYS].sort());
        const placed = FEATURE_AREAS.flatMap(flagsInArea);
        expect(placed.sort()).toEqual([...FLAG_KEYS].sort());
        for (const area of FEATURE_AREAS) {
            expect(APPLICATIONS.some((application) => application.id === FEATURE_AREA_DETAILS[area].application)).toBe(true);
        }
        expect(FLAG_AREAS["calendar.feeds"]).toBe("calendar");
        expect(FLAG_AREAS["calendar.reminders.email"]).toBe("calendar");
        expect(FLAG_AREAS["tasks.reminders.email"]).toBe("tasks");
    });

    it("keeps every switch's default and definition as it was", () => {
        // Moving the controls must not change what a missing row means.
        for (const key of FLAG_KEYS) {
            const expected = key.startsWith("module.");
            expect(FLAG_DEFINITIONS[key].default, key).toBe(expected);
        }
    });

    it("shows each role only the sections it can use", () => {
        const tabs = (role: Role) => visibleSettingsTabs({ permissions: ROLE_PERMISSIONS[role] });
        expect(tabs("owner")).toEqual([...PORTAL_SETTINGS_TABS]);
        expect(tabs("admin")).toEqual([...PORTAL_SETTINGS_TABS]);
        expect(tabs("editor")).toEqual(["general", "access", "features", "security", "privacy"]);
        expect(tabs("viewer")).toEqual(["general", "access", "features", "security"]);
        for (const tab of PORTAL_SETTINGS_TABS) expect(PORTAL_SETTINGS_SECTIONS[tab].label).toBeTruthy();
    });
});

describe("Portal settings routes", () => {
    it.each(PORTAL_SETTINGS_TABS.map((tab) => [tab]))("renders the %s section for an owner", async (tab) => {
        const { response, data, rendered } = await open(tab === "general" ? "/portal/settings" : `/portal/settings/${tab}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(settingsData(data).tab).toBe(tab);
        expect(rendered).toMatch(/<h1[^>]*>Portal settings/);
        expect(rendered).toContain(PORTAL_SETTINGS_SECTIONS[tab].label.replace("&", "&amp;"));
    });

    it("404s sections that don't exist", async () => {
        expect((await open("/portal/settings/nope")).response.status).toBe(404);
        expect((await open("/portal/wedding/settings/nope")).response.status).toBe(404);
    });

    it("redirects every old settings address after sign-in, and only after sign-in", async () => {
        for (const [from, to] of Object.entries(SETTINGS_REDIRECTS)) {
            const { response } = await open(from);
            expect(response.status, from).toBe(302);
            expect(response.headers.get("Location")).toBe(`${ORIGIN}${to}`);
            expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
            // The destination is a real page.
            expect((await open(to.split("#")[0]!)).response.status, to).toBe(200);
            // Strangers get the Access refusal, not a map of the portal.
            const anonymous = await call(from);
            expect(anonymous.status).not.toBe(302);
            expect(anonymous.headers.get("Location")).toBeNull();
        }
    });

    it("lists Portal settings in the launcher and the sidebar", async () => {
        await addPeople();
        for (const email of [OWNER, VIEWER]) {
            const { rendered } = await open("/portal", email);
            expect(rendered).toContain('data-portal-link="settings"');
            expect(rendered).toContain('href="/portal/settings"');
        }
        expect((await open("/portal", OWNER)).rendered).toContain('data-portal-link="audit"');
        expect((await open("/portal", VIEWER)).rendered).not.toContain('data-portal-link="audit"');
        expect((await open("/portal/wedding", VIEWER)).rendered).toContain('href="/portal/settings"');
    });
});

describe("permissions", () => {
    it("opens General instead of a section the person can't use", async () => {
        await addPeople();
        for (const tab of ["calendar", "tasks", "knowledge"]) {
            for (const email of [EDITOR, VIEWER]) {
                const { response, data } = await open(`/portal/settings/${tab}`, email);
                expect(response.status).toBe(200);
                expect(settingsData(data).tab, `${email} ${tab}`).toBe("general");
            }
            expect(settingsData((await open(`/portal/settings/${tab}`, ADMIN)).data).tab).toBe(tab);
        }
        expect(settingsData((await open("/portal/settings/privacy", VIEWER)).data).tab).toBe("general");
        expect(settingsData((await open("/portal/settings/privacy", EDITOR)).data).tab).toBe("privacy");
    });

    it("gives people management to owners and integration status to owners and admins only", async () => {
        await addPeople();
        const owner = settingsData((await open("/portal/settings/access")).data);
        expect(owner.users).not.toBeNull();
        expect(owner.integrations).not.toBeNull();
        const admin = settingsData((await open("/portal/settings/access", ADMIN)).data);
        expect(admin.users).toBeNull();
        expect(admin.integrations).not.toBeNull();
        for (const email of [EDITOR, VIEWER]) {
            const data = settingsData((await open("/portal/settings/security", email)).data);
            expect(data.users).toBeNull();
            expect(data.integrations).toBeNull();
        }
    });

    it("reports integrations as yes/no only, never their secrets or audience tags", async () => {
        const env = await portalEnv({ MCP_ACCESS_AUD: "aud-mcp-should-not-leak-0123", CALENDAR_ENCRYPTION_KEY: "k".repeat(48) });
        const { html, data } = await open("/portal/settings/security", OWNER, env);
        const integrations = settingsData(data).integrations!;
        expect(integrations.mcp).toBe(true);
        expect(integrations.calendarEncryption).toBe(true);
        expect(html).not.toContain("aud-mcp-should-not-leak-0123");
        expect(html).not.toContain("k".repeat(48));
    });

    it("shows switches read-only to people who can't change them, and only areas they can open", async () => {
        await addPeople();
        const viewer = await open("/portal/settings/features", VIEWER);
        expect(settingsData(viewer.data).tab).toBe("features");
        expect(viewer.rendered).toContain("Only owners and admins can change features.");
        expect(viewer.rendered).toContain('data-feature-area="wedding"');
        expect(viewer.rendered).not.toContain('data-feature-area="calendar"');
        expect(viewer.rendered).not.toContain('data-feature-area="tasks"');

        const admin = await open("/portal/settings/features", ADMIN);
        expect(admin.rendered).not.toContain("Only owners and admins can change features.");
        for (const area of FEATURE_AREAS) expect(admin.rendered).toContain(`id="features-${area}"`);
        for (const key of FLAG_KEYS) expect(admin.rendered).toContain(FLAG_DEFINITIONS[key].label);
    });

    it("still lets only owners and admins change a switch, and audits every change", async () => {
        await addPeople();
        for (const email of [EDITOR, VIEWER]) {
            expect((await apiCall("PUT", "/api/portal/flags/calendar.feeds", { enabled: true }, { email })).status).toBe(403);
        }
        expect(await flagRows()).toEqual([]);
        expect((await apiCall("PUT", "/api/portal/flags/calendar.feeds", { enabled: true }, { email: ADMIN })).status).toBe(200);
        expect((await apiCall("PUT", "/api/portal/flags/calendar.feeds", { enabled: false }, { email: OWNER })).status).toBe(200);
        expect((await apiCall("PUT", "/api/portal/flags/not.a.switch", { enabled: true })).status).toBe(404);
        const rows = await flagRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ key: "calendar.feeds", enabled: 0, updated_by: OWNER });
        const audit = await db()
            .prepare("SELECT actor, entity_id, changes FROM audit_log WHERE action = 'flag.update' ORDER BY id")
            .all<{ actor: string; entity_id: string; changes: string }>();
        expect(audit.results.map((r) => [r.actor, r.entity_id, JSON.parse(r.changes)])).toEqual([
            [ADMIN, "calendar.feeds", { enabled: [false, true] }],
            [OWNER, "calendar.feeds", { enabled: [true, false] }],
        ]);
    });
});

describe("existing switch values", () => {
    it("are read from the same table and untouched by opening any settings page", async () => {
        // Values as production might hold them, including a module switched off.
        const stored: [FlagKey, number][] = [
            ["wedding.site.public", 1],
            ["rsvp.native", 1],
            ["communications.delivery", 1],
            ["module.budget", 0],
            ["calendar.feeds", 1],
        ];
        await db().batch(
            stored.map(([key, enabled]) =>
                db()
                    .prepare("INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?, ?, '2026-10-01T00:00:00.000Z', ?)")
                    .bind(key, enabled, OWNER),
            ),
        );
        const before = await flagRows();
        const auditBefore = await auditActions();

        for (const path of [
            "/portal/settings",
            "/portal/settings/features",
            "/portal/settings/calendar",
            "/portal/settings/tasks",
            "/portal/wedding/settings",
            "/portal/wedding/settings/fields",
            "/portal/wedding/settings/features",
            "/portal/settings/people",
            "/portal/calendar/settings",
            "/portal/calendar/calendars",
        ]) {
            const { response, data } = await open(path);
            expect([200, 302], path).toContain(response.status);
            if (data && "context" in data) {
                const flags = (data as { context: { flags: Record<FlagKey, boolean> } }).context.flags;
                for (const [key, enabled] of stored) expect(flags[key], `${path} ${key}`).toBe(enabled === 1);
                expect(flags["calendar.reminders.email"]).toBe(false);
            }
        }

        expect(await flagRows()).toEqual(before);
        expect(await auditActions()).toEqual(auditBefore);
    });
});

describe("Wedding settings", () => {
    it("keeps wedding details and custom fields, and shows its switches read-only with a link to Features", async () => {
        const general = await open("/portal/wedding/settings");
        expect(general.response.status).toBe(200);
        expect(general.data).toMatchObject({ route: "wedding-settings", tab: "general" });
        expect(general.rendered).toContain("First partner");
        expect(general.rendered).toContain(`href="${featuresHref("wedding")}"`);
        for (const key of flagsInArea("wedding")) expect(general.rendered).toContain(`data-flag="${key}"`);
        // No toggles here any more: the only controls are in Portal settings.
        expect(general.rendered).not.toContain('role="switch"');
        expect(general.rendered).not.toContain(">Features<");

        const fields = await open("/portal/wedding/settings/fields");
        expect(fields.data).toMatchObject({ route: "wedding-settings", tab: "fields" });
    });

    it("still saves wedding details for owners and admins only, with an audit entry", async () => {
        await addPeople();
        const details = { partnerOne: "Alex", partnerTwo: "Sam", date: "2027-10-23", location: "Dubbo, NSW", timeZone: "Australia/Sydney" };
        expect((await apiCall("PUT", "/api/portal/settings/wedding", details, { email: EDITOR })).status).toBe(403);
        expect((await apiCall("PUT", "/api/portal/settings/wedding", details, { email: VIEWER })).status).toBe(403);
        const saved = await apiCall<{ value: Record<string, string> }>("PUT", "/api/portal/settings/wedding", details, { email: ADMIN });
        expect(saved.status).toBe(200);
        expect(saved.json.value).toMatchObject(details);
        expect(await auditActions()).toContain("settings.update");
    });
});

describe("Calendar settings", () => {
    it("shows the subscription and reminder email switches with a link to the central controls", async () => {
        await db()
            .prepare("INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES ('calendar.feeds', 1, '2026-10-01T00:00:00.000Z', ?)")
            .bind(OWNER)
            .run();
        const { response, rendered } = await open("/portal/calendar/settings");
        expect(response.status).toBe(200);
        expect(rendered).toContain('data-flag="calendar.feeds"');
        expect(rendered).toContain('data-flag="calendar.reminders.email"');
        expect(rendered).toContain(`href="${featuresHref("calendar")}"`);
        expect(rendered).toContain("Manage in Portal settings → Features");

        const calendars = await open("/portal/calendar/calendars");
        expect(calendars.response.status).toBe(200);
        expect(calendars.rendered).not.toContain("Wedding settings");
    });

    it("explains where subscription addresses are switched on while they're off", async () => {
        const { rendered } = await open("/portal/calendar/calendars");
        expect(rendered).toContain("Subscription addresses are switched off");
        expect(rendered).toContain(`href="${featuresHref("calendar")}"`);
    });
});
