import { beforeEach, describe, expect, it } from "vitest";
import type { Guest, Household, RsvpHousehold, WeddingEvent } from "../src/shared/portal/types";
import { ORIGIN, accessToken, apiCall, auditActions, call, db, portalEnv, resetPortal } from "./portal-helpers";

interface Fixture {
    household: Household;
    other: Household;
    ceremony: WeddingEvent;
    reception: WeddingEvent;
    alex: Guest;
    blake: Guest;
    stranger: Guest;
}

async function setup(): Promise<Fixture> {
    await apiCall("PUT", "/api/portal/settings/wedding", {
        partnerOne: "Robin",
        partnerTwo: "Jules",
        date: "2027-03-20",
        location: "Southern Highlands",
        timeZone: "Australia/Sydney",
    });
    const ceremony = (
        await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Ceremony", startsAt: "2027-03-20T15:00", venueName: "The Chapel" })
    ).json.item;
    const reception = (
        await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Reception", startsAt: "2027-03-20T18:00", isPublic: false })
    ).json.item;
    const household = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: "Alex & Blake" })).json.item;
    const other = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: "Someone else" })).json.item;
    const guest = async (body: Record<string, unknown>) => (await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", body)).json.guest;
    const alex = await guest({
        firstName: "Alex",
        householdId: household.id,
        events: [ceremony.id, reception.id],
        email: "alex@example.com",
        notes: "PRIVATE NOTE",
    });
    const blake = await guest({ firstName: "Blake", householdId: household.id, events: [ceremony.id] });
    const stranger = await guest({ firstName: "Stranger", householdId: other.id, events: [ceremony.id] });
    return { household, other, ceremony, reception, alex, blake, stranger };
}

const enable = async (...flags: string[]) => {
    for (const flag of flags) await apiCall("PUT", `/api/portal/flags/${flag}`, { enabled: true });
};

const publicPost = async (path: string, body: unknown, ip = "203.0.113.7") => {
    const response = await call(path, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as { household?: RsvpHousehold; error?: string; message?: string } };
};

beforeEach(resetPortal);

describe("wedding website", () => {
    it("is indistinguishable from a missing page until published", async () => {
        await setup();
        const response = await call("/wedding");
        expect(response.status).toBe(404);
        expect(await response.text()).toContain("Page not found");
        expect((await call("/wedding/rsvp")).status).toBe(404);
    });

    it("shows public details only, in its own theme, once published", async () => {
        await setup();
        await enable("wedding.site.public");
        const response = await call("/wedding");
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain('data-theme-lock="light"');
        expect(html).toContain("wedding-theme");
        expect(html).toContain("/assets/wedding-");
        expect(html).toContain("Robin &amp; Jules");
        expect(html).toContain("The Chapel");
        // Private events and every guest detail stay out of the page and its data.
        expect(html).not.toContain("Reception");
        for (const secret of ["Alex", "alex@example.com", "PRIVATE NOTE", "Stranger"]) expect(html).not.toContain(secret);
        // noindex is on by default.
        expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    });

    it("previews inside the portal only for signed-in users", async () => {
        await setup();
        expect((await call("/portal/wedding/website/preview")).status).toBe(401);
        const preview = await call("/portal/wedding/website/preview", { token: await accessToken() });
        expect(preview.status).toBe(200);
        expect(preview.headers.get("Cache-Control")).toBe("no-store");
        expect(await preview.text()).toContain("Preview from the portal");
    });
});

