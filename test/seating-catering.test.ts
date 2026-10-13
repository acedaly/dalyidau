import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seatingWarnings } from "../src/shared/portal/seating";
import type { CateringSummary, Guest, Household, SeatingState, SeatingTable, WeddingEvent } from "../src/shared/portal/types";
import type { Env } from "../worker/env";
import { accessToken, apiCall, call, db, resetPortal } from "./portal-helpers";

const testEnv = env as unknown as Env;

async function setup() {
    const reception = (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Reception" })).json.item;
    const home = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: "The Placeholders" })).json.item;
    const guest = async (body: Record<string, unknown>) =>
        (await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", { householdId: home.id, events: [reception.id], ...body })).json.guest;
    const ada = await guest({ firstName: "Ada", lastName: "Placeholder", dietary: "Vegetarian" });
    const ben = await guest({ firstName: "Ben", lastName: "Placeholder", allergies: "Peanuts" });
    const cleo = await guest({ firstName: "Cleo", lastName: "Placeholder", ageGroup: "child" });
    const dot = await guest({ firstName: "Dot", lastName: "Placeholder", ageGroup: "infant" });
    const eli = await guest({ firstName: "Eli", lastName: "Elsewhere", householdId: null });
    for (const g of [ada, ben, cleo, dot]) await apiCall("PUT", `/api/portal/wedding/guests/${g.id}/rsvp`, { eventId: reception.id, status: "attending" });
    await apiCall("PUT", `/api/portal/wedding/guests/${eli.id}/rsvp`, { eventId: reception.id, status: "declined" });
    const table = async (name: string, capacity: number) =>
        (await apiCall<{ item: SeatingTable }>("POST", "/api/portal/wedding/seating-tables", { name, capacity })).json.item;
    return { reception, home, ada, ben, cleo, dot, eli, one: await table("Table 1", 3), two: await table("Table 2", 8) };
}

const state = async () => (await apiCall<SeatingState>("GET", "/api/portal/wedding/seating")).json;
const assign = (guestIds: string[], tableId: string | null, position?: number) =>
    apiCall<SeatingState>("PUT", "/api/portal/wedding/seating/assign", { guestIds, tableId, position });

beforeEach(resetPortal);

describe("seating", () => {
    it("seats, orders, moves and unseats guests", async () => {
        const f = await setup();
        await assign([f.ada.id, f.ben.id], f.one.id);
        await assign([f.cleo.id], f.one.id, 0);
        let s = await state();
        expect(s.event?.name).toBe("Reception");
        const order = (tableId: string) =>
            s.guests
                .filter((g) => g.tableId === tableId)
                .sort((a, b) => a.position - b.position)
                .map((g) => g.firstName);
        expect(order(f.one.id)).toEqual(["Cleo", "Ada", "Ben"]);

        await assign([f.ben.id], f.two.id);
        s = await state();
        expect(order(f.one.id)).toEqual(["Cleo", "Ada"]);
        expect(order(f.two.id)).toEqual(["Ben"]);

        await assign([f.ben.id], null);
        s = await state();
        expect(s.guests.find((g) => g.id === f.ben.id)?.tableId).toBeNull();
        // A guest can only ever have one seat.
        const rows = await db().prepare("SELECT COUNT(*) AS n FROM seat_assignments WHERE guest_id = ?").bind(f.ada.id).first<{ n: number }>();
        expect(rows?.n).toBe(1);
    });

    it("warns about capacity, declined guests, split households and unseated guests, without blocking", async () => {
        const f = await setup();
        await assign([f.ada.id, f.ben.id, f.cleo.id, f.dot.id], f.one.id); // 4 into 3 seats
        await assign([f.eli.id], f.two.id); // declined
        let s = await state();
        let kinds = seatingWarnings(s.tables, s.guests).map((w) => w.kind);
        expect(kinds).toEqual(expect.arrayContaining(["over_capacity", "declined_seated"]));

        await assign([f.dot.id], f.two.id);
        s = await state();
        kinds = seatingWarnings(s.tables, s.guests).map((w) => w.kind);
        expect(kinds).toContain("household_split");
        expect(kinds).not.toContain("over_capacity");

        await assign([f.cleo.id], null);
        s = await state();
        expect(seatingWarnings(s.tables, s.guests).find((w) => w.kind === "unseated")?.message).toContain("Cleo");
    });

    it("saves and restores arrangements, and deleting a table unseats its guests", async () => {
        const f = await setup();
        await assign([f.ada.id, f.ben.id], f.one.id);
        const saved = await apiCall<{ snapshots: { id: string }[] }>("POST", "/api/portal/wedding/seating/snapshots", { name: "Plan A" });
        await apiCall("DELETE", `/api/portal/wedding/seating-tables/${f.one.id}`);
        let s = await state();
        expect(s.guests.filter((g) => g.tableId)).toHaveLength(0);

        await apiCall("POST", `/api/portal/wedding/seating/snapshots/${saved.json.snapshots[0].id}/restore`, {});
        s = await state();
        expect(s.tables.map((t) => t.name).sort()).toEqual(["Table 1", "Table 2"]);
        expect(
            s.guests
                .filter((g) => g.tableId === f.one.id)
                .map((g) => g.firstName)
                .sort(),
        ).toEqual(["Ada", "Ben"]);
    });

    it("is read-only for viewers and exports a CSV plan", async () => {
        const f = await setup();
        await apiCall("POST", "/api/portal/users", { email: "viewer@example.com", role: "viewer" });
        expect(
            (await apiCall("PUT", "/api/portal/wedding/seating/assign", { guestIds: [f.ada.id], tableId: f.one.id }, { email: "viewer@example.com" })).status,
        ).toBe(403);
        expect((await apiCall("POST", "/api/portal/wedding/seating-tables", { name: "Sneaky" }, { email: "viewer@example.com" })).status).toBe(403);
        expect((await apiCall("GET", "/api/portal/wedding/seating", undefined, { email: "viewer@example.com" })).status).toBe(200);

        await assign([f.ada.id], f.one.id);
        const csv = await (await call("/api/portal/export/seating.csv", { token: await accessToken() })).text();
        expect(csv).toContain("Table 1,1,Ada Placeholder");
        expect(csv).toContain("Not seated,,Ben Placeholder");
        expect(csv).not.toContain("Eli"); // declined and not seated
    });

    it("removes a guest's seat when they're erased", async () => {
        const f = await setup();
        await assign([f.ada.id], f.one.id);
        await apiCall("DELETE", `/api/portal/wedding/guests/${f.ada.id}`);
        await apiCall("POST", "/api/portal/privacy/erase", { type: "guest", id: f.ada.id, confirm: "Ada Placeholder" });
        expect(await db().prepare("SELECT COUNT(*) AS n FROM seat_assignments").first<{ n: number }>()).toEqual({ n: 0 });
    });
});

