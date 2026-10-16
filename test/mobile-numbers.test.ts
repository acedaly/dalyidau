import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportPlan } from "../src/shared/portal/guest-import";
import { formatMobile, isE164Mobile, normaliseMobile, parseMobile } from "../src/shared/portal/phone";
import { type Guest, type Household, MOBILE_REVIEW_BATCH, type Message, type MobileReview, type WeddingEvent } from "../src/shared/portal/types";
import { smsProvider } from "../worker/comms/providers";
import { apiCall, db, portalEnv, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);
afterEach(() => vi.restoreAllMocks());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const clicksendEnv = () =>
    portalEnv({
        SMS_DELIVERY: "clicksend",
        CLICKSEND_USERNAME: "user",
        CLICKSEND_API_KEY: "key",
        SMS_FROM: "+61400000000",
        COMMS_WEBHOOK_SECRET: "webhook-secret-0123456789abcdef",
    });

const createGuest = (body: Record<string, unknown>) =>
    apiCall<{ guest: Guest; issues?: { path: string; message: string }[] }>("POST", "/api/portal/wedding/guests", body);
const storedPhone = async (table: "guests" | "households", id: string) =>
    (await db().prepare(`SELECT phone FROM ${table} WHERE id = ?`).bind(id).first<{ phone: string | null }>())!.phone;
/** Simulates a number saved before the portal standardised them. */
const legacy = (table: "guests" | "households", id: string, phone: string) => db().prepare(`UPDATE ${table} SET phone = ? WHERE id = ?`).bind(phone, id).run();

describe("the shared mobile number utility", () => {
    it.each([
        ["0412345678", "+61412345678"],
        ["0412 345 678", "+61412345678"],
        ["0412-345-678", "+61412345678"],
        ["(04) 1234 5678", "+61412345678"],
        ["0412.345.678", "+61412345678"],
        ["+61412345678", "+61412345678"],
        ["+61 412 345 678", "+61412345678"],
        ["+61 (0) 412 345 678", "+61412345678"],
        ["+61 0412 345 678", "+61412345678"],
        ["61412345678", "+61412345678"],
        ["61 412 345 678", "+61412345678"],
        ["  0412 345 678 ", "+61412345678"],
    ])("reads the Australian mobile %j as %s", (input, expected) => {
        expect(parseMobile(input)).toEqual({ ok: true, e164: expected, australian: true, assumed: false });
        expect(normaliseMobile(input)).toBe(expected);
    });

    it("reads nine digits starting with 4 (a spreadsheet's lost 0) but marks it as assumed", () => {
        expect(parseMobile("412 345 678")).toEqual({ ok: true, e164: "+61412345678", australian: true, assumed: true });
    });

    it.each([
        ["+64 21 123 4567", "+64211234567"],
        ["+44 7700 900123", "+447700900123"],
        ["+44 (0)7700 900123", "+447700900123"],
        ["+1 (415) 555-0123", "+14155550123"],
        ["+65 8123 4567", "+6581234567"],
    ])("keeps the overseas number %j in E.164 as %s without adding +61", (input, expected) => {
        expect(parseMobile(input)).toEqual({ ok: true, e164: expected, australian: false, assumed: false });
    });

    it.each([
        ["02 6884 0000", "landline"],
        ["(02) 6884 0000", "landline"],
        ["+61 2 6884 0000", "landline"],
        ["0412 345 67", "australian_length"],
        ["0412 345 6789", "australian_length"],
        ["+61 412 345 67", "australian_length"],
        // A New Zealand mobile written locally reads as an Australian 02 landline: refused, never given +61.
        ["021 123 4567", "landline"],
        ["64 21 123 4567", "country_code"],
        ["0011 64 21 123 4567", "country_code"],
        ["12345", "country_code"],
        ["+0412345678", "country_code"],
        ["+64 21", "international_length"],
        ["+1234567890123456", "international_length"],
        ["0412 345 678 ext 2", "characters"],
        ["0412 345 678 / 0423 456 789", "characters"],
        ["4.12346E+08", "characters"],
        ["call Mum", "characters"],
        ["041234567+", "characters"],
    ])("refuses %j (%s) with guidance", (input, problem) => {
        const result = parseMobile(input);
        expect(result).toMatchObject({ ok: false, problem });
        expect(result.ok ? "" : result.message).toMatch(/\w/);
        expect(normaliseMobile(input)).toBeNull();
    });

    it("accepts a spreadsheet's leading apostrophe, as our own CSV exports add before a +", () => {
        expect(normaliseMobile("'+64211234567")).toBe("+64211234567");
        expect(normaliseMobile("'0412 345 678")).toBe("+61412345678");
        expect(normaliseMobile("''0412 345 678")).toBeNull();
    });

    it("treats empty values as no number, recognises stored E.164 and formats for reading", () => {
        expect(normaliseMobile("")).toBeNull();
        expect(normaliseMobile("   ")).toBeNull();
        expect(normaliseMobile(null)).toBeNull();
        expect(isE164Mobile("+61412345678")).toBe(true);
        expect(isE164Mobile("0412345678")).toBe(false);
        expect(isE164Mobile("+61 412 345 678")).toBe(false);
        expect(isE164Mobile("+61268840000")).toBe(false);
        expect(formatMobile("+61412345678")).toBe("0412 345 678");
        expect(formatMobile("+64211234567")).toBe("+64211234567");
    });
});

