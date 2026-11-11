// Portal settings: the central home for feature switches, the sections each role sees, the old
// settings addresses, and that moving the switches changed nothing about their storage,
// permissions or audit trail.
import { beforeEach, describe, expect, it } from "vitest";
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
import { adminPathForPortal } from "../src/shared/portal/admin-paths";
import { ORIGIN, OWNER, accessToken, adminPage, apiCall, auditActions, call, db, portalEnv, resetPortal } from "./portal-helpers";

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

/** A screen as Payload's admin shows it; old portal addresses answer with their redirect, as the Worker does. */
const open = async (path: string, email = OWNER, env?: Awaited<ReturnType<typeof portalEnv>>) => {
    const token = await accessToken({ email });
    const page = await adminPage(path, { token, env });
    const redirect = page.status === 404 ? await call(path, { token, env }) : null;
    return {
        response: redirect?.status === 302 ? redirect : { status: page.status, headers: new Headers() },
        html: page.html,
        data: page.data,
        rendered: page.html,
    };
};

const settingsData = (data: PortalPageData | undefined) => {
    expect(data?.route).toBe("portal-settings");
    return data as Extract<PortalPageData, { route: "portal-settings" }>;
};

const flagRows = async () =>
    (await db().prepare("SELECT key, enabled, updated_at, updated_by FROM feature_flags ORDER BY key").all<Record<string, unknown>>()).results;

describe("settings sections and switch areas", () => {
    it("places every feature switch in exactly one area belonging to a real application (or, for the website, a permission)", () => {
        expect(Object.keys(FLAG_AREAS).sort()).toEqual([...FLAG_KEYS].sort());
        const placed = FEATURE_AREAS.flatMap(flagsInArea);
        expect(placed.sort()).toEqual([...FLAG_KEYS].sort());
        for (const area of FEATURE_AREAS) {
            const details = FEATURE_AREA_DETAILS[area];
            // The website area isn't an application; it needs portal.settings.manage.
            if ("permission" in details) expect(area).toBe("website");
            else expect(APPLICATIONS.some((application) => application.id === details.application)).toBe(true);
        }
        expect(FLAG_AREAS["website.capacities.sync"]).toBe("website");
        expect(FEATURE_AREAS).toEqual(["wedding", "website"]);
        // Retired applications' switches are gone (docs/DECOMMISSION_PORTAL_APPS.md).
        expect(FLAG_KEYS.join(" ")).not.toMatch(/tasks\.|calendar\.|intelligence|amplenote|other_applications/);
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
        expect(settingsData(data).tab).toBe(tab);
        expect(rendered).toMatch(/<h1[^>]*>Administration/);
        expect(rendered).toContain(PORTAL_SETTINGS_SECTIONS[tab].label.replace("&", "&amp;"));
    });

    it("404s sections that don't exist", async () => {
        const token = await accessToken();
        expect((await adminPage("/portal/settings/nope", { token })).status).toBe(404);
        expect((await adminPage("/portal/wedding/settings/nope", { token })).status).toBe(404);
    });

    it("redirects every old settings address after sign-in, and only after sign-in", async () => {
        for (const [from, to] of Object.entries(SETTINGS_REDIRECTS)) {
            const { response } = await open(from);
            expect(response.status, from).toBe(302);
            // Straight to the Payload screen that replaced the destination.
            expect(response.headers.get("Location")).toBe(`${ORIGIN}${adminPathForPortal(to)}`);
            expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
            // The destination is a real screen.
            expect((await open(to.split("#")[0]!)).response.status, to).toBe(200);
            // Strangers get the Access refusal, not a map of the portal.
            const anonymous = await call(from);
            expect(anonymous.status).not.toBe(302);
            expect(anonymous.headers.get("Location")).toBeNull();
        }
    });

});