describe("catering", () => {
    const summary = async () => (await apiCall<CateringSummary>("GET", "/api/portal/wedding/catering")).json;

    it("counts adults on the buffet by default and never guesses for children", async () => {
        await setup();
        const s = await summary();
        expect(s.attending).toEqual({ adults: 2, children: 1, infants: 1, total: 4 });
        const buffet = s.byCategory.find((c) => c.id === "adult_buffet")!;
        expect(buffet.attending).toBe(2);
        expect(s.undecided).toBe(2); // the child and the infant
        expect(s.guests.find((g) => g.name.startsWith("Ben"))?.allergies).toBe("Peanuts");
    });

    it("lets a child eat the adult buffet, another have a children's meal, and checks categories", async () => {
        const f = await setup();
        await apiCall("POST", "/api/portal/wedding/guests/bulk", { action: "set-meal", ids: [f.cleo.id], mealCategory: "adult_buffet" });
        await apiCall("POST", "/api/portal/wedding/guests/bulk", { action: "set-meal", ids: [f.dot.id], mealCategory: "no_meal" });
        const s = await summary();
        expect(s.byCategory.find((c) => c.id === "adult_buffet")?.attending).toBe(3);
        expect(s.byCategory.find((c) => c.id === "kids_meal")?.attending).toBe(0);
        expect(s.undecided).toBe(0);
        expect((await apiCall("POST", "/api/portal/wedding/guests/bulk", { action: "set-meal", ids: [f.cleo.id], mealCategory: "lobster" })).status).toBe(422);
    });

    it("follows the configured categories and meal event", async () => {
        const f = await setup();
        const bad = await apiCall("PUT", "/api/portal/settings/catering", { eventId: null, categories: [], adultDefault: null, notes: "" });
        expect(bad.status).toBe(422);
        const ok = await apiCall("PUT", "/api/portal/settings/catering", {
            eventId: f.reception.id,
            categories: [
                { id: "feast", label: "Feast", appliesTo: "any" },
                { id: "kids", label: "Kids", appliesTo: "child" },
            ],
            adultDefault: "feast",
            notes: "Gluten free option on every table",
        });
        expect(ok.status).toBe(200);
        const s = await summary();
        expect(s.byCategory.map((c) => c.id)).toEqual(["feast", "kids"]);
        expect(s.byCategory[0].attending).toBe(2);
        const csv = await (await call("/api/portal/export/catering.csv", { token: await accessToken() })).text();
        expect(csv).toContain("Cleo Placeholder,The Placeholders,attending,child,Needs a decision");
    });
});

