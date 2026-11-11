// Every wedding screen the portal serves is reachable inside Payload, and nothing else is.
import { describe, expect, it } from "vitest";
import pagesSource from "../../../worker/portal/pages.ts?raw";
import { NAV, NAV_GROUPS, WEDDING_SCREEN, adminPathForPortalLink } from "../src/views/wedding-routes";

/** A concrete example path for each portal pattern (fills the one capture group the patterns use). */
const examples = (pattern: string) => {
    const body = pattern.replace(/^\^\\\/portal\\\/wedding/, "").replace(/\$$/, "").replace(/\\\//g, "/");
    if (body.includes("(msg_[a-z0-9]+)")) return [body.replace("(msg_[a-z0-9]+)", "msg_abc123")];
    if (body.includes("(?:/(general|fields))?")) return ["/settings", "/settings/general", "/settings/fields"];
    return [body];
};

describe("wedding screens in Payload", () => {
    const patterns = [...pagesSource.matchAll(/pattern: \/(\^\\\/portal\\\/wedding[^/]*?(?:\\\/[^/]*?)*\$)\//g)].map((m) => m[1]);

    it("covers every /portal/wedding page in worker/portal/pages.ts", () => {
        expect(patterns.length).toBeGreaterThanOrEqual(19);
        for (const pattern of patterns) {
            for (const example of examples(pattern)) {
                expect(WEDDING_SCREEN.test(example.replace(/^\//, "")), `${pattern} → ${example}`).toBe(true);
            }
        }
    });

    it("routes nothing outside the wedding screens", () => {
        for (const screen of ["finance", "../finance", "guests/../../admin", "guests/", "communications/msg_ABC", "settings/other", "calendar", "%2e%2e"]) {
            expect(WEDDING_SCREEN.test(screen), screen).toBe(false);
        }
        for (const [, screen] of NAV) expect(WEDDING_SCREEN.test(screen), screen).toBe(true);
    });

    it("turns portal wedding links into Payload views, and leaves other links alone", () => {
        expect(adminPathForPortalLink("/portal/wedding")).toBe("/admin/wedding");
        expect(adminPathForPortalLink("/portal/wedding/guests")).toBe("/admin/wedding/guests");
        expect(adminPathForPortalLink("/portal/wedding/communications/msg_ab12")).toBe("/admin/wedding/communications/msg_ab12");
        expect(adminPathForPortalLink("/portal/wedding/guests?rsvp=pending")).toBe("/admin/wedding/guests?rsvp=pending");
        expect(adminPathForPortalLink("/portal/wedding/guests#top")).toBe("/admin/wedding/guests#top");
        for (const href of ["/portal/calendar", "/portal/wedding/unknown", "https://evil.example/portal/wedding", "//evil.example/portal/wedding", "/portal/weddingx", "/api/portal/wedding/guests.csv"]) {
            expect(adminPathForPortalLink(href), href).toBeNull();
        }
    });

    it("puts every wedding screen in exactly one collapsible menu group", () => {
        const grouped = NAV_GROUPS.flatMap(([, screens]) => screens);
        expect([...grouped].sort()).toEqual(NAV.map(([, screen]) => screen).sort());
        expect(new Set(grouped).size).toBe(grouped.length);
    });
});
