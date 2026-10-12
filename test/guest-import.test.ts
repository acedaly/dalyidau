import { beforeEach, describe, expect, it } from "vitest";
import sample from "../fixtures/sayido/guest-list-sample.csv?raw";
import {
    type ImportDecisions,
    type ImportPlan,
    type ImportReport,
    groupAddresses,
    parseAddress,
    properCase,
    sayIDoLinkId,
    splitGuestName,
    suggestPartyName,
} from "../src/shared/portal/guest-import";
import type { Guest, Household, HouseholdRow, RsvpHousehold, WeddingEvent } from "../src/shared/portal/types";
import { parseCsvRows } from "../worker/portal/csv";
import { ORIGIN, accessToken, apiCall, auditActions, call, db, resetPortal } from "./portal-helpers";

// The fixture is invented, but reproduces every quirk of a real Say I Do guest list export:
// a blank line after the header, a trailing empty column on every row, one-word names, "-" for no
// address, near-identical and conflicting addresses within a party, lower-case surnames, double
// spaces in party names, a party split across two links, and explicit Yes/No answers on two rows.

describe("name splitting", () => {
    it("splits ordinary names and flags the unusual ones for review", () => {
        expect(splitGuestName("Harper Example")).toEqual({ firstName: "Harper", lastName: "Example", review: [], suggestion: null });
        expect(splitGuestName("Kai Fenwick-Hale")).toMatchObject({ firstName: "Kai", lastName: "Fenwick-Hale", review: [] });
        expect(splitGuestName("Lee O'Neil")).toMatchObject({ firstName: "Lee", lastName: "O'Neil", review: [] });
        expect(splitGuestName("Kit Dell'Aqua")).toMatchObject({ lastName: "Dell'Aqua", review: [] });

        const single = splitGuestName("Robin");
        expect(single).toMatchObject({ firstName: "Robin", lastName: "" });
        expect(single.review[0]).toMatch(/Only one name/);

        const lower = splitGuestName("Hayden smith");
        expect(lower).toMatchObject({ firstName: "Hayden", lastName: "smith", suggestion: { firstName: "Hayden", lastName: "Smith" } });
        expect(lower.review).toContain("Check the capitalisation.");

        expect(splitGuestName("Noor van der Berg")).toMatchObject({ firstName: "Noor", lastName: "van der Berg", review: [] });
        expect(splitGuestName("Mary Jane Smith")).toMatchObject({ firstName: "Mary Jane", lastName: "Smith" });
        expect(splitGuestName("Mary Jane Smith").review[0]).toMatch(/More than two names/);
        expect(splitGuestName("Sam & Alex Smith").review).toContain("This looks like more than one person.");
        expect(splitGuestName("  Pip   Leaf ")).toMatchObject({ firstName: "Pip", lastName: "Leaf" });
        expect(properCase("FENWICK-HALE")).toBe("Fenwick-Hale");
        expect(suggestPartyName("Lou, Lee marsh, Ari marsh, Jay, Eve & Cam Marsh")).toBe("Lou, Lee Marsh, Ari Marsh, Jay, Eve & Cam Marsh");
        expect(suggestPartyName("Fred and Ann Daly")).toBeNull();
        expect(suggestPartyName("The Happy Couple")).toBeNull();
    });
});