describe("website draft and publishing", () => {
    const html = async (path: string, token?: string, host?: string) => (await call(path, { ...(token ? { token } : {}), ...(host ? { host } : {}) })).text();

    it("edits a draft that only reaches the public site when published", async () => {
        await apiCall("PUT", "/api/portal/flags/wedding.site.public", { enabled: true });
        const draft = await apiCall<{ value: { sections: { id: string }[] } }>("PUT", "/api/portal/settings/website_draft", {
            heroEyebrow: "Hello",
            heroTitle: "",
            heroSubtitle: "",
            heroImageId: null,
            heroFocalX: 50,
            heroFocalY: 50,
            welcome: "A brand new welcome",
            sections: [
                { id: "bus", kind: "transport", title: "Courtesy bus", body: "Leaves at 3pm (unconfirmed)", visible: false },
                {
                    id: "stay",
                    kind: "accommodation",
                    title: "Where to stay",
                    body: "Book early",
                    items: [{ title: "Rhino Lodge", body: "First in, first served", url: "" }],
                    visible: true,
                },
            ],
            showGallery: false,
            contactEmail: "",
            noindex: true,
        });
        expect(draft.status).toBe(200);
        expect(await html("/", undefined, "wedding.daly.id.au")).not.toContain("A brand new welcome");
        const preview = await html("/portal/wedding/website/preview", await accessToken());
        expect(preview).toContain("A brand new welcome");
        expect(preview).not.toContain("Leaves at 3pm"); // hidden section

        expect((await apiCall("PUT", "/api/portal/settings/website", { heroTitle: "x" })).status).toBe(405);
        expect((await apiCall("POST", "/api/portal/wedding/website/publish", {})).status).toBe(200);
        const live = await html("/", undefined, "wedding.daly.id.au");
        expect(live).toContain("A brand new welcome");
        expect(live).toContain("Rhino Lodge");
        expect(live).not.toContain("Leaves at 3pm");
    });

    it("ships with the couple's details and keeps unconfirmed parts hidden", async () => {
        await apiCall("PUT", "/api/portal/flags/wedding.site.public", { enabled: true });
        const live = await html("/", undefined, "wedding.daly.id.au");
        expect(live).toContain("Aidan &amp; Amelia");
        expect(live).toContain("Saturday 23 October 2027");
        expect(live).toContain("Rhino Lodge");
        // Content from the couple's Say I Do site.
        expect(live).toContain("first come, first served basis");
        expect(live).toContain("The Westbury Dubbo");
        expect(live).toContain("Dubbo RSL courtesy bus");
        expect(live).toContain("Saturday 25 September 2027"); // the RSVP deadline
        expect(live).not.toContain("Our story"); // drafted but hidden
        expect(live).toContain("https://sayi.do/aidanandamelia2258/");
    });

    it("renders the redesigned sections and sends only the photos the content uses", async () => {
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        const used = (await apiCall<{ media: { id: string } }>("POST", "/api/portal/wedding/media", { data: png, alt: "The lodge at dusk" })).json.media;
        const unused = (await apiCall<{ media: { id: string } }>("POST", "/api/portal/wedding/media", { data: png, alt: "UNUSED PHOTO" })).json.media;
        const page = await html("/portal/wedding/website/preview", await accessToken());
        const draft = JSON.parse(/<script[^>]*id="page-data"[^>]*>([\s\S]*?)<\/script>/.exec(page)![1]).data.content;
        const sections = draft.sections.map((s: { kind: string }) => (s.kind === "venue" ? { ...s, imageId: used.id } : s));
        expect((await apiCall("PUT", "/api/portal/settings/website_draft", { ...draft, sections })).status).toBe(200);
        const preview = await html("/portal/wedding/website/preview", await accessToken());
        expect(preview).toContain("The lodge at dusk");
        expect(preview).not.toContain("UNUSED PHOTO");
        expect(preview).not.toContain(unused.id);
        // Venue, accommodation, transport and FAQ sections ship visible.
        for (const text of ["14L Camp Rd, Dubbo NSW 2830", "Get directions", "Frequently asked questions", "We hope you&#x27;ll celebrate with us."])
            expect(preview).toContain(text);
        // **bold** in plain text becomes emphasis, never raw HTML.
        expect(preview).toMatch(/<strong[^>]*>first come, first served basis<\/strong>/);
    });

    it("only accepts real photos and keeps them private until the site is visible", async () => {
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        expect((await apiCall("POST", "/api/portal/wedding/media", { data: svg })).status).toBe(422);
        const upload = await apiCall<{ media: { id: string; url: string; width: number } }>("POST", "/api/portal/wedding/media", { data: png, alt: "A dot" });
        expect(upload.status).toBe(201);
        expect(upload.json.media.width).toBe(1);
        expect((await call(upload.json.media.url)).status).toBe(404);
        expect((await call(upload.json.media.url, { token: await accessToken() })).status).toBe(200);
        await apiCall("PUT", "/api/portal/flags/wedding.site.public", { enabled: true });
        const open = await call(upload.json.media.url);
        expect(open.status).toBe(200);
        expect(open.headers.get("Content-Type")).toBe("image/png");
        await apiCall("DELETE", `/api/portal/wedding/media/${upload.json.media.id}`);
        expect(await testEnv.MEDIA.list({ prefix: "wedding/" })).toMatchObject({ objects: [] });
    });
});