describe("guest and household forms", () => {
    it("save valid mobiles in E.164 and refuse invalid ones with a field error", async () => {
        const local = await createGuest({ firstName: "Lo", phone: "0412 345 678" });
        expect(local.status).toBe(201);
        expect(local.json.guest.phone).toBe("+61412345678");
        expect((await createGuest({ firstName: "Kiwi", phone: "+64 21 123 4567" })).json.guest.phone).toBe("+64211234567");
        expect((await createGuest({ firstName: "None", phone: "" })).json.guest.phone).toBeNull();

        for (const phone of ["02 6884 0000", "021 123 4567", "0412 345", "0412 345 678 ext 2"]) {
            const refused = await createGuest({ firstName: "Bad", phone });
            expect(refused.status, phone).toBe(422);
            expect(refused.json.issues?.[0]?.path).toBe("phone");
        }
        expect((await createGuest({ firstName: "Land", phone: "02 6884 0000" })).json.issues?.[0]?.message).toMatch(/landline/);

        const edited = await apiCall<{ guest: Guest }>("PATCH", `/api/portal/wedding/guests/${local.json.guest.id}`, { phone: "+61 423 456 789" });
        expect(edited.json.guest.phone).toBe("+61423456789");
        expect((await apiCall("PATCH", `/api/portal/wedding/guests/${local.json.guest.id}`, { phone: "0423" })).status).toBe(422);
        expect(await storedPhone("guests", local.json.guest.id)).toBe("+61423456789");
        // The audit log records that the number changed, never the number.
        const audit = await db().prepare("SELECT changes FROM audit_log WHERE action = 'guest.update'").first<{ changes: string }>();
        expect(audit!.changes).not.toContain("423");

        const household = await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: "The Mobiles", phone: "0412 345 678" });
        expect(household.json.item.phone).toBe("+61412345678");
        const badHousehold = await apiCall<{ issues: { path: string }[] }>("POST", "/api/portal/wedding/households", {
            name: "Landline",
            phone: "(02) 6884 0000",
        });
        expect(badHousehold.status).toBe(422);
        expect(badHousehold.json.issues[0].path).toBe("phone");
    });

    it("let unrelated edits through when an untouched legacy number no longer passes, without rewriting it", async () => {
        const guest = (await createGuest({ firstName: "Old", lastName: "Number" })).json.guest;
        await legacy("guests", guest.id, "02 6884 0000");
        const saved = await apiCall<{ guest: Guest }>("PATCH", `/api/portal/wedding/guests/${guest.id}`, {
            firstName: "Older",
            phone: "02 6884 0000",
        });
        expect(saved.status).toBe(200);
        expect(saved.json.guest).toMatchObject({ firstName: "Older", phone: "02 6884 0000" });
        // Changing it still has to produce a valid mobile; clearing it is fine.
        expect((await apiCall("PATCH", `/api/portal/wedding/guests/${guest.id}`, { phone: "02 6884 0001" })).status).toBe(422);
        expect((await apiCall<{ guest: Guest }>("PATCH", `/api/portal/wedding/guests/${guest.id}`, { phone: "" })).json.guest.phone).toBeNull();

        const home = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: "Legacy Home" })).json.item;
        await legacy("households", home.id, "0412 345 678 (Mum)");
        const renamed = await apiCall<{ item: Household }>("PATCH", `/api/portal/wedding/households/${home.id}`, {
            name: "Legacy House",
            phone: "0412 345 678 (Mum)",
        });
        expect(renamed.status).toBe(200);
        expect(renamed.json.item).toMatchObject({ name: "Legacy House", phone: "0412 345 678 (Mum)" });
    });
});