describe("native RSVP", () => {
    it("is closed unless both the website and native RSVP are switched on", async () => {
        const { household } = await setup();
        expect((await publicPost("/api/wedding/rsvp/lookup", { code: household.rsvpCode })).status).toBe(404);
        await enable("wedding.site.public");
        expect((await publicPost("/api/wedding/rsvp/lookup", { code: household.rsvpCode })).json.error).toBe("closed");
        await enable("rsvp.native");
        expect((await publicPost("/api/wedding/rsvp/lookup", { code: household.rsvpCode })).status).toBe(200);
    });

    it("finds a household by code without exposing anything else", async () => {
        const f = await setup();
        await enable("wedding.site.public", "rsvp.native");
        const { status, json } = await publicPost("/api/wedding/rsvp/lookup", { code: f.household.rsvpCode.toLowerCase().replace(/(.{4})/, "$1-") });
        expect(status).toBe(200);
        expect(json.household!.householdName).toBe("Alex & Blake");
        expect(json.household!.guests.map((g) => g.firstName)).toEqual(["Alex", "Blake"]);
        expect(json.household!.responses[f.blake.id]).toEqual({ [f.ceremony.id]: "pending" });
        const raw = JSON.stringify(json);
        for (const secret of ["alex@example.com", "PRIVATE NOTE", "Stranger"]) expect(raw).not.toContain(secret);

        expect((await publicPost("/api/wedding/rsvp/lookup", { code: "WRONG123" })).status).toBe(404);
    });

    it("records a complete response, keeps it verbatim and audits it", async () => {
        const f = await setup();
        await enable("wedding.site.public", "rsvp.native");
        const { status, json } = await publicPost("/api/wedding/rsvp/submit", {
            code: f.household.rsvpCode,
            guests: [
                { guestId: f.alex.id, events: { [f.ceremony.id]: "attending", [f.reception.id]: "attending" }, dietary: "Coeliac" },
                { guestId: f.blake.id, events: { [f.ceremony.id]: "declined" } },
            ],
            message: "Can't wait!",
            email: "household@example.com",
        });
        expect(status).toBe(200);
        expect(json.household!.responses[f.alex.id]).toEqual({ [f.ceremony.id]: "attending", [f.reception.id]: "attending" });

        const { json: list } = await apiCall<{ guests: Guest[] }>("GET", "/api/portal/wedding/guests");
        const alex = list.guests.find((g) => g.id === f.alex.id)!;
        expect(alex).toMatchObject({ rsvp: "attending", dietary: "Coeliac" });
        expect(alex.events.every((e) => e.source === "native")).toBe(true);
        expect(list.guests.find((g) => g.id === f.blake.id)!.rsvp).toBe("declined");

        const submission = await db().prepare("SELECT message FROM rsvp_submissions").first<{ message: string }>();
        expect(submission?.message).toBe("Can't wait!");
        const audit = await db().prepare("SELECT actor FROM audit_log WHERE action = 'rsvp.submit'").first<{ actor: string }>();
        expect(audit?.actor).toBe(`rsvp:${f.household.id}`);
    });

    it("refuses answers for other households, uninvited events or missing people", async () => {
        const f = await setup();
        await enable("wedding.site.public", "rsvp.native");
        const base = { code: f.household.rsvpCode };
        const attempts = [
            // Someone from another household.
            [
                { guestId: f.alex.id, events: { [f.ceremony.id]: "attending", [f.reception.id]: "attending" } },
                { guestId: f.blake.id, events: { [f.ceremony.id]: "attending" } },
                { guestId: f.stranger.id, events: { [f.ceremony.id]: "declined" } },
            ],
            // An event Blake isn't invited to.
            [
                { guestId: f.alex.id, events: { [f.ceremony.id]: "attending", [f.reception.id]: "attending" } },
                { guestId: f.blake.id, events: { [f.ceremony.id]: "attending", [f.reception.id]: "attending" } },
            ],
            // Blake left out.
            [{ guestId: f.alex.id, events: { [f.ceremony.id]: "attending", [f.reception.id]: "attending" } }],
        ];
        for (const guests of attempts) expect((await publicPost("/api/wedding/rsvp/submit", { ...base, guests })).status).toBe(400);
        const changed = await db().prepare("SELECT COUNT(*) AS n FROM guest_events WHERE status != 'pending'").first<{ n: number }>();
        expect(changed?.n).toBe(0);
        expect(await auditActions()).not.toContain("rsvp.submit");
    });

    it("closes after the deadline", async () => {
        const f = await setup();
        await enable("wedding.site.public", "rsvp.native");
        await apiCall("PUT", "/api/portal/settings/rsvp", { externalUrl: "", deadline: "2020-01-01", collectDietary: true, collectMessage: true });
        const lookup = await publicPost("/api/wedding/rsvp/lookup", { code: f.household.rsvpCode });
        expect(lookup.json.household!.deadlinePassed).toBe(true);
        const submit = await publicPost("/api/wedding/rsvp/submit", {
            code: f.household.rsvpCode,
            guests: [
                { guestId: f.alex.id, events: { [f.ceremony.id]: "attending", [f.reception.id]: "attending" } },
                { guestId: f.blake.id, events: { [f.ceremony.id]: "attending" } },
            ],
        });
        expect(submit.status).toBe(409);
    });

    it("rate-limits code guessing per client", async () => {
        await setup();
        await enable("wedding.site.public", "rsvp.native");
        const statuses: number[] = [];
        for (let i = 0; i < 22; i++)
            statuses.push((await publicPost("/api/wedding/rsvp/lookup", { code: `GUESS${String(i).padStart(3, "0")}` }, "198.51.100.9")).status);
        expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
        expect(statuses.slice(20)).toEqual([429, 429]);
        // Another client is unaffected, and no addresses are stored.
        expect((await publicPost("/api/wedding/rsvp/lookup", { code: "GUESS999" }, "198.51.100.10")).status).toBe(404);
        const keys = (await db().prepare("SELECT key FROM rate_limits").all<{ key: string }>()).results.map((r) => r.key);
        expect(keys.join(" ")).not.toContain("198.51");
    });

    it("lets owners test the form from the preview while it's switched off", async () => {
        const f = await setup();
        const token = await accessToken();
        const response = await call("/api/portal/wedding/rsvp-test/lookup", {
            method: "POST",
            token,
            env: await portalEnv(),
            headers: { Origin: ORIGIN, "Content-Type": "application/json" },
            body: JSON.stringify({ code: f.household.rsvpCode }),
        });
        expect(response.status).toBe(200);
        // …but the public endpoint stays closed.
        expect((await publicPost("/api/wedding/rsvp/lookup", { code: f.household.rsvpCode })).status).toBe(404);
    });
});
