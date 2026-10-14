// Courtesy bus and accommodation answers on the native RSVP, and the Wedding Planner's transport
// overview, CSV, manual edits, privacy and permissions.
import { beforeEach, describe, expect, it } from "vitest";
import { followUpReasons, validateTravel } from "../src/shared/portal/travel";
import type { Guest, Household, RsvpHousehold, TravelOverview, WeddingEvent } from "../src/shared/portal/types";
import { RHINO_LODGE_STAY, withSuggestedWording } from "../src/shared/portal/website-suggestions";
import { ORIGIN, accessToken, apiCall, call, db, resetPortal } from "./portal-helpers";

type Ages = ("adult" | "child" | "infant")[];
let reception: WeddingEvent | undefined;

/** A household with one guest per entry, all invited to the reception, and a signed link. */
async function household(name: string, people: string[], ages: Ages = [], extra: Partial<Household> = {}) {
    const event = (reception ??= (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Reception" })).json.item);
    const created = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name, ...extra })).json.item;
    const guests: Guest[] = [];
    for (const [i, first] of people.entries()) {
        guests.push(
            (
                await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", {
                    firstName: first,
                    lastName: name.split(" ").pop(),
                    householdId: created.id,
                    ageGroup: ages[i] ?? "adult",
                    events: [event.id],
                })
            ).json.guest,
        );
    }
    const issued = await apiCall<{ household: Household }>("POST", `/api/portal/wedding/households/${created.id}/invitation`, { action: "restore" });
    return { event, household: issued.json.household, guests, token: new URL(issued.json.household.invitationUrl!).searchParams.get("invite")! };
}

