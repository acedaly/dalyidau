import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { beforeEach, describe, expect, it } from "vitest";
import { formatInvitees, invitationAddressing } from "../src/shared/portal/invitation-names";
import type { Guest, Household, InvitationPreview, Message, RsvpHousehold, WeddingEvent } from "../src/shared/portal/types";
import { accessToken, apiCall, call, db, resetPortal } from "./portal-helpers";

const WEDDING_HOST = "wedding.daly.id.au";
const person = (firstName: string, lastName = "") => ({ firstName, lastName });

describe("invitation names", () => {
    it("addresses a single guest by full name", () => {
        expect(formatInvitees([person("Fred", "Daly")])).toBe("Fred Daly");
        expect(invitationAddressing([person("Fred", "Daly")])).toEqual({ recipientLine: "Fred Daly", namesLine: null, greetingNames: "Fred" });
    });

    it("joins a couple who share a surname", () => {
        expect(invitationAddressing([person("Fred", "Daly"), person("Ann", "Daly")])).toEqual({
            recipientLine: "Fred & Ann Daly",
            namesLine: null,
            greetingNames: "Fred & Ann",
        });
        // Surnames match regardless of case or stray spaces.
        expect(formatInvitees([person(" Fred ", "Daly"), person("Ann", " daly ")])).toBe("Fred & Ann Daly");
        expect(formatInvitees([person("Oak", "leaf"), person("Pip", "Leaf")])).toBe("Oak & Pip Leaf");
    });

    it("keeps each surname when they differ", () => {
        expect(formatInvitees([person("Sam", "Lee"), person("Kate", "Smith")])).toBe("Sam Lee & Kate Smith");
        expect(formatInvitees([person("Sam", "Lee"), person("Kate", "Smith"), person("Jo", "Brown")])).toBe("Sam Lee, Kate Smith & Jo Brown");
        // Grouped names use "&", so separate groups are joined with "and".
        expect(formatInvitees([person("Fred", "Daly"), person("Kate", "Smith"), person("Ann", "Daly")])).toBe("Fred & Ann Daly and Kate Smith");
    });

    it("lists a family in order", () => {
        expect(formatInvitees([person("Fred", "Daly"), person("Ann", "Daly"), person("Tom", "Daly"), person("Lucy", "Daly")])).toBe(
            "Fred, Ann, Tom & Lucy Daly",
        );
    });

    it("copes with missing surnames and empty rows", () => {
        expect(formatInvitees([person("Fred"), person("Ann")])).toBe("Fred & Ann");
        expect(formatInvitees([person("", ""), person("Fred", "Daly")])).toBe("Fred Daly");
        expect(invitationAddressing([], {}, "The Daly household").recipientLine).toBe("The Daly household");
    });

    it("uses a household's invitation name, with the invited people listed only when asked", () => {
        const family = [person("Fred", "Daly"), person("Ann", "Daly"), person("Tom", "Daly")];
        expect(invitationAddressing(family, { invitationName: "  The Daly Family " })).toEqual({
            recipientLine: "The Daly Family",
            namesLine: null,
            // The greeting is to the invited people by name, never "Dear the Daly Family".
            greetingNames: "Fred, Ann & Tom",
        });
        // With nobody named, the invitation name stands in, with a lower-case article.
        expect(invitationAddressing([], { invitationName: "The Daly Family" }).greetingNames).toBe("the Daly Family");
        expect(invitationAddressing(family, { invitationName: "The Daly Family", listNames: true }).namesLine).toBe("Fred, Ann & Tom Daly");
        // The list option does nothing without an invitation name.
        expect(invitationAddressing(family, { invitationName: "", listNames: true })).toMatchObject({ recipientLine: "Fred, Ann & Tom Daly", namesLine: null });
    });
});

/** The text a page draws. Standard-font text is written as hex strings in the content stream. */
async function pageText(document: PDFDocument, index: number) {
    const contents = document.getPage(index).node.Contents();
    const parts = contents instanceof PDFArray ? contents.asArray().map((ref) => document.context.lookup(ref)) : [contents];
    const streams = parts.filter((part): part is PDFRawStream => part instanceof PDFRawStream);
    const raw = streams.map((stream) => new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode())).join("\n");
    return [...raw.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((match) => match[1].replace(/../g, (pair) => String.fromCharCode(parseInt(pair, 16)))).join("\n");
}