describe("addresses", () => {
    it("parses Australian one-line addresses without losing anything", () => {
        expect(parseAddress("28 Wattle Crescent Exampleton Park NSW 2527")).toEqual({
            addressLine1: "28 Wattle Crescent",
            addressLine2: null,
            locality: "Exampleton Park",
            region: "NSW",
            postcode: "2527",
            country: "Australia",
        });
        expect(parseAddress("3/45 The Avenue Mocktown NSW 2001")).toMatchObject({ addressLine1: "3/45 The Avenue", locality: "Mocktown" });
        expect(parseAddress("P.O. Box 48 Mockville NSW 2404")).toMatchObject({ addressLine1: "P.O. Box 48", locality: "Mockville", postcode: "2404" });
        expect(parseAddress("Po Box 135 Testburn ")).toMatchObject({ addressLine1: "Po Box 135", locality: "Testburn", postcode: null });
        expect(parseAddress("1 Gum Street,Testvale NSW2004")).toMatchObject({
            addressLine1: "1 Gum Street",
            locality: "Testvale",
            region: "NSW",
            postcode: "2004",
        });
        expect(parseAddress("Unit 2/88 harbour drive, port Example, NSW, 2444")).toMatchObject({
            addressLine1: "Unit 2/88 harbour drive",
            locality: "port Example",
            region: "NSW",
            postcode: "2444",
        });
        expect(parseAddress("114 Example street, Fern Flats, 2529")).toMatchObject({
            addressLine1: "114 Example street",
            locality: "Fern Flats",
            postcode: "2529",
        });
        // A street and a number, not a suburb.
        expect(parseAddress("Sample Street, 1A")).toMatchObject({ addressLine1: "Sample Street, 1A", locality: null });
        expect(parseAddress("Good question")).toMatchObject({ addressLine1: "Good question", locality: null, country: null });
        expect(parseAddress("25 Brolga Drive Sanctuary Example nsw 2005")).toMatchObject({ region: "NSW", locality: "Sanctuary Example" });
    });

    it("treats variants of one address as one, and flags real conflicts", () => {
        const same = groupAddresses([
            { raw: "4 Palmer St Exampleton NSW 2390", guest: "A" },
            { raw: "4 Palmer St Exampleton", guest: "B" },
            { raw: "-", guest: "C" },
        ]);
        expect(same).toEqual([{ text: "4 Palmer St Exampleton NSW 2390", guests: ["A", "B"] }]);
        expect(
            groupAddresses([
                { raw: "47 Example Cct Mockvale NSW 2334", guest: "A" },
                { raw: "47 Example Cct MOCKVALE NSW 2334", guest: "B" },
            ]),
        ).toHaveLength(1);
        const conflict = groupAddresses([
            { raw: "P.O. Box 99 Sampleville NSW 2002", guest: "Drew" },
            { raw: "7 Banksia Road Otherplace NSW 2003", guest: "Emery" },
        ]);
        expect(conflict).toHaveLength(2);
    });
});

describe("reading the file", () => {
    it("keeps real line numbers past blank lines and recognises Say I Do links", () => {
        const rows = parseCsvRows(sample);
        expect(rows[0].line).toBe(1);
        expect(rows[1]).toMatchObject({ line: 3 });
        // Header has 7 columns; Say I Do rows carry an 8th, empty one.
        expect(rows[0].cells).toHaveLength(7);
        expect(rows[1].cells).toHaveLength(8);
        expect(sayIDoLinkId("https://sayi.do/s/AB12CD")).toBe("AB12CD");
        expect(sayIDoLinkId("https://sayi.do/s/ab12cd/")).toBe("AB12CD");
        expect(sayIDoLinkId("https://example.com/s/AB12CD")).toBeNull();
    });
});

// ---------------------------------------------------------------------------------------------

const preview = async (decisions: ImportDecisions = {}, csv = sample) => {
    const response = await apiCall<{ plan: ImportPlan }>("POST", "/api/portal/wedding/guests/import/preview", { csv, decisions });
    expect(response.status, response.text).toBe(200);
    return response.json.plan;
};

const commit = async (plan: ImportPlan, decisions: ImportDecisions = {}, options: { clientId?: string; csv?: string; email?: string } = {}) =>
    apiCall<{ report: ImportReport; guests: Guest[] }>(
        "POST",
        "/api/portal/wedding/guests/import",
        { csv: options.csv ?? sample, fileName: "guestlist.csv", clientId: options.clientId ?? crypto.randomUUID(), decisions, basis: plan.basis },
        { email: options.email },
    );