let ip = 10;
const publicPost = async (action: "lookup" | "submit", body: unknown) => {
    const response = await call(`/api/wedding/rsvp/${action}`, {
        method: "POST",
        // A fresh client per call keeps the per-client rate limit out of the way.
        headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": `203.0.113.${ip++ % 250}` },
        body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as { household?: RsvpHousehold; error?: string; message?: string } };
};

let client = 0;
const reply = (f: Awaited<ReturnType<typeof household>>, statuses: ("attending" | "declined")[], travel?: unknown) =>
    publicPost("submit", {
        token: f.token,
        clientId: `travel-client-${String(++client).padStart(10, "0")}`,
        guests: f.guests.map((g, i) => ({ guestId: g.id, events: { [f.event.id]: statuses[i] ?? "attending" } })),
        ...(travel === undefined ? {} : { travel }),
    });

const stored = (householdId: string) => db().prepare("SELECT * FROM rsvp_travel WHERE household_id = ?").bind(householdId).first<Record<string, unknown>>();
const overview = async () => (await apiCall<TravelOverview>("GET", "/api/portal/wedding/travel")).json;

beforeEach(async () => {
    await resetPortal();
    reception = undefined;
    for (const flag of ["wedding.site.public", "rsvp.native"]) await apiCall("PUT", `/api/portal/flags/${flag}`, { enabled: true });
});

describe("shared travel rules", () => {
    it("zeroes counts that don't apply and keeps the accommodation name only for Dubbo", () => {
        expect(validateTravel({ bus: "to", outbound: 2, return: 2, stay: "glamping", stayLocation: "Tent 4" }, 3)).toEqual({
            value: { bus: "to", outbound: 2, return: 0, stay: "glamping", stayLocation: null },
        });
        expect(validateTravel({ bus: "none", outbound: 5 }, 2)).toEqual({ value: { bus: "none", outbound: 0, return: 0, stay: null, stayLocation: null } });
        expect(validateTravel({ bus: "both" }, 1)).toMatchObject({ value: { outbound: 1, return: 1 } });
        expect(validateTravel({ bus: "both", outbound: 0, return: 1 }, 2)).toMatchObject({ field: "outbound" });
        expect(validateTravel({ bus: "home", return: 3 }, 2)).toMatchObject({ field: "return" });
        expect(validateTravel({ bus: "taxi" }, 2)).toMatchObject({ field: "bus" });
        expect(validateTravel({ stay: "dubbo", stayLocation: "x".repeat(201) }, 2)).toMatchObject({ field: "stayLocation" });
    });

    it("flags households that need a follow-up", () => {
        const answer = { bus: "both" as const, outbound: 3, return: 3, stay: "glamping" as const, stayLocation: null };
        expect(followUpReasons(answer, 3)).toEqual(["glamping"]);
        expect(followUpReasons(answer, 2)).toEqual(["seats_exceed", "glamping"]);
        expect(followUpReasons(answer, 0)).toEqual(["not_attending"]);
        expect(followUpReasons({ ...answer, bus: "unsure", outbound: 0, return: 0, stay: "unsure" }, 2)).toEqual(["unsure_bus", "unsure_stay"]);
    });
});

describe("native RSVP transport questions", () => {
    it("lets an individual reply without the bus or accommodation, and replaces the per-guest bus question", async () => {
        const solo = await household("Alex Solo", ["Alex"]);
        const bus = await db().prepare("SELECT * FROM rsvp_questions WHERE id = 'q_bus'").first<Record<string, unknown>>();
        await db().prepare("UPDATE rsvp_questions SET published = 1 WHERE id = 'q_bus'").run();

        const opened = await publicPost("lookup", { token: solo.token });
        expect(opened.json.household).toMatchObject({ collectTravel: true, travel: null });
        expect(opened.json.household!.questions.map((q) => q.id)).not.toContain("q_bus");
        expect(bus).toBeTruthy();

        // No travel answer at all, and an explicit empty one, are both fine.
        expect((await reply(solo, ["attending"])).status).toBe(200);
        expect(await stored(solo.household.id)).toBeNull();
        expect((await reply(solo, ["attending"], { bus: null, stay: null })).status).toBe(200);
        expect(await stored(solo.household.id)).toMatchObject({ bus: null, stay: null, outbound_count: 0, return_count: 0 });

        // With one guest coming the count is implied.
        expect((await reply(solo, ["attending"], { bus: "both", stay: "dubbo", stayLocation: "  The   Westbury " })).status).toBe(200);
        expect(await stored(solo.household.id)).toMatchObject({
            bus: "both",
            outbound_count: 1,
            return_count: 1,
            stay_location: "The Westbury",
            source: "native",
        });
    });

    it("validates a couple's and a family's passenger counts against who is coming", async () => {
        const couple = await household("Sam Couple", ["Sam", "Kate"]);
        expect((await reply(couple, ["attending", "attending"], { bus: "both", outbound: 2, return: 1 })).status).toBe(200);
        expect(await stored(couple.household.id)).toMatchObject({ outbound_count: 2, return_count: 1 });
        const tooMany = await reply(couple, ["attending", "declined"], { bus: "both", outbound: 2, return: 1 });
        expect(tooMany).toMatchObject({ status: 400, json: { error: "invalid" } });
        expect(tooMany.json.message).toContain("up to 1");

        const family = await household("Fred Family", ["Fred", "Ann", "Tom", "Lucy", "Baby"], ["adult", "adult", "child", "child", "infant"]);
        expect((await reply(family, ["attending", "attending", "attending", "declined", "declined"], { bus: "to", outbound: 4 })).status).toBe(400);
        expect((await reply(family, ["attending", "attending", "attending", "attending", "attending"], { bus: "to", outbound: 4, return: 9 })).status).toBe(
            200,
        );
        // Only the chosen direction is stored.
        expect(await stored(family.household.id)).toMatchObject({ bus: "to", outbound_count: 4, return_count: 0 });
    });

    it("keeps earlier answers when a reply is edited or the household declines", async () => {
        const couple = await household("Jo Edit", ["Jo", "Max"]);
        await reply(couple, ["attending", "attending"], { bus: "home", return: 2, stay: "dubbo", stayLocation: "Motel on Cobra St" });

        const reopened = await publicPost("lookup", { token: couple.token });
        expect(reopened.json.household!.travel).toEqual({ bus: "home", outbound: 0, return: 2, stay: "dubbo", stayLocation: "Motel on Cobra St" });

        // An older form that doesn't send travel leaves it alone.
        expect((await reply(couple, ["attending", "attending"])).status).toBe(200);
        expect(await stored(couple.household.id)).toMatchObject({ bus: "home", return_count: 2 });

        // Declining everyone keeps the answer, but it stops counting and is flagged.
        expect((await reply(couple, ["declined", "declined"], { bus: "home", return: 2 })).status).toBe(200);
        expect(await stored(couple.household.id)).toMatchObject({ bus: "home", return_count: 2 });
        const row = (await overview()).households.find((h) => h.householdId === couple.household.id)!;
        expect(row).toMatchObject({ attending: 0, return: 0, followUp: ["not_attending"] });

        // Changing direction later clears the seats that no longer apply.
        await reply(couple, ["attending", "attending"], { bus: "none", return: 2, stay: "family", stayLocation: "Mum's" });
        expect(await stored(couple.household.id)).toMatchObject({ bus: "none", return_count: 0, stay: "family", stay_location: null });
    });

    it("stores the answer with the submission and keeps the accommodation name out of the audit log", async () => {
        const f = await household("Pat Audit", ["Pat"]);
        await reply(f, ["attending"], { bus: "to", stay: "dubbo", stayLocation: "12 Secret St" });
        const submission = await db().prepare("SELECT payload FROM rsvp_submissions WHERE household_id = ?").bind(f.household.id).first<{ payload: string }>();
        expect(JSON.parse(submission!.payload).travel).toMatchObject({ bus: "to", stayLocation: "12 Secret St" });
        const audit = await db().prepare("SELECT changes FROM audit_log WHERE action = 'rsvp.submit'").first<{ changes: string }>();
        expect(audit!.changes).toContain('"bus":"to"');
        expect(audit!.changes).not.toContain("Secret");
    });

    it("isn't asked when switched off, and never shows answers on the public site", async () => {
        const f = await household("Lee Public", ["Lee"]);
        await reply(f, ["attending"], { bus: "both", stay: "dubbo", stayLocation: "Hidden Motel" });
        await apiCall("POST", "/api/portal/wedding/website/publish", {});
        for (const path of ["/", "/rsvp"]) {
            const page = await (await call(path, { host: "wedding.daly.id.au" })).text();
            expect(page).not.toContain("Hidden Motel");
            expect(page).not.toContain("Lee");
        }

        const settings = {
            externalUrl: "https://sayi.do/aidanandamelia2258/",
            deadline: "",
            collectDietary: true,
            collectMessage: true,
            allowChangesAfterDeadline: false,
            allowCodes: true,
            linkExpiryDays: 60,
            confirmationEmail: false,
            collectTravel: false,
        };
        expect((await apiCall("PUT", "/api/portal/settings/rsvp", settings)).status).toBe(200);
        expect((await publicPost("lookup", { token: f.token })).json.household).toMatchObject({ collectTravel: false, travel: null });
        // Sent anyway, it's ignored and the saved answer is untouched.
        expect((await reply(f, ["attending"], { bus: "none" })).status).toBe(200);
        expect(await stored(f.household.id)).toMatchObject({ bus: "both" });
    });
});

describe("Wedding Planner transport overview", () => {
    it("summarises passengers, accommodation and follow-ups, and exports a CSV for the RSL", async () => {
        const couple = await household("Sam Couple", ["Sam", "Kate"], [], { email: "sam@example.com", phone: "0400 000 001" });
        const family = await household("Fred Family", ["Fred", "Ann", "Tom"]);
        const unsure = await household("Uma Unsure", ["Uma", "Ian"]);
        const glamping = await household("Gail Glamp", ["Gail"]);
        const silent = await household("Noah Silent", ["Noah"]);
        await household("Not Invited", []);

        await reply(couple, ["attending", "attending"], { bus: "both", outbound: 2, return: 1, stay: "dubbo", stayLocation: "The Westbury" });
        await reply(family, ["attending", "attending", "attending"], { bus: "to", outbound: 3, stay: "dubbo", stayLocation: "the westbury" });
        await reply(unsure, ["attending", "attending"], { bus: "unsure", stay: "unsure" });
        await reply(glamping, ["attending"], { bus: "none", stay: "glamping" });
        await reply(silent, ["attending"]);

        let summary = await overview();
        expect(summary).toMatchObject({ outbound: 5, return: 1, bothWays: 1, unsure: { households: 1, guests: 2 }, unanswered: 1 });
        expect(summary.byStay).toContainEqual({ stay: "dubbo", households: 2, guests: 5 });
        expect(summary.byStay).toContainEqual({ stay: "glamping", households: 1, guests: 1 });
        expect(summary.households.map((h) => h.householdName)).not.toContain("Not Invited");
        expect(summary.households.find((h) => h.householdName === "Gail Glamp")!.followUp).toEqual(["glamping"]);
        expect(summary.households.find((h) => h.householdName === "Uma Unsure")!.followUp).toEqual(["unsure_bus", "unsure_stay"]);

        // Attendance changed in the portal after the reply: seats are capped and flagged.
        await apiCall("PUT", `/api/portal/wedding/guests/${family.guests[2].id}/rsvp`, { eventId: family.event.id, status: "declined" });
        summary = await overview();
        expect(summary.outbound).toBe(4);
        expect(summary.households.find((h) => h.householdName === "Fred Family")).toMatchObject({ attending: 2, outbound: 2, followUp: ["seats_exceed"] });

        const csv = await apiCall("GET", "/api/portal/export/transport.csv");
        expect(csv.status).toBe(200);
        expect(csv.headers.get("Cache-Control")).toContain("no-store");
        const lines = csv.text.trim().split(/\r?\n/);
        expect(lines[0]).toBe(
            "Household,Guests attending,Email,Phone,Courtesy bus,To Rhino Lodge (passengers),Home after (passengers),Staying,Accommodation name or location,Follow up,Answered,Updated at",
        );
        expect(lines.find((l) => l.startsWith("Sam Couple"))).toContain("sam@example.com,0400 000 001,Both ways,2,1,Accommodation in Dubbo,The Westbury");
        expect(lines.find((l) => l.startsWith("Fred Family"))).toContain("More bus seats than guests now coming");
        expect(await db().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'export.transport'").first()).toEqual({ n: 1 });
    });

    it("records an answer given by phone, audited, within the household's attendance", async () => {
        const f = await household("Phone Call", ["Ray", "Sue"]);
        await reply(f, ["attending", "attending"]);
        const bad = await apiCall("PUT", `/api/portal/wedding/households/${f.household.id}/travel`, { bus: "both", outbound: 3, return: 1 });
        expect(bad.status).toBe(422);
        const ok = await apiCall("PUT", `/api/portal/wedding/households/${f.household.id}/travel`, {
            bus: "both",
            outbound: 2,
            return: 1,
            stay: "dubbo",
            stayLocation: "Cobra St",
        });
        expect(ok.status).toBe(200);
        expect(await stored(f.household.id)).toMatchObject({ source: "manual", updated_by: "owner@example.com", outbound_count: 2 });
        const audit = await db().prepare("SELECT changes FROM audit_log WHERE action = 'rsvp.travel.update'").first<{ changes: string }>();
        expect(audit!.changes).not.toContain("Cobra");

        const nobody = await household("Nobody Coming", ["Nia"]);
        await reply(nobody, ["declined"]);
        expect((await apiCall("PUT", `/api/portal/wedding/households/${nobody.household.id}/travel`, { bus: "to" })).status).toBe(422);
    });

    it("is private: viewers can read but not change it, and nobody signed out can reach it", async () => {
        const f = await household("Private Test", ["Val"]);
        await apiCall("POST", "/api/portal/users", { email: "viewer@example.com", role: "viewer" });
        expect((await apiCall("GET", "/api/portal/wedding/travel", undefined, { email: "viewer@example.com" })).status).toBe(200);
        expect((await apiCall("PUT", `/api/portal/wedding/households/${f.household.id}/travel`, { bus: "to" }, { email: "viewer@example.com" })).status).toBe(
            403,
        );
        expect((await apiCall("GET", "/api/portal/export/transport.csv", undefined, { email: "viewer@example.com" })).status).toBe(403);
        expect((await call("/api/portal/wedding/travel")).status).toBe(401);
        expect((await call("/api/portal/wedding/travel", { host: "wedding.daly.id.au", token: await accessToken() })).status).not.toBe(200);
    });

    it("erases a household's transport answer with the household", async () => {
        const f = await household("Erase Me", ["Eve"]);
        await reply(f, ["attending"], { bus: "to", stay: "dubbo", stayLocation: "Somewhere" });
        await apiCall("DELETE", `/api/portal/wedding/households/${f.household.id}`, { guests: "delete" });
        const erased = await apiCall("POST", "/api/portal/privacy/erase", { type: "household", id: f.household.id, confirm: "Erase Me" });
        expect(erased.status).toBe(200);
        expect(await stored(f.household.id)).toBeNull();
    });
});

describe("suggested website wording", () => {
    it("updates the on-site stay and bus wording while keeping other places, links and photos", () => {
        const westbury = { title: "The Westbury Dubbo", body: "Boutique.", url: "https://westburydubbo.com.au/", detail: "5.2 km", imageId: "med_2" };
        const stay = withSuggestedWording({
            id: "stay",
            kind: "accommodation",
            title: "Accommodation",
            body: "Old",
            imageId: "med_1",
            visible: true,
            items: [
                { title: "Dubbo Rhino Lodge", body: "Old", url: "https://www.rhinolodge.com.au/accommodation/", detail: "99 m", imageId: "med_3" },
                westbury,
            ],
        });
        expect(stay.items[0]).toMatchObject({
            title: RHINO_LODGE_STAY.title,
            onSite: true,
            url: "https://www.rhinolodge.com.au/accommodation/",
            imageId: "med_3",
        });
        expect(stay.items[0].body).toContain("first-in, first-served");
        expect(stay.items[1]).toEqual({ ...westbury, onSite: false });
        expect(stay.imageId).toBe("med_1");

        const bus = withSuggestedWording({ id: "bus", kind: "transport", title: "Getting home safely", body: "Old", items: [], imageId: null, visible: true });
        expect(bus.items.map((i) => i.title)).toEqual(["Getting to the wedding", "Getting home"]);
        expect(JSON.stringify(bus)).not.toMatch(/\$|\d{1,2}(:\d\d)?\s?(am|pm)|seats? available|guaranteed/i);
    });

    it("leaves saved website content alone until the couple applies it and publishes", async () => {
        const before = await db().prepare("SELECT COUNT(*) AS n FROM settings WHERE key IN ('website', 'website_draft')").first();
        expect(before).toEqual({ n: 0 });
        const page = await (await call("/", { host: "wedding.daly.id.au" })).text();
        expect(page).toContain("Stay at Rhino Lodge");
        expect(page).toContain("Limited · first in, first served");
        expect(page).toContain("Getting to the wedding");
        expect(page).toContain("subject to the bus driver&#x27;s availability");
    });
});