describe("permissions", () => {
    it("opens General instead of a section the person can't use", async () => {
        await addPeople();
        for (const email of [EDITOR, VIEWER]) expect(settingsData((await open("/portal/settings/website", email)).data).tab, email).toBe("general");
        expect(settingsData((await open("/portal/settings/website", ADMIN)).data).tab).toBe("website");
        expect(settingsData((await open("/portal/settings/privacy", VIEWER)).data).tab).toBe("general");
        expect(settingsData((await open("/portal/settings/privacy", EDITOR)).data).tab).toBe("privacy");
        // Retired applications' sections send old bookmarks somewhere that exists.
        for (const tab of ["tasks", "knowledge", "calendar", "intelligence"])
            expect((await open(`/portal/settings/${tab}`, ADMIN)).response.headers.get("Location"), tab).toBe("https://daly.id.au/admin/administration");
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
        const env = await portalEnv({ MCP_ACCESS_AUD: "aud-mcp-should-not-leak-0123", COMMS_WEBHOOK_SECRET: "k".repeat(48) });
        const { html, data } = await open("/portal/settings/security", OWNER, env);
        const integrations = settingsData(data).integrations!;
        expect(integrations.webhooks).toBe(true);
        expect(html).not.toContain("aud-mcp-should-not-leak-0123");
        expect(html).not.toContain("k".repeat(48));
    });

    it("shows switches read-only to people who can't change them, and only areas they can open", async () => {
        await addPeople();
        const viewer = await open("/portal/settings/features", VIEWER);
        expect(settingsData(viewer.data).tab).toBe("features");
        expect(viewer.rendered).toContain("Only owners and admins can change features.");
        expect(viewer.rendered).toContain('data-feature-area="wedding"');
        expect(viewer.rendered).not.toContain('data-feature-area="website"');

        const admin = await open("/portal/settings/features", ADMIN);
        expect(admin.rendered).not.toContain("Only owners and admins can change features.");
        for (const area of FEATURE_AREAS) expect(admin.rendered).toContain(`id="features-${area}"`);
        // Rendered HTML escapes "&", should a label contain one.
        for (const key of FLAG_KEYS) expect(admin.rendered).toContain(FLAG_DEFINITIONS[key].label.replace(/&/g, "&amp;"));
    });

    it("still lets only owners and admins change a switch, and audits every change", async () => {
        await addPeople();
        for (const email of [EDITOR, VIEWER]) {
            expect((await apiCall("PUT", "/api/portal/flags/rsvp.native", { enabled: true }, { email })).status).toBe(403);
        }
        expect(await flagRows()).toEqual([]);
        expect((await apiCall("PUT", "/api/portal/flags/rsvp.native", { enabled: true }, { email: ADMIN })).status).toBe(200);
        expect((await apiCall("PUT", "/api/portal/flags/rsvp.native", { enabled: false }, { email: OWNER })).status).toBe(200);
        expect((await apiCall("PUT", "/api/portal/flags/not.a.switch", { enabled: true })).status).toBe(404);
        const rows = await flagRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ key: "rsvp.native", enabled: 0, updated_by: OWNER });
        const audit = await db()
            .prepare("SELECT actor, entity_id, changes FROM audit_log WHERE action = 'flag.update' ORDER BY id")
            .all<{ actor: string; entity_id: string; changes: string }>();
        expect(audit.results.map((r) => [r.actor, r.entity_id, JSON.parse(r.changes)])).toEqual([
            [ADMIN, "rsvp.native", { enabled: [false, true] }],
            [OWNER, "rsvp.native", { enabled: [true, false] }],
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
        ];
        // And a retired application's switch, as production holds it: kept, and ignored.
        const retired: [string, number][] = [["calendar.feeds", 1]];
        await db().batch(
            [...stored, ...retired].map(([key, enabled]) =>
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
        ]) {
            const { response, data } = await open(path);
            expect([200, 302], path).toContain(response.status);
            if (data && "context" in data) {
                const flags = (data as { context: { flags: Record<FlagKey, boolean> } }).context.flags;
                for (const [key, enabled] of stored) expect(flags[key], `${path} ${key}`).toBe(enabled === 1);
                expect(Object.keys(flags)).not.toContain("calendar.feeds");
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