async function household(name: string, guests: [string, string][], event: WeddingEvent, extra: Record<string, unknown> = {}) {
    const item = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name, ...extra })).json.item;
    const members: Guest[] = [];
    for (const [firstName, lastName] of guests)
        members.push(
            (
                await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", {
                    firstName,
                    lastName,
                    householdId: item.id,
                    events: [event.id],
                    email: `${firstName.toLowerCase()}@example.com`,
                })
            ).json.guest,
        );
    return { household: item, guests: members };
}

async function setup() {
    const event = (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Ceremony", startsAt: "2027-10-23T15:30" })).json.item;
    // Imported households are often named after their first guest, which is how "For Fred Daly" crept in.
    const couple = await household(
        "Fred Daly",
        [
            ["Fred", "Daly"],
            ["Ann", "Daly"],
        ],
        event,
    );
    const family = await household(
        "Nguyen",
        [
            ["Linh", "Nguyen"],
            ["Bao", "Nguyen"],
            ["Mai", "Nguyen"],
            ["An", "Nguyen"],
        ],
        event,
        { invitationName: "The Nguyen Family", invitationListNames: true },
    );
    const single = await household("Jo", [["Jo", "Brown"]], event);
    const blended = await household(
        "Lee Smith",
        [
            ["Sam", "Lee"],
            ["Kate", "Smith"],
        ],
        event,
    );
    return { event, couple, family, single, blended };
}

const preview = (body: Record<string, unknown>) => apiCall<{ previews: InvitationPreview[] }>("POST", "/api/portal/wedding/invitations/preview", body);

describe("household invitations", () => {
    beforeEach(resetPortal);

    it("makes one invitation per household, addressed once, for couples, families, single guests and different surnames", async () => {
        const f = await setup();
        const ids = [f.couple, f.family, f.single, f.blended].map((item) => item.household.id);
        const response = await preview({ householdIds: ids, channels: ["email", "print"] });
        expect(response.status, response.text).toBe(200);
        const byHousehold = new Map(response.json.previews.map((item) => [item.householdId, item]));
        expect(response.json.previews).toHaveLength(4);
        expect(byHousehold.get(f.couple.household.id)).toMatchObject({
            delivery: "household",
            guestId: null,
            recipientLine: "Fred & Ann Daly",
            namesLine: null,
            greeting: "Dear Fred & Ann",
            guestNames: ["Fred Daly", "Ann Daly"],
        });
        expect(byHousehold.get(f.family.household.id)).toMatchObject({
            recipientLine: "The Nguyen Family",
            namesLine: "Linh, Bao, Mai & An Nguyen",
            greeting: "Dear Linh, Bao, Mai & An",
        });
        expect(byHousehold.get(f.single.household.id)).toMatchObject({ recipientLine: "Jo Brown", greeting: "Dear Jo" });
        expect(byHousehold.get(f.blended.household.id)).toMatchObject({ recipientLine: "Sam Lee & Kate Smith", greeting: "Dear Sam & Kate" });

        const email = byHousehold.get(f.couple.household.id)!.emailBody;
        expect(email.startsWith("Dear Fred & Ann,")).toBe(true);
        expect(email).toContain("This invitation is for Fred & Ann Daly. You can reply for each person separately.");
        expect(email).not.toMatch(/\bFor Fred|Invited guests|Fred Daly - Ann Daly/);
        expect(byHousehold.get(f.family.household.id)!.emailBody).toContain("This invitation is for The Nguyen Family (Linh, Bao, Mai & An Nguyen).");
        expect(byHousehold.get(f.couple.household.id)!.smsBody).toMatch(/^Dear Fred & Ann, it's Amelia & Aidan! We'd love you to join us on /);
    });

    it("prints one page per household with a single recipient line", async () => {
        const f = await setup();
        const pdf = await call("/api/portal/wedding/invitations/print.pdf", {
            method: "POST",
            token: await accessToken(),
            headers: { Origin: "https://daly.id.au", "Content-Type": "application/json" },
            body: JSON.stringify({ householdIds: [f.couple.household.id, f.family.household.id], channels: ["print"] }),
        });
        expect(pdf.status).toBe(200);
        const document = await PDFDocument.load(await pdf.arrayBuffer());
        expect(document.getPageCount()).toBe(2);
        const texts = [await pageText(document, 0), await pageText(document, 1)];
        const couple = texts.find((text) => text.includes("Fred & Ann Daly"))!;
        expect(couple).toBeDefined();
        expect(couple).not.toMatch(/For |Fred Daly - Ann Daly/);
        // Neither guest gets a line of their own.
        expect(couple.split("\n")).not.toContain("Fred Daly");
        expect(couple.split("\n")).not.toContain("Ann Daly");
        const family = texts.find((text) => text.includes("The Nguyen Family"))!;
        expect(family).toContain("Linh, Bao, Mai & An Nguyen");
    });

    it("regenerates without duplicates: one artefact per household per channel", async () => {
        const f = await setup();
        const request = { householdIds: [f.couple.household.id, f.family.household.id, f.couple.household.id], channels: ["email", "print"] };
        for (let run = 0; run < 3; run++) {
            const generated = await apiCall<{ generated: number; households: number; sent: number }>(
                "POST",
                "/api/portal/wedding/invitations/generate",
                request,
            );
            expect(generated.status, generated.text).toBe(201);
            expect(generated.json).toMatchObject({ generated: 2, households: 2, sent: 0 });
        }
        expect(
            (await db().prepare("SELECT household_id, recipient_key, channel, guest_id FROM invitation_artifacts ORDER BY household_id, channel").all())
                .results,
        ).toEqual(
            [f.couple.household.id, f.family.household.id]
                .sort()
                .flatMap((id) => ["email", "print"].map((channel) => ({ household_id: id, recipient_key: "household", channel, guest_id: null }))),
        );
        expect(await db().prepare("SELECT COUNT(*) AS n FROM messages").first()).toEqual({ n: 0 });
    });

    it("makes one invitation per person only when individual delivery is chosen", async () => {
        const f = await setup();
        const response = await preview({ householdIds: [f.couple.household.id], delivery: "individual", channels: ["print"] });
        expect(response.json.previews.map((item) => [item.recipientLine, item.namesLine, item.guestId])).toEqual([
            ["Fred Daly", null, f.couple.guests[0].id],
            ["Ann Daly", null, f.couple.guests[1].id],
        ]);
        // Individual links still open the whole household's RSVP.
        expect(response.json.previews.every((item) => item.guestNames.length === 2)).toBe(true);
        await apiCall("POST", "/api/portal/wedding/invitations/generate", {
            householdIds: [f.couple.household.id],
            delivery: "individual",
            channels: ["print"],
        });
        expect(await db().prepare("SELECT COUNT(*) AS n FROM invitation_artifacts WHERE guest_id IS NOT NULL").first()).toEqual({ n: 2 });
    });

    it("validates and audits the household invitation name", async () => {
        const f = await setup();
        const tooLong = await apiCall("PATCH", `/api/portal/wedding/households/${f.couple.household.id}`, { invitationName: "x".repeat(121) });
        expect(tooLong.status).toBe(422);
        const saved = await apiCall<{ item: Household }>("PATCH", `/api/portal/wedding/households/${f.couple.household.id}`, {
            invitationName: "Mr & Mrs Daly",
        });
        expect(saved.json.item).toMatchObject({ invitationName: "Mr & Mrs Daly", invitationListNames: false });
        expect((await preview({ householdIds: [f.couple.household.id], channels: ["print"] })).json.previews[0].recipientLine).toBe("Mr & Mrs Daly");
        const cleared = await apiCall<{ item: Household }>("PATCH", `/api/portal/wedding/households/${f.couple.household.id}`, { invitationName: "" });
        expect(cleared.json.item.invitationName).toBeNull();
        expect(
            await db().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action LIKE '%update%'").bind(f.couple.household.id).first(),
        ).toEqual({
            n: 2,
        });
    });
});

describe("RSVP page and email invitations use the same addressing", () => {
    beforeEach(resetPortal);

    it("names every invited guest on the RSVP page and lets each answer separately", async () => {
        const f = await setup();
        await apiCall("PUT", "/api/portal/flags/wedding.site.public", { enabled: true });
        await apiCall("PUT", "/api/portal/flags/rsvp.native", { enabled: true });
        const invitation = (await preview({ householdIds: [f.couple.household.id], channels: ["print"] })).json.previews[0];
        const lookup = await call("/api/wedding/rsvp/lookup", {
            host: WEDDING_HOST,
            method: "POST",
            headers: { Origin: `https://${WEDDING_HOST}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.70" },
            body: JSON.stringify({ token: new URL(invitation.rsvpUrl).searchParams.get("invite") }),
        });
        expect(lookup.status).toBe(200);
        const found = ((await lookup.json()) as { household: RsvpHousehold }).household;
        expect(found.householdName).toBe("Fred & Ann Daly");
        expect(found.guests.map((guest) => `${guest.firstName} ${guest.lastName}`)).toEqual(["Fred Daly", "Ann Daly"]);
        // Each person has their own answer for each event.
        expect(Object.keys(found.responses).sort()).toEqual(f.couple.guests.map((guest) => guest.id).sort());
    });

    it("prepares one email invitation per household, addressed like the printed one", async () => {
        const f = await setup();
        const prepare = (extra: Record<string, unknown> = {}) =>
            apiCall<{ message: Message }>("POST", "/api/portal/wedding/messages", {
                category: "invitation",
                subject: "Invitation for {{invitation_names}}",
                body: "Dear {{greeting_names}},\n\nPlease reply: {{rsvp_link}}",
                audience: { guestIds: [...f.couple.guests, ...f.blended.guests].map((guest) => guest.id) },
                ...extra,
            });
        const first = await prepare();
        expect(first.status, first.text).toBe(201);
        const rows = (
            await db()
                .prepare("SELECT guest_id, name, status, error FROM message_recipients WHERE message_id = ? ORDER BY name")
                .bind(first.json.message.id)
                .all<{ guest_id: string; name: string; status: string; error: string | null }>()
        ).results;
        expect(rows.filter((row) => row.status === "pending").map((row) => [row.guest_id, row.name])).toEqual([
            [f.couple.guests[0].id, "Fred & Ann Daly"],
            [f.blended.guests[0].id, "Sam Lee & Kate Smith"],
        ]);
        expect(rows.find((row) => row.guest_id === f.couple.guests[1].id)).toMatchObject({
            status: "skipped",
            error: "Included in the household invitation to Fred & Ann Daly",
        });

        const rendered = await apiCall<{ subject: string; body: string }>("POST", "/api/portal/wedding/messages/preview", {
            subject: "Invitation for {{invitation_names}}",
            body: "Dear {{greeting_names}},",
            guestId: f.couple.guests[1].id,
        });
        expect(rendered.json).toMatchObject({ subject: "Invitation for Fred & Ann Daly", body: "Dear Fred & Ann," });

        // Preparing again skips both households, including the guest who was covered by the first.
        const second = await prepare();
        const again = (await db().prepare("SELECT status FROM message_recipients WHERE message_id = ?").bind(second.json.message.id).all<{ status: string }>())
            .results;
        expect(again.every((row) => row.status === "skipped")).toBe(true);

        await resetPortal();
        const g = await setup();
        const individual = await apiCall<{ message: Message }>("POST", "/api/portal/wedding/messages", {
            category: "invitation",
            subject: "Invitation",
            body: "Dear {{first_name}}",
            audience: { guestIds: g.couple.guests.map((guest) => guest.id) },
            individualDelivery: true,
        });
        expect(
            (await db().prepare("SELECT name, status FROM message_recipients WHERE message_id = ? ORDER BY name").bind(individual.json.message.id).all())
                .results,
        ).toEqual([
            { name: "Ann Daly", status: "pending" },
            { name: "Fred Daly", status: "pending" },
        ]);
    });
});