const count = async (table: string) => (await db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const guestNamed = (guests: Guest[], first: string, last = "") => guests.find((g) => g.firstName === first && g.lastName === last)!;

let ceremony: WeddingEvent;
beforeEach(async () => {
    await resetPortal();
    ceremony = (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Ceremony" })).json.item;
});

describe("Say I Do import preview", () => {
    it("groups guests into households by party and link, and writes nothing", async () => {
        const plan = await preview();
        expect(plan.source).toBe("sayido");
        expect(plan.errors).toEqual([]);
        expect(plan.guests).toHaveLength(25);
        // 13 unique links. The "Casey Placeholder & Avery Test" party uses two links, so it's two households.
        expect(plan.households).toHaveLength(13);
        expect(plan.summary.guests.create).toBe(25);
        expect(plan.summary.households.create).toBe(13);
        expect(plan.fileIssues.map((i) => i.message).join(" ")).toMatch(/25 rows ended with an extra empty column/);
        expect(plan.inviteEventIds).toEqual([ceremony.id]);
        expect(await count("guests")).toBe(0);
        expect(await count("households")).toBe(0);

        const couple = plan.households.find((h) => h.externalId === "TEST01")!;
        expect(couple).toMatchObject({ name: "The Happy Couple", address: null, action: "create" });
        expect(plan.guests.filter((g) => g.householdKey === couple.key).map((g) => g.line)).toEqual([3, 4, 5]);

        const casey = plan.households.filter((h) => h.name === "Casey Placeholder & Avery Test");
        expect(casey).toHaveLength(2);
        expect(casey.every((h) => h.issues.some((i) => /different invitation link/.test(i.message)))).toBe(true);

        // Party names are tidied (double spaces, trailing space) but otherwise kept.
        expect(plan.households.find((h) => h.externalId === "TEST11")!.name).toBe("Oak leaf, Pip Leaf & Rue Leaf");
    });

    it("splits names, flagging single names and capitalisation without changing them", async () => {
        const plan = await preview();
        const byLine = (line: number) => plan.guests.find((g) => g.line === line)!;
        expect(byLine(3)).toMatchObject({ firstName: "Robin", lastName: "" });
        expect(byLine(3).nameReview[0]).toMatch(/Only one name/);
        expect(byLine(16)).toMatchObject({ firstName: "Hayden", lastName: "smith", suggestedName: { firstName: "Hayden", lastName: "Smith" } });
        expect(byLine(22)).toMatchObject({ firstName: "Noor", lastName: "van der Berg", nameReview: [] });
        expect(plan.summary.nameReview).toBe(4); // Robin, Jules, Hayden smith, Oak leaf
    });

    it("keeps addresses, merges variants and flags conflicts and incomplete ones", async () => {
        const plan = await preview();
        const household = (link: string) => plan.households.find((h) => h.externalId === link)!;
        expect(household("TEST02").address).toMatchObject({ addressLine1: "12 Wattle Crescent", locality: "Exampleton", postcode: "2000" });
        expect(household("TEST02").addressConflict).toBe(false);
        // "NSW2004" and "NSW 2004" are the same address.
        expect(household("TEST06").addressChoices).toHaveLength(1);
        expect(household("TEST06").issues.some((i) => /slightly different versions/.test(i.message))).toBe(true);
        expect(household("TEST07").address).toMatchObject({ region: "NSW", postcode: "2005" });
        // A PO box and a street address are a real conflict to resolve.
        expect(household("TEST05")).toMatchObject({ addressConflict: true });
        expect(household("TEST05").addressChoices.map((c) => c.guests)).toEqual([["Drew Fictional"], ["Emery Fictional"]]);
        expect(plan.summary.addressConflicts).toBe(1);
        expect(household("TEST09").issues.some((i) => /looks incomplete/.test(i.message))).toBe(true);
        expect(household("TEST01").address).toBeNull();
    });

    it("treats empty Attending as no response, and ignores Plus One Allowed for named guests", async () => {
        const plan = await preview();
        expect(plan.guests.filter((g) => g.rsvp !== null).map((g) => [g.line, g.rsvp])).toEqual([
            [26, "attending"],
            [27, "declined"],
        ]);
        // Every row says "No", yet every named guest is imported.
        expect(plan.guests.every((g) => g.plusOneAllowed === false && g.action === "create")).toBe(true);
    });

    it("refuses files without a name column", async () => {
        const response = await apiCall("POST", "/api/portal/wedding/guests/import/preview", { csv: "Email\nsomeone@example.com" });
        expect(response.status).toBe(422);
    });
});

describe("Say I Do import", () => {
    it("imports households and guests, invites them, and records an auditable report", async () => {
        const plan = await preview();
        const result = await commit(plan);
        expect(result.status, result.text).toBe(200);
        expect(await count("guests")).toBe(25);
        expect(await count("households")).toBe(13);
        expect(result.json.report.summary.guests.create).toBe(25);
        expect(result.json.report.rows).toHaveLength(25);
        expect(await auditActions()).toContain("guest.import");

        const guests = result.json.guests;
        // Everyone is invited, and only the explicit answers are RSVPs.
        expect(guests.every((g) => g.events.length === 1 && g.events[0].eventId === ceremony.id)).toBe(true);
        expect(guestNamed(guests, "Sky", "Example").events[0]).toMatchObject({ status: "attending", source: "sayido" });
        expect(guestNamed(guests, "Tate", "Example").events[0]).toMatchObject({ status: "declined", source: "sayido" });
        expect(guests.filter((g) => g.rsvp === "pending")).toHaveLength(23);

        const household = await db().prepare("SELECT * FROM households WHERE external_id = 'TEST02'").first<Record<string, string>>();
        expect(household).toMatchObject({ name: "Harper, Quinn, Sage & Wren Sample", external_source: "sayido", address_line1: "12 Wattle Crescent" });
    });

    it("re-importing the same file creates no duplicates and changes nothing", async () => {
        const first = await preview();
        await commit(first);
        const before = await db().prepare("SELECT id, updated_at FROM guests ORDER BY id").all();

        const again = await preview();
        expect(again.previousImports).toHaveLength(1);
        expect(again.summary.guests).toMatchObject({ create: 0, update: 0, link: 0, unchanged: 25 });
        expect(again.summary.households).toMatchObject({ create: 0, update: 0, unchanged: 13 });
        expect(again.households.every((h) => h.target.kind === "existing" && h.target.matchedBy === "link")).toBe(true);
        const second = await commit(again);
        expect(second.status, second.text).toBe(200);
        expect(await count("guests")).toBe(25);
        expect(await count("households")).toBe(13);
        expect(await count("guest_events")).toBe(25);
        expect((await db().prepare("SELECT id, updated_at FROM guests ORDER BY id").all()).results).toEqual(before.results);
        expect(await count("guest_imports")).toBe(2);
    });

    it("is idempotent when the same import is retried", async () => {
        const plan = await preview();
        const clientId = crypto.randomUUID();
        const [a, b] = await Promise.all([commit(plan, {}, { clientId }), commit(plan, {}, { clientId })]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect(a.json.report.id).toBe(b.json.report.id);
        expect(await count("guests")).toBe(25);
        expect(await count("guest_imports")).toBe(1);
    });

    it("applies the preview's edits: names, addresses, skipped guests and parties", async () => {
        const plan = await preview();
        const conflict = plan.households.find((h) => h.externalId === "TEST05")!;
        const skipped = plan.households.find((h) => h.externalId === "TEST09")!;
        const decisions: ImportDecisions = {
            guests: { L3: { lastName: "Example" }, L16: { lastName: "Smith" }, L4: { target: "skip" } },
            households: {
                [conflict.key]: { address: parseAddress(conflict.addressChoices[1].text) },
                [skipped.key]: { target: "skip" },
            },
        };
        const edited = await preview(decisions);
        expect(edited.guests.find((g) => g.line === 3)).toMatchObject({ lastName: "Example", nameReview: [] });
        expect(edited.guests.find((g) => g.line === 21)).toMatchObject({ action: "skip" });
        expect((await commit(edited, decisions)).status).toBe(200);

        const guests = (await apiCall<{ guests: Guest[] }>("GET", "/api/portal/wedding/guests")).json.guests;
        expect(guestNamed(guests, "Robin", "Example")).toBeTruthy();
        expect(guestNamed(guests, "Hayden", "Smith")).toBeTruthy();
        expect(guests.some((g) => g.firstName === "Jules")).toBe(false);
        expect(guests.some((g) => g.firstName === "Mika")).toBe(false);
        expect(guests).toHaveLength(23);
        const household = await db().prepare("SELECT address_line1, locality FROM households WHERE external_id = 'TEST05'").first();
        expect(household).toEqual({ address_line1: "7 Banksia Road", locality: "Otherplace" });
    });

    it("links existing guests to their household instead of duplicating them", async () => {
        const loose = (
            await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", { firstName: "Quinn", lastName: "sample", email: "q@example.com" })
        ).json.guest;
        const other = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: "Somewhere Else" })).json.item;
        const elsewhere = (await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", { firstName: "Pip", lastName: "Leaf", householdId: other.id }))
            .json.guest;

        const plan = await preview();
        const quinn = plan.guests.find((g) => g.line === 7)!;
        expect(quinn).toMatchObject({ action: "link", target: { kind: "existing", id: loose.id, matchedBy: "name" } });
        // Moving someone out of another household is an overwrite, so it waits for confirmation.
        const pip = plan.guests.find((g) => g.line === 24)!;
        expect(pip.target).toMatchObject({ kind: "existing", id: elsewhere.id });
        expect(pip.changes.find((c) => c.field === "household")).toMatchObject({ needsConfirmation: true, applied: false });

        await commit(plan);
        const guests = (await apiCall<{ guests: Guest[] }>("GET", "/api/portal/wedding/guests")).json.guests;
        // 25 rows, two of them existing people: no duplicates.
        expect(guests).toHaveLength(25);
        const linked = guests.find((g) => g.id === loose.id)!;
        expect(linked).toMatchObject({ householdName: "Harper, Quinn, Sage & Wren Sample", email: "q@example.com", lastName: "sample" });
        expect(guests.find((g) => g.id === elsewhere.id)!.householdName).toBe("Somewhere Else");

        // Found the same way on a re-import, now that the party's household exists: still no duplicate.
        const reimport = await preview();
        expect(reimport.summary.guests.create).toBe(0);
        expect(reimport.guests.find((g) => g.line === 24)!.target).toMatchObject({ kind: "existing", id: elsewhere.id });

        // Confirming the move applies it.
        const again = await preview({ guests: { L24: { confirm: ["household"] } } });
        await commit(again, { guests: { L24: { confirm: ["household"] } } });
        const moved = (await apiCall<{ guest: Guest }>("GET", `/api/portal/wedding/guests/${elsewhere.id}`)).json.guest;
        expect(moved.householdName).toBe("Oak leaf, Pip Leaf & Rue Leaf");
    });

    it("never overwrites RSVPs or details without explicit confirmation", async () => {
        await commit(await preview());
        let guests = (await apiCall<{ guests: Guest[] }>("GET", "/api/portal/wedding/guests")).json.guests;
        const sky = guestNamed(guests, "Sky", "Example");
        await apiCall("PUT", `/api/portal/wedding/guests/${sky.id}/rsvp`, { eventId: ceremony.id, status: "declined" });
        const household = (await apiCall<{ items: Household[] }>("GET", "/api/portal/wedding/households")).json.items.find((h) => h.externalId === "TEST02")!;
        await apiCall("PATCH", `/api/portal/wedding/households/${household.id}`, { name: "The Samples", addressLine1: "99 New Road" });

        const plan = await preview();
        const skyPlan = plan.guests.find((g) => g.line === 26)!;
        expect(skyPlan.changes).toEqual([{ field: "rsvp", label: "RSVP", from: "Declined", to: "Attending", needsConfirmation: true, applied: false }]);
        expect(skyPlan.action).toBe("unchanged");
        const householdPlan = plan.households.find((h) => h.externalId === "TEST02")!;
        expect(householdPlan.changes.map((c) => [c.field, c.applied])).toEqual([
            ["name", false],
            ["address", false],
        ]);
        expect(plan.summary.unconfirmed).toBe(3);

        await commit(plan);
        guests = (await apiCall<{ guests: Guest[] }>("GET", "/api/portal/wedding/guests")).json.guests;
        expect(guestNamed(guests, "Sky", "Example").events[0].status).toBe("declined");
        expect(await db().prepare("SELECT name, address_line1 FROM households WHERE id = ?").bind(household.id).first()).toEqual({
            name: "The Samples",
            address_line1: "99 New Road",
        });

        const confirmed: ImportDecisions = { guests: { L26: { confirm: ["rsvp"] } }, households: { [householdPlan.key]: { confirm: ["address"] } } };
        await commit(await preview(confirmed), confirmed);
        guests = (await apiCall<{ guests: Guest[] }>("GET", "/api/portal/wedding/guests")).json.guests;
        expect(guestNamed(guests, "Sky", "Example").events[0]).toMatchObject({ status: "attending", source: "sayido" });
        expect(await db().prepare("SELECT name, address_line1 FROM households WHERE id = ?").bind(household.id).first()).toEqual({
            name: "The Samples",
            address_line1: "12 Wattle Crescent",
        });
    });

    it("refuses to apply a stale preview", async () => {
        await commit(await preview());
        const plan = await preview();
        const guest = (await apiCall<{ guests: Guest[] }>("GET", "/api/portal/wedding/guests")).json.guests[0];
        await apiCall("PATCH", `/api/portal/wedding/guests/${guest.id}`, { notes: "Changed in between" });
        const result = await commit(plan);
        expect(result.status).toBe(409);
        expect(await count("guest_imports")).toBe(1);
    });

    it("doesn't recreate a deleted household or guest", async () => {
        await commit(await preview());
        const household = (await apiCall<{ items: Household[] }>("GET", "/api/portal/wedding/households")).json.items.find((h) => h.externalId === "TEST12")!;
        await apiCall("DELETE", `/api/portal/wedding/households/${household.id}`);
        const plan = await preview();
        const deleted = plan.households.find((h) => h.externalId === "TEST12")!;
        expect(deleted).toMatchObject({ action: "skip", target: { kind: "skip" } });
        expect(plan.guests.find((g) => g.line === 26)!.action).toBe("skip");
    });

    it("suggests matches for close names without guessing", async () => {
        await apiCall("POST", "/api/portal/wedding/guests", { firstName: "Harpur", lastName: "Example" });
        const plan = await preview();
        const harper = plan.guests.find((g) => g.line === 6)!;
        expect(harper.action).toBe("create");
        expect(harper.suggestions[0]).toMatchObject({ name: "Harpur Example", reason: "Similar first name" });
    });

    it("handles plain CSVs with first and last name columns", async () => {
        const csv = "First name,Last name,Email,Household,RSVP\nAlex,Plain,alex@example.com,The Plains,yes\nBea,Plain,,The Plains,\n";
        const plan = await preview({}, csv);
        expect(plan.source).toBe("csv");
        expect(plan.households).toHaveLength(1);
        expect(plan.households[0]).toMatchObject({ name: "The Plains", externalId: null });
        await commit(plan, {}, { csv });
        const again = await preview({}, csv);
        expect(again.summary.guests.unchanged).toBe(2);
        expect(again.households[0].target).toMatchObject({ kind: "existing", matchedBy: "name" });
    });

    it("reports rows it can't import, line by line", async () => {
        const csv = "Guest Name,Email,Party Name\n,a@example.com,X\nBad Email,nope,X\nGood Guest,,X\n";
        const plan = await preview({}, csv);
        expect(plan.errors).toEqual([
            { line: 2, name: "(no name)", message: "No name" },
            { line: 3, name: "Bad Email", message: "“nope” isn't a valid email address" },
        ]);
        const result = await commit(plan, {}, { csv });
        expect(result.json.report.rows.map((r) => [r.line, r.action])).toEqual([
            [2, "error"],
            [3, "error"],
            [4, "create"],
        ]);
    });
});

describe("import reports and permissions", () => {
    it("exports the report as CSV, audited, for people who may export", async () => {
        const { json } = await commit(await preview());
        const response = await call(`/api/portal/wedding/guests/imports/${json.report.id}/report.csv`, {
            token: await accessToken(),
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("Line,Guest,Result,Household");
        expect(text).toContain("Hayden smith");
        expect(text).toContain("Name: Check the capitalisation.");
        expect(await auditActions()).toContain("export.import_report");

        const history = await apiCall<{ imports: { id: string }[] }>("GET", "/api/portal/wedding/guests/imports");
        expect(history.json.imports.map((i) => i.id)).toEqual([json.report.id]);

        await apiCall("POST", "/api/portal/users", { email: "editor@example.com", role: "editor" });
        const editor = await apiCall("GET", `/api/portal/wedding/guests/imports/${json.report.id}/report.csv`, undefined, { email: "editor@example.com" });
        expect(editor.status).toBe(403);
        // Editors can still import and read the report in the portal.
        expect((await apiCall("GET", `/api/portal/wedding/guests/imports/${json.report.id}`, undefined, { email: "editor@example.com" })).status).toBe(200);
    });

    it("erasing a guest scrubs them from import reports", async () => {
        const { json } = await commit(await preview());
        const guest = guestNamed(json.guests, "Mika", "Invented");
        await apiCall("DELETE", `/api/portal/wedding/guests/${guest.id}`);
        expect((await apiCall("POST", "/api/portal/privacy/erase", { type: "guest", id: guest.id, confirm: "Mika Invented" })).status).toBe(200);
        const row = await db().prepare("SELECT name, address, notes FROM guest_import_rows WHERE guest_id = ?").bind(guest.id).first();
        expect(row).toEqual({ name: "[erased]", address: null, notes: "[]" });
    });
});

// ---------------------------------------------------------------------------------------------

const publicPost = async (action: "lookup" | "submit", body: unknown) => {
    const response = await call(`/api/wedding/rsvp/${action}`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.77" },
        body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as { household: RsvpHousehold; message?: string } };
};

describe("imported households on the native RSVP", () => {
    const openHousehold = async (link: string) => {
        for (const flag of ["wedding.site.public", "rsvp.native"]) await apiCall("PUT", `/api/portal/flags/${flag}`, { enabled: true });
        const rows = (await apiCall<{ households: HouseholdRow[] }>("GET", "/api/portal/wedding/households/overview")).json.households;
        const household = rows.find((h) => h.externalId === link)!;
        const token = new URL(household.invitationUrl!).searchParams.get("invite")!;
        return { household, token };
    };

    it("opens with every named guest in the household, in the file's order, by full name", async () => {
        await commit(await preview());
        const { token } = await openHousehold("TEST02");
        const lookup = await publicPost("lookup", { token });
        expect(lookup.status).toBe(200);
        expect(lookup.json.household.guests.map((g) => `${g.firstName} ${g.lastName}`)).toEqual([
            "Harper Example",
            "Quinn Sample",
            "Sage Sample",
            "Wren Sample",
        ]);
    });

    it("accepts a partial reply, shows the household as partly answered, and lets them finish later", async () => {
        await commit(await preview());
        const { household, token } = await openHousehold("TEST07");
        const { json } = await publicPost("lookup", { token });
        const [first, second, third] = json.household.guests;
        const submit = (statuses: ("attending" | "declined" | "pending")[], clientId: string) =>
            publicPost("submit", {
                token,
                clientId,
                guests: [first, second, third].map((g, i) => ({ guestId: g.id, events: { [ceremony.id]: statuses[i] } })),
            });

        // Nothing answered at all is refused.
        expect((await submit(["pending", "pending", "pending"], crypto.randomUUID())).status).toBe(400);

        expect((await submit(["attending", "declined", "pending"], crypto.randomUUID())).status).toBe(200);
        let rows = (await apiCall<{ households: HouseholdRow[] }>("GET", "/api/portal/wedding/households/overview")).json.households;
        expect(rows.find((h) => h.id === household.id)!.response).toMatchObject({
            status: "partial",
            invited: 3,
            answered: 2,
            attending: 1,
            declined: 1,
            waiting: 1,
        });

        expect((await submit(["attending", "declined", "attending"], crypto.randomUUID())).status).toBe(200);
        rows = (await apiCall<{ households: HouseholdRow[] }>("GET", "/api/portal/wedding/households/overview")).json.households;
        expect(rows.find((h) => h.id === household.id)!.response.status).toBe("complete");
        expect(await auditActions()).toContain("rsvp.submit");
    });
});

describe("bulk invitation generation", () => {
    it("marks invitations ready without sending, skipping revoked links", async () => {
        await commit(await preview());
        const households = (await apiCall<{ items: Household[] }>("GET", "/api/portal/wedding/households")).json.items;
        const [a, b] = households;
        await apiCall("POST", `/api/portal/wedding/households/${b.id}/invitation`, { action: "revoke" });
        const result = await apiCall<{ generated: number; skipped: { id: string; reason: string }[]; households: HouseholdRow[] }>(
            "POST",
            "/api/portal/wedding/households/invitations",
            { ids: [a.id, b.id] },
        );
        expect(result.status, result.text).toBe(200);
        expect(result.json.generated).toBe(1);
        expect(result.json.skipped).toEqual([{ id: b.id, name: b.name, reason: "Its link is revoked. Issue a new link first." }]);
        expect(result.json.households.find((h) => h.id === a.id)!.invitationGeneratedAt).toBeTruthy();
        expect(await count("messages")).toBe(0);
        expect(await auditActions()).toContain("household.invitation.generate");

        const csv = await call("/api/portal/export/invitations.csv", { token: await accessToken() });
        expect(csv.status).toBe(200);
        const text = await csv.text();
        expect(text).toContain("Household,Guests,Invitation link");
        expect(text).toContain("https://daly.id.au/wedding/rsvp?invite=");

        // Viewers can't generate.
        await apiCall("POST", "/api/portal/users", { email: "viewer@example.com", role: "viewer" });
        expect((await apiCall("POST", "/api/portal/wedding/households/invitations", { ids: [a.id] }, { email: "viewer@example.com" })).status).toBe(403);
    });
});

describe("review follow-ups", () => {
    it("applies a re-import that only changes the order guests are listed in", async () => {
        await commit(await preview());
        // Swap Sage (line 8) and Wren (line 9) within their party.
        const lines = sample.split("\n");
        const sage = lines.findIndex((l) => l.includes('"Sage Sample"'));
        [lines[sage], lines[sage + 1]] = [lines[sage + 1], lines[sage]];
        const reordered = lines.join("\n");
        const plan = await preview({}, reordered);
        expect(plan.summary.guests.update).toBe(2);
        expect(plan.guests.find((g) => g.firstName === "Wren")!.changes).toEqual([
            { field: "order", label: "Position on invitation", from: "4", to: "3", needsConfirmation: false, applied: true },
        ]);
        expect((await commit(plan, {}, { csv: reordered })).status).toBe(200);
        expect((await preview({}, reordered)).summary.guests.unchanged).toBe(25);
    });

    it("won't map a Say I Do party onto a household that already stands for another party", async () => {
        await commit(await preview());
        const households = (await apiCall<{ items: Household[] }>("GET", "/api/portal/wedding/households")).json.items;
        const other = households.find((h) => h.externalId === "TEST02")!;
        const plan = await preview();
        const couple = plan.households.find((h) => h.externalId === "TEST01")!;
        expect(couple.suggestions.some((s) => s.id === other.id)).toBe(false);
        const response = await apiCall("POST", "/api/portal/wedding/guests/import/preview", {
            csv: sample,
            decisions: { households: { [couple.key]: { target: other.id } } },
        });
        expect(response.status).toBe(422);
        expect(response.text).toContain("already another Say I Do party");
    });
});