describe("CSV import", () => {
    const csv = [
        "First name,Last name,Email,Mobile",
        "Ava,Local,ava@example.com,0412 345 678",
        "Ben,Plus,ben@example.com,+61 423 456 789",
        "Cal,Sixty,cal@example.com,61434567890",
        "Dee,Dropped,dee@example.com,445678901",
        "Eli,Kiwi,eli@example.com,+64 21 123 4567",
        "Fay,Landline,fay@example.com,(02) 6884 0000",
        "Gus,Overseas,gus@example.com,021 123 4567",
        "Hal,Blank,hal@example.com,",
    ].join("\n");

    const preview = async (file = csv) => {
        const response = await apiCall<{ plan: ImportPlan }>("POST", "/api/portal/wedding/guests/import/preview", { csv: file, decisions: {} });
        expect(response.status, response.text).toBe(200);
        return response.json.plan;
    };
    const commit = (plan: ImportPlan, file = csv) =>
        apiCall("POST", "/api/portal/wedding/guests/import", {
            csv: file,
            fileName: "guests.csv",
            clientId: crypto.randomUUID(),
            decisions: {},
            basis: plan.basis,
        });
    const phones = async () =>
        Object.fromEntries(
            (await db().prepare("SELECT first_name, phone FROM guests ORDER BY first_name").all<{ first_name: string; phone: string | null }>()).results.map(
                (r) => [r.first_name, r.phone],
            ),
        );

    it("imports every guest, standardises valid mobiles and leaves out invalid ones with a warning", async () => {
        const plan = await preview();
        expect(plan.errors).toEqual([]);
        const issues = (name: string) => plan.guests.find((g) => g.firstName === name)!.issues.map((i) => `${i.level}: ${i.message}`);
        expect(issues("Dee")).toContainEqual(expect.stringMatching(/^info: .*missing its leading 0; saved as \+61445678901/));
        expect(issues("Fay")).toContainEqual(expect.stringMatching(/^warning: Mobile “\(02\) 6884 0000” wasn't imported\. .*landline/));
        expect(issues("Gus")).toContainEqual(expect.stringMatching(/^warning: Mobile “021 123 4567” wasn't imported\. .*start an overseas number with \+/));
        expect(issues("Ava").filter((i) => /Mobile/.test(i))).toEqual([]);

        expect((await commit(plan)).status).toBe(200);
        expect(await phones()).toEqual({
            Ava: "+61412345678",
            Ben: "+61423456789",
            Cal: "+61434567890",
            Dee: "+61445678901",
            Eli: "+64211234567",
            Fay: null,
            Gus: null,
            Hal: null,
        });
    });

    it("never blanks or reformats an existing guest's number on re-import", async () => {
        await commit(await preview());
        await db().prepare("UPDATE guests SET phone = '0412 345 678' WHERE first_name = 'Ava'").run(); // legacy format
        await db().prepare("UPDATE guests SET phone = '+61499999999' WHERE first_name = 'Fay'").run();
        const again = await preview();
        const changes = (name: string) => again.guests.find((g) => g.firstName === name)!.changes.filter((c) => c.field === "phone");
        // Same number written differently: not a change. Invalid number in the file: the saved one stays.
        expect(changes("Ava")).toEqual([]);
        expect(changes("Fay")).toEqual([]);
        await commit(again);
        expect(await phones()).toMatchObject({ Ava: "0412 345 678", Fay: "+61499999999" });

        // A genuinely different number is still offered, and needs confirmation to replace a saved one.
        const changed = await preview(csv.replace("+61 423 456 789", "0400 111 222"));
        expect(changed.guests.find((g) => g.firstName === "Ben")!.changes).toContainEqual(
            expect.objectContaining({ field: "phone", from: "+61423456789", to: "+61400111222", needsConfirmation: true }),
        );
    });
});

describe("CSV export", () => {
    it("writes Australian mobiles as 0412 345 678 and round-trips through import", async () => {
        await createGuest({ firstName: "Ava", lastName: "Local", email: "ava@example.com", phone: "0412 345 678" });
        await createGuest({ firstName: "Eli", lastName: "Kiwi", email: "eli@example.com", phone: "+64 21 123 4567" });
        const exported = await apiCall("GET", "/api/portal/export/guests.csv");
        expect(exported.text).toContain(",0412 345 678,");
        // The formula guard still applies to a leading +.
        expect(exported.text).toContain(",'+64211234567,");
        expect(exported.text).not.toContain("+61412345678");

        const plan = (
            await apiCall<{ plan: ImportPlan }>("POST", "/api/portal/wedding/guests/import/preview", {
                csv: exported.text.replace(/^\uFEFF/, ""),
                decisions: {},
            })
        ).json.plan;
        for (const guest of plan.guests) {
            expect(
                guest.changes.filter((c) => c.field === "phone"),
                guest.firstName,
            ).toEqual([]);
            expect(
                guest.issues.filter((i) => /Mobile/.test(i.message)),
                guest.firstName,
            ).toEqual([]);
        }
    });
});

describe("SMS delivery", () => {
    it("refuses anything but a valid E.164 mobile before contacting ClickSend", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        const provider = smsProvider(await clicksendEnv())!;
        for (const to of ["0412345678", "+61 412 345 678", "+61268840000", "61412345678", "", "+64 21"]) {
            await expect(provider.send({ to, body: "Hi" }), to).rejects.toThrow(/isn't a valid mobile/);
        }
        expect(fetchMock).not.toHaveBeenCalled();

        fetchMock.mockResolvedValueOnce(json({ data: { messages: [{ status: "SUCCESS", message_id: "cs-1" }] } }));
        await provider.send({ to: "+64211234567", body: "Kia ora" });
        expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).messages[0].to).toBe("+64211234567");
    });

    it("texts legacy-format and overseas mobiles in E.164 and skips numbers that can't be texted", async () => {
        const event = (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Reception" })).json.item;
        const add = async (firstName: string, stored: string | null) => {
            const guest = (await createGuest({ firstName, events: [event.id] })).json.guest;
            if (stored) await legacy("guests", guest.id, stored);
            return guest;
        };
        const people = {
            oldFormat: await add("Old", "0412 345 678"),
            kiwi: await add("Kiwi", "+64 21 123 4567"),
            landline: await add("Land", "(02) 6884 0000"),
            garbled: await add("Garbled", "ring after 5"),
            none: await add("None", null),
        };
        const preview = await apiCall<{ withMobile: number; invalidMobile: number }>("POST", "/api/portal/wedding/messages/audience", {});
        expect(preview.json).toMatchObject({ withMobile: 2, invalidMobile: 2 });

        const message = (
            await apiCall<{ message: Message }>("POST", "/api/portal/wedding/messages", {
                channel: "sms",
                category: "update",
                subject: "Bus",
                body: "Hi {{first_name}}",
                audience: {},
            })
        ).json.message;
        const rows = await db()
            .prepare("SELECT guest_id, phone, status, error FROM message_recipients WHERE message_id = ?")
            .bind(message.id)
            .all<{ guest_id: string; phone: string | null; status: string; error: string | null }>();
        const by = Object.fromEntries(rows.results.map((r) => [r.guest_id, r]));
        expect(by[people.oldFormat.id]).toMatchObject({ phone: "+61412345678", status: "pending" });
        expect(by[people.kiwi.id]).toMatchObject({ phone: "+64211234567", status: "pending" });
        expect(by[people.landline.id]).toMatchObject({ phone: null, status: "skipped", error: "Mobile number isn't valid" });
        expect(by[people.garbled.id]).toMatchObject({ phone: null, status: "skipped", error: "Mobile number isn't valid" });
        expect(by[people.none.id]).toMatchObject({ phone: null, status: "skipped", error: "No mobile number" });

        await apiCall("PUT", "/api/portal/flags/communications.sms", { enabled: true });
        const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ data: { messages: [{ status: "SUCCESS", message_id: "cs" }] } }));
        const sent = await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.id}/send`, {}, { env: await clicksendEnv() });
        expect(sent.json.message.status).toBe("sent");
        const recipients = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)).messages[0].to).sort();
        expect(recipients).toEqual(["+61412345678", "+64211234567"]);
    });

    it("normalises a typed reply number and the controlled test number", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        const env = await clicksendEnv();
        const test = (to: string) => apiCall("POST", "/api/portal/wedding/providers/test", { channel: "sms", to, confirm: "SEND TEST" }, { env });
        expect((await test("02 6884 0000")).status).toBe(422);
        expect((await test("+64 21 123 4567")).status).toBe(422); // the controlled test must be an Australian mobile
        expect(fetchMock).not.toHaveBeenCalled();
        fetchMock.mockResolvedValueOnce(json({ data: { messages: [{ status: "SUCCESS", message_id: "cs-test" }] } }));
        expect((await test("0412 345 678")).status).toBe(200);
        expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).messages[0].to).toBe("+61412345678");
    });
});

describe("permanent erasure", () => {
    it("finds texts and webhooks for a legacy number the stricter parser no longer reads", async () => {
        const guest = (await createGuest({ firstName: "Slash", lastName: "Number" })).json.guest;
        // Accepted by the old normaliser, so texts and replies were stored as +61412345678.
        await legacy("guests", guest.id, "0412/345/678");
        expect(normaliseMobile("0412/345/678")).toBeNull();
        const now = new Date().toISOString();
        await db().batch([
            db()
                .prepare(
                    "INSERT INTO sms_messages (id, direction, phone, body, status, created_by, created_at) VALUES ('reply', 'inbound', '+61412345678', 'See you there', 'received', 'clicksend', ?)",
                )
                .bind(now),
            db()
                .prepare(
                    "INSERT INTO comm_webhook_events (id, provider, kind, dedupe_key, payload, received_at) VALUES ('hook', 'clicksend', 'inbound', 'k1', '{\"from\":\"61412345678\"}', ?)",
                )
                .bind(now),
        ]);

        await apiCall("DELETE", `/api/portal/wedding/guests/${guest.id}`);
        expect((await apiCall("POST", "/api/portal/privacy/erase", { type: "guest", id: guest.id, confirm: "Slash Number" })).status).toBe(200);
        const left = await db().batch([db().prepare("SELECT id FROM sms_messages"), db().prepare("SELECT id FROM comm_webhook_events")]);
        expect(left.map((r) => r.results)).toEqual([[], []]);
    });
});

describe("mobile number review", () => {
    const review = async () => (await apiCall<MobileReview>("GET", "/api/portal/wedding/mobile-numbers")).json;
    const apply = (changes: { kind: string; id: string; from: string; to: string }[], options: { email?: string } = {}) =>
        apiCall<{ updated: number; skipped: number; review: MobileReview }>(
            "POST",
            "/api/portal/wedding/mobile-numbers",
            { changes, confirmed: true },
            options,
        );

    async function legacyGuests() {
        const event = (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Ceremony" })).json.item;
        const home = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: "The Legacies" })).json.item;
        const add = async (firstName: string, stored: string) => {
            const guest = (await createGuest({ firstName, householdId: home.id, events: [event.id] })).json.guest;
            await legacy("guests", guest.id, stored);
            return guest;
        };
        const guests = {
            local: await add("Local", "0412 345 678"),
            spaced: await add("Spaced", "+61 423 456 789"),
            dropped: await add("Dropped", "434567890"),
            landline: await add("Landline", "(02) 6884 0000"),
            nz: await add("Nz", "021 123 4567"),
            done: (await createGuest({ firstName: "Done", phone: "+61400000001" })).json.guest,
        };
        await legacy("households", home.id, "0400 000 002");
        await apiCall("PUT", `/api/portal/wedding/guests/${guests.local.id}/rsvp`, { eventId: event.id, status: "attending" });
        return { event, home, guests };
    }

    it("previews without changing anything, and only offers clear-cut numbers by default", async () => {
        const { home, guests } = await legacyGuests();
        const before = await db().prepare("SELECT id, phone, updated_at FROM guests ORDER BY id").all();
        const result = await review();
        expect(await db().prepare("SELECT id, phone, updated_at FROM guests ORDER BY id").all()).toEqual(before);

        expect(result.counts).toEqual({ standard: 1, update: 3, check: 1, invalid: 2 });
        const row = (id: string) => result.rows.find((r) => r.id === id)!;
        expect(row(guests.local.id)).toMatchObject({
            kind: "guest",
            status: "update",
            stored: "0412 345 678",
            proposed: "+61412345678",
            household: "The Legacies",
        });
        expect(row(guests.spaced.id)).toMatchObject({ status: "update", proposed: "+61423456789" });
        expect(row(home.id)).toMatchObject({ kind: "household", status: "update", proposed: "+61400000002" });
        expect(row(guests.dropped.id)).toMatchObject({ status: "check", proposed: "+61434567890" });
        expect(row(guests.landline.id)).toMatchObject({ status: "invalid", proposed: null, reason: expect.stringMatching(/landline/) });
        expect(row(guests.nz.id)).toMatchObject({ status: "invalid", proposed: null });
        expect(result.rows.find((r) => r.id === guests.done.id)).toBeUndefined();
    });

    it("applies only the chosen changes, keeps RSVPs and households, and audits without numbers", async () => {
        const { event, home, guests } = await legacyGuests();
        const rows = (await review()).rows;
        const chosen = rows.filter((r) => r.status === "update").map((r) => ({ kind: r.kind, id: r.id, from: r.stored, to: r.proposed! }));
        const result = await apply(chosen);
        expect(result.status).toBe(200);
        expect(result.json).toMatchObject({ updated: 3, skipped: 0 });
        expect(result.json.review.counts).toEqual({ standard: 4, update: 0, check: 1, invalid: 2 });

        expect(await storedPhone("guests", guests.local.id)).toBe("+61412345678");
        expect(await storedPhone("guests", guests.spaced.id)).toBe("+61423456789");
        expect(await storedPhone("households", home.id)).toBe("+61400000002");
        // Not chosen, ambiguous or invalid: untouched.
        expect(await storedPhone("guests", guests.dropped.id)).toBe("434567890");
        expect(await storedPhone("guests", guests.landline.id)).toBe("(02) 6884 0000");
        expect(await storedPhone("guests", guests.nz.id)).toBe("021 123 4567");

        const local = (await apiCall<{ guest: Guest }>("GET", `/api/portal/wedding/guests/${guests.local.id}`)).json.guest;
        expect(local).toMatchObject({ householdId: home.id, events: [expect.objectContaining({ eventId: event.id, status: "attending" })] });

        const audit = await db()
            .prepare("SELECT entity_type, entity_id, changes FROM audit_log WHERE summary LIKE '%mobile number review%' ORDER BY entity_id")
            .all<{ entity_type: string; entity_id: string; changes: string }>();
        expect(audit.results.map((a) => a.entity_id).sort()).toEqual([guests.local.id, guests.spaced.id, home.id].sort());
        for (const entry of audit.results) expect(entry.changes).not.toMatch(/\d{6}/);

        // An ambiguous number is changed once someone ticks it.
        const dropped = rows.find((r) => r.id === guests.dropped.id)!;
        expect((await apply([{ kind: "guest", id: dropped.id, from: dropped.stored, to: dropped.proposed! }])).json.updated).toBe(1);
        expect(await storedPhone("guests", guests.dropped.id)).toBe("+61434567890");
    });

    it("never writes a value of the caller's choosing, an invalid number, or over a later edit", async () => {
        const { guests } = await legacyGuests();
        expect((await apply([{ kind: "guest", id: guests.local.id, from: "0412 345 678", to: "+61499999999" }])).status).toBe(422);
        expect((await apply([{ kind: "guest", id: guests.landline.id, from: "(02) 6884 0000", to: "+61268840000" }])).status).toBe(422);
        expect((await apply([])).status).toBe(422);
        // Larger selections are sent in batches by the portal; one oversized request is refused whole.
        const tooMany = Array.from({ length: MOBILE_REVIEW_BATCH + 1 }, (_, i) => ({ kind: "guest", id: `g${i}`, from: "0412 345 678", to: "+61412345678" }));
        expect((await apply(tooMany)).status).toBe(422);
        expect(
            (
                await apiCall("POST", "/api/portal/wedding/mobile-numbers", {
                    changes: [{ kind: "guest", id: guests.local.id, from: "0412 345 678", to: "+61412345678" }],
                })
            ).status,
        ).toBe(422); // not confirmed
        expect(await storedPhone("guests", guests.local.id)).toBe("0412 345 678");

        // Someone edited the number after the preview: the stale change is skipped.
        await apiCall("PATCH", `/api/portal/wedding/guests/${guests.local.id}`, { phone: "0400 123 456" });
        const stale = await apply([{ kind: "guest", id: guests.local.id, from: "0412 345 678", to: "+61412345678" }]);
        expect(stale.json).toMatchObject({ updated: 0, skipped: 1 });
        expect(await storedPhone("guests", guests.local.id)).toBe("+61400123456");
    });

    it("is limited to people who can edit guests", async () => {
        const { guests } = await legacyGuests();
        await apiCall("POST", "/api/portal/users", { email: "viewer@example.com", role: "viewer" });
        expect((await apiCall("GET", "/api/portal/wedding/mobile-numbers", undefined, { email: "viewer@example.com" })).status).toBe(403);
        const refused = await apply([{ kind: "guest", id: guests.local.id, from: "0412 345 678", to: "+61412345678" }], { email: "viewer@example.com" });
        expect(refused.status).toBe(403);
        expect(await storedPhone("guests", guests.local.id)).toBe("0412 345 678");
    });
});
