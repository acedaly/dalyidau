// The guest's journey from a message: the Save the Date (email, text, page and calendar file), the
// formal invitation text and the household's own invitation page, then the RSVP. Every provider is
// mocked: nothing is ever sent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { foldIcsLine, googleCalendarUrl, icsFile, outlookCalendarUrl, weddingCalendarEvent, zonedTimeToUtc } from "../src/shared/portal/calendar";
import { CAMPAIGNS } from "../src/shared/portal/campaigns";
import { invitationEventLines } from "../src/shared/portal/invitation-events";
import { invitationAddressing } from "../src/shared/portal/invitation-names";
import type { Guest, Household, Message, MessagePreflight, WeddingDetails, WeddingEvent } from "../src/shared/portal/types";
import { stationeryEmailHtml } from "../worker/comms/stationery";
import type { Env } from "../worker/env";
import { pdfQrCode, pdfText } from "./pdf-helpers";
import { apiCall, call, db, portalEnv, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);

const WEDDING_HOST = "wedding.daly.id.au";
const SITE = `https://${WEDDING_HOST}`;
const WEDDING: WeddingDetails = {
    partnerOne: "Aidan",
    partnerTwo: "Amelia",
    date: "2027-10-23",
    location: "Rhino Lodge · Dubbo, NSW",
    timeZone: "Australia/Sydney",
};

const enable = (...flags: string[]) => Promise.all(flags.map((flag) => apiCall("PUT", `/api/portal/flags/${flag}`, { enabled: true })));

type Sent = { to: { email: string; name?: string }; subject: string; text: string; html: string };

async function emailEnv() {
    const send = vi.fn(async (_message: Sent) => ({ messageId: `cf-${Math.random().toString(36).slice(2)}` }));
    const env = await portalEnv({ EMAIL_DELIVERY: "cloudflare", EMAIL_FROM: "wedding@daly.id.au", EMAIL: { send } as unknown as Env["EMAIL"] });
    return { env, send };
}

/** A couple, a family with a custom invitation name, and a single guest; ceremony and reception at Rhino Lodge. */
async function setup() {
    const event = async (body: Record<string, unknown>) => (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", body)).json.item;
    const ceremony = await event({ name: "Ceremony", startsAt: "2027-10-23T15:30", venueName: "Rhino Lodge" });
    const reception = await event({ name: "Reception", startsAt: "2027-10-23T17:30", endsAt: "2027-10-23T23:30", venueName: "Rhino Lodge" });
    const home = async (name: string, extra: Record<string, unknown> = {}) =>
        (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name, ...extra })).json.item;
    const guest = async (body: Record<string, unknown>) =>
        (await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", { events: [ceremony.id, reception.id], ...body })).json.guest;
    const couple = await home("Example");
    const fred = await guest({ firstName: "Fred", lastName: "Example", email: "fred@example.com", phone: "0412 345 678", householdId: couple.id });
    await guest({ firstName: "Ann", lastName: "Example", householdId: couple.id });
    const family = await home("Sample", { invitationName: "The Sample Family" });
    const sam = await guest({ firstName: "Sam", lastName: "Sample", email: "sam@example.com", phone: "0412 345 679", householdId: family.id });
    await guest({ firstName: "Tom", lastName: "Sample", householdId: family.id });
    return { ceremony, reception, couple, family, fred, sam };
}

const prepare = (body: Record<string, unknown>) =>
    apiCall<{ message: Message }>("POST", "/api/portal/wedding/messages", { channel: "email", audience: {}, ...body });

const preview = (body: Record<string, unknown>) =>
    apiCall<{ body: string; html: string; missing: string[]; sms: { segments: number; encoding: string; length: number } }>(
        "POST",
        "/api/portal/wedding/messages/preview",
        body,
    );

const check = async (messageId: string) =>
    (await apiCall<{ preflight: MessagePreflight }>("GET", `/api/portal/wedding/messages/${messageId}/preflight`)).json.preflight;

/** The household's own signed RSVP link, as the invitation email carries it. */
const rsvpLinkFor = async (householdId: string) => {
    const rendered = await preview({ category: "invitation", channel: "email", subject: "x", body: "{{rsvp_link}}", householdId });
    return rendered.json.body.trim();
};

describe("calendar events", () => {
    const allDay = weddingCalendarEvent({ details: WEDDING, events: [{ startsAt: "2027-10-23T15:30", endsAt: null }], site: SITE })!;

    it("is an all-day event with an exclusive end date unless a start and a finish are both confirmed", () => {
        // A start time alone never becomes an invented finish.
        expect(allDay).toMatchObject({ start: null, end: null, date: "2027-10-23", title: "Aidan & Amelia's Wedding", location: "Rhino Lodge, Dubbo NSW" });
        const ics = icsFile(allDay, new Date("2026-10-17T01:02:03Z"));
        expect(ics).toContain("\r\nDTSTART;VALUE=DATE:20271023\r\n");
        expect(ics).toContain("\r\nDTEND;VALUE=DATE:20271024\r\n");
        expect(ics).toContain("\r\nDTSTAMP:20261017T010203Z\r\n");
        expect(ics).not.toMatch(/DURATION|T\d{6}(?!Z)/);
    });

    it("uses Australia/Sydney times, written as UTC, when the start and finish are confirmed", () => {
        const timed = weddingCalendarEvent({
            details: WEDDING,
            events: [
                { startsAt: "2027-10-23T15:30", endsAt: null },
                { startsAt: "2027-10-23T17:30", endsAt: "2027-10-24T00:30" },
            ],
            site: SITE,
        })!;
        // 23 October 2027 is daylight time (UTC+11).
        expect(timed.start?.toISOString()).toBe("2027-10-23T04:30:00.000Z");
        expect(timed.end?.toISOString()).toBe("2027-10-23T13:30:00.000Z");
        const ics = icsFile(timed);
        expect(ics).toContain("\r\nDTSTART:20271023T043000Z\r\n");
        expect(ics).toContain("\r\nDTEND:20271023T133000Z\r\n");
        // Winter is standard time (UTC+10).
        expect(zonedTimeToUtc("2027-07-01T12:00", "Australia/Sydney")?.toISOString()).toBe("2027-07-01T02:00:00.000Z");
    });

    it("writes a valid iCalendar file: CRLF, escaped text, folded lines, a stable UID and nothing about any household", () => {
        const first = icsFile(allDay);
        const again = icsFile(allDay);
        const lines = first.split("\r\n");
        expect(first.endsWith("\r\n")).toBe(true);
        expect(first).not.toMatch(/[^\r]\n/);
        expect(lines[0]).toBe("BEGIN:VCALENDAR");
        for (const pair of ["VCALENDAR", "VEVENT"]) expect(first.match(new RegExp(`BEGIN:${pair}`, "g"))).toHaveLength(1);
        for (const required of ["VERSION:2.0", "PRODID:", "UID:", "DTSTAMP:", "DTSTART", "DTEND", "SUMMARY:", "LOCATION:", "DESCRIPTION:"])
            expect(lines.some((line) => line.startsWith(required))).toBe(true);
        expect(first).toContain("LOCATION:Rhino Lodge\\, Dubbo NSW");
        expect(first).toContain("SUMMARY:Aidan & Amelia's Wedding");
        // The same UID every time, so saving again updates the event instead of adding another.
        expect(/UID:(.*)/.exec(first)?.[1]).toBe("wedding-2027-10-23@wedding.daly.id.au");
        expect(/UID:(.*)/.exec(again)?.[1]).toBe(/UID:(.*)/.exec(first)?.[1]);
        for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);

        // Folding never splits a character and unfolds back to the original line.
        const long = `DESCRIPTION:${"Café, waratah & banksia; ".repeat(8)}🌿`;
        const folded = foldIcsLine(long);
        for (const line of folded.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
        expect(folded.replace(/\r\n /g, "")).toBe(long);
    });

    it("prefills Google Calendar and Outlook correctly", () => {
        const google = new URL(googleCalendarUrl(allDay));
        expect(google.origin + google.pathname).toBe("https://calendar.google.com/calendar/render");
        expect(Object.fromEntries(google.searchParams)).toMatchObject({
            action: "TEMPLATE",
            text: "Aidan & Amelia's Wedding",
            dates: "20271023/20271024",
            location: "Rhino Lodge, Dubbo NSW",
            ctz: "Australia/Sydney",
        });
        const outlook = new URL(outlookCalendarUrl(allDay, "live"));
        expect(outlook.origin).toBe("https://outlook.live.com");
        expect(Object.fromEntries(outlook.searchParams)).toMatchObject({
            rru: "addevent",
            path: "/calendar/action/compose",
            subject: "Aidan & Amelia's Wedding",
            startdt: "2027-10-23",
            enddt: "2027-10-24",
            allday: "true",
            location: "Rhino Lodge, Dubbo NSW",
        });
        expect(new URL(outlookCalendarUrl(allDay, "office")).origin).toBe("https://outlook.office.com");
    });
});

describe("invitation wording", () => {
    it("names a shared venue once, keeping every event's own time", () => {
        const at = (name: string, time: string | null, venue: string | null) => ({ name, startsAt: time ? `2027-10-23T${time}` : null, venue });
        expect(invitationEventLines([at("Ceremony", "15:30", "Rhino Lodge"), at("Reception", "17:30", "Rhino Lodge")])).toEqual([
            "Ceremony and reception at Rhino Lodge",
            "Ceremony - 3:30 pm",
            "Reception - 5:30 pm",
        ]);
        // Different venues, or a single event, keep each venue on its own line.
        // Listed in the order they happen, whatever order they were entered in.
        expect(invitationEventLines([at("Reception", "17:30", "Rhino Lodge"), at("Ceremony", "15:30", "rhino lodge")])).toEqual([
            "Ceremony and reception at Rhino Lodge",
            "Ceremony - 3:30 pm",
            "Reception - 5:30 pm",
        ]);
        expect(invitationEventLines([at("Ceremony", "15:30", "St Mary's"), at("Reception", "17:30", "Rhino Lodge")])).toEqual([
            "Ceremony - 3:30 pm at St Mary's",
            "Reception - 5:30 pm at Rhino Lodge",
        ]);
        expect(invitationEventLines([at("Ceremony", "15:30", "Rhino Lodge")])).toEqual(["Ceremony - 3:30 pm at Rhino Lodge"]);
    });

    it("greets the invited people by name without changing who the invitation is for", () => {
        const people = [
            { firstName: "Sam", lastName: "Lee" },
            { firstName: "Sam", lastName: "Smith" },
        ];
        // Two people called Sam are told apart rather than greeted as "Sam & Sam".
        expect(invitationAddressing(people)).toEqual({ recipientLine: "Sam Lee & Sam Smith", namesLine: null, greetingNames: "Sam Lee & Sam Smith" });
        const family = [
            { firstName: "Linh", lastName: "Nguyen" },
            { firstName: "Bao", lastName: "Nguyen" },
        ];
        expect(invitationAddressing(family, { invitationName: "The Nguyens" })).toEqual({
            recipientLine: "The Nguyens",
            namesLine: null,
            greetingNames: "Linh & Bao",
        });
    });

    it("uses the refined invitation wording and a plain RSVP button", async () => {
        const f = await setup();
        await enable("wedding.site.public");
        const copy = CAMPAIGNS.invitation.copy;
        expect(copy.body).toContain("We would love for you to join us as we celebrate our marriage.");
        const rendered = await preview({ category: "invitation", channel: "email", subject: copy.subject, body: copy.body, householdId: f.couple.id });
        const html = rendered.json.html;
        expect(html).toContain("INVITATION FOR");
        expect(html).not.toContain("WITH PLEASURE");
        expect(html).toContain("Ceremony and reception at Rhino Lodge<br>Ceremony - 3:30 pm<br>Reception - 5:30 pm");
        expect(html).toMatch(/<a href="https:\/\/wedding\.daly\.id\.au\/rsvp\?invite=[^"]+"[^>]*>RSVP<\/a>/);
        expect(rendered.json.body).toContain("Dear Fred & Ann,");
    });
});

describe("the invitation text", () => {
    it("is warm and short, and links each household to its own invitation page", async () => {
        const f = await setup();
        const sms = (householdId: string) =>
            preview({ category: "invitation", channel: "sms", subject: "", body: CAMPAIGNS.invitation.copy.smsBody, householdId });
        const fred = (await sms(f.couple.id)).json;
        const sam = (await sms(f.family.id)).json;
        expect(fred.body).toMatch(
            /^Dear Fred & Ann, it's Aidan & Amelia! We'd love you to join us on Saturday 23 October 2027\. Your personal invitation and RSVP: https:\/\/wedding\.daly\.id\.au\/invitation\?invite=\S+ Please reply by /,
        );
        expect(fred.body).not.toContain("/rsvp?invite=");
        // GSM characters only, so it stays cheap; the link makes it two parts.
        expect(fred.sms).toMatchObject({ encoding: "gsm", segments: 2 });
        const token = (text: string) => /invitation\?invite=(\S+)/.exec(text)?.[1];
        expect(token(fred.body)).toBeTruthy();
        expect(token(fred.body)).not.toBe(token(sam.body));
        expect(sam.body).toMatch(/^Dear Sam & Tom,/);
        // The fictional sample (previews and test sends) never gets a signed link.
        const sample = (await preview({ category: "invitation", channel: "sms", subject: "", body: CAMPAIGNS.invitation.copy.smsBody })).json;
        expect(sample.missing).toEqual([]);
        expect(sample.body).not.toContain("invite=");
        // The same signed link as the household's RSVP: one credential, two front doors.
        expect(await rsvpLinkFor(f.couple.id)).toBe(`${SITE}/rsvp?invite=${token(fred.body)}`);
    });
});

describe("the household's invitation page", () => {
    const page = (path: string) => call(path, { host: WEDDING_HOST });

    it("shows the household's own invitation, then RSVP and the PDF, and nobody else's details", async () => {
        const f = await setup();
        await enable("wedding.site.public", "rsvp.native");
        const rsvpUrl = await rsvpLinkFor(f.couple.id);
        const token = new URL(rsvpUrl).searchParams.get("invite")!;
        const response = await page(`/invitation?invite=${encodeURIComponent(token)}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
        expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
        const html = await response.text();
        expect(html).toContain("Fred &amp; Ann Example");
        expect(html).toContain("Invitation for");
        expect(html).toContain("Saturday, 23 October 2027");
        expect(html).toContain("Ceremony and reception at Rhino Lodge");
        // The RSVP button opens the existing RSVP form on the same signed link.
        expect(html).toContain(`href="${rsvpUrl.replace(/&/g, "&amp;")}"`);
        expect(html).toContain(`href="${SITE}/invitation.pdf?invite=${encodeURIComponent(token)}"`);
        // Nothing about any other household, no RSVP code, and the title never names the household.
        expect(html).not.toContain("Sample");
        const code = await db().prepare("SELECT rsvp_code FROM households WHERE id = ?").bind(f.couple.id).first<{ rsvp_code: string }>();
        expect(html).not.toContain(code!.rsvp_code);
        expect(/<title>(.*)<\/title>/.exec(html)?.[1]).toBe("Your invitation · Aidan &amp; Amelia");
        expect(html).toContain('<meta name="referrer" content="no-referrer">');

        // The PDF download is the same household's printable invitation with its own QR code.
        const pdf = await page(`/invitation.pdf?invite=${encodeURIComponent(token)}`);
        expect(pdf.status).toBe(200);
        expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
        expect(pdf.headers.get("Cache-Control")).toBe("no-store");
        const bytes = new Uint8Array(await pdf.arrayBuffer());
        expect(await pdfText(bytes)).toContain("Fred & Ann Example");
        expect(await pdfQrCode(bytes)).toBe(rsvpUrl);
    });

    it("refuses a tampered, revoked, replaced or expired link with the same page, and stays closed until the site is published", async () => {
        const f = await setup();
        const token = new URL(await rsvpLinkFor(f.couple.id)).searchParams.get("invite")!;
        // Not published yet: nothing at all.
        expect((await page(`/invitation?invite=${token}`)).status).toBe(404);
        expect((await page(`/invitation.pdf?invite=${token}`)).status).toBe(404);
        await enable("wedding.site.public");
        expect((await page(`/invitation?invite=${token}`)).status).toBe(200);

        const refused = async (path: string) => {
            const response = await page(path);
            expect(response.status).toBe(404);
            expect(response.headers.get("Cache-Control")).toBe("no-store");
            const html = await response.text();
            expect(html).not.toContain("Fred");
            expect(html).not.toContain("Example");
        };
        const tampered = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
        await refused(`/invitation?invite=${tampered}`);
        await refused("/invitation");
        await refused("/invitation?invite=not-a-token");
        expect((await page(`/invitation.pdf?invite=${tampered}`)).status).toBe(404);

        // A replaced link (new version) stops working; so does a revoked one.
        await db().prepare("UPDATE households SET invite_version = invite_version + 1 WHERE id = ?").bind(f.couple.id).run();
        await refused(`/invitation?invite=${token}`);
        await db()
            .prepare("UPDATE households SET invite_version = invite_version - 1, invite_revoked_at = '2026-10-17T00:00:00Z' WHERE id = ?")
            .bind(f.couple.id)
            .run();
        await refused(`/invitation?invite=${token}`);
        await db().prepare("UPDATE households SET invite_revoked_at = NULL WHERE id = ?").bind(f.couple.id).run();
        expect((await page(`/invitation?invite=${token}`)).status).toBe(200);

        // Expired: past the deadline plus the link's grace period.
        const expired = await apiCall("PUT", "/api/portal/settings/rsvp", {
            externalUrl: "",
            deadline: "2020-01-01",
            collectDietary: true,
            collectMessage: true,
            allowChangesAfterDeadline: false,
            allowCodes: true,
            linkExpiryDays: 1,
            confirmationEmail: false,
        });
        expect(expired.status, expired.text).toBe(200);
        await refused(`/invitation?invite=${token}`);
        expect((await page(`/invitation.pdf?invite=${token}`)).status).toBe(404);
    });

    it("also works on the path-based wedding site, and only answers GET", async () => {
        const f = await setup();
        await enable("wedding.site.public");
        const token = new URL(await rsvpLinkFor(f.couple.id)).searchParams.get("invite")!;
        expect((await call(`/wedding/invitation?invite=${token}`)).status).toBe(200);
        expect((await call(`/invitation?invite=${token}`, { host: WEDDING_HOST, method: "POST" })).status).toBe(405);
    });
});

describe("the Save the Date", () => {
    it("emails the designed announcement with Add to Calendar, and never invites anyone or touches RSVPs", async () => {
        await setup();
        await enable("wedding.save_the_date.public");
        const state = async () => ({
            rsvps: (await db().prepare("SELECT guest_id, event_id, status FROM guest_events ORDER BY guest_id, event_id").all()).results,
            households: (await db().prepare("SELECT id, invitation_generated_at, invite_version, invite_revoked_at FROM households ORDER BY id").all()).results,
        });
        const before = await state();
        const { subject, body } = CAMPAIGNS.save_the_date.copy;
        const message = await prepare({ category: "save_the_date", subject, body });
        expect(message.status, message.text).toBe(201);
        const plan = await check(message.json.message.id);
        // One email per household.
        expect(plan).toMatchObject({ households: 2, recipients: 2 });
        expect(plan.warnings.join(" ")).not.toContain("Save the Date page isn't switched on");

        const { env, send } = await emailEnv();
        await enable("communications.delivery");
        const sent = await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${message.json.message.id}/send`, { confirmCount: 2 }, { env });
        expect(sent.json.message.status).toBe("sent");
        expect(send).toHaveBeenCalledTimes(2);
        const fred = send.mock.calls.map((c) => c[0]).find((m) => m.to.email === "fred@example.com")!;
        expect(fred.subject).toBe("Save the date: Aidan & Amelia, Saturday 23 October 2027");
        for (const text of [
            "SAVE THE DATE",
            "Are getting married!",
            "SATURDAY, 23 OCTOBER 2027",
            "Rhino Lodge, Dubbo NSW",
            "Formal invitation to follow.",
            "ADD TO CALENDAR",
            ">Apple Calendar</a>",
            ">Google Calendar</a>",
            ">Outlook</a>",
            ">Microsoft 365</a>",
            ">Other calendars (.ics)</a>",
            `href="${SITE}/save-the-date.ics"`,
            "https://calendar.google.com/calendar/render?action=TEMPLATE",
            "https://outlook.live.com/calendar/0/action/compose?",
            `href="${SITE}/save-the-date"`,
            ">View the Save the Date</a>",
        ])
            expect(fred.html).toContain(text);
        // Nothing about replying: no RSVP link, code or deadline, and no household's signed link.
        expect(fred.html).not.toMatch(/rsvp|invite=|reply by/i);
        // Readable with images blocked: decorative artwork, every word is text.
        expect([...fred.html.matchAll(/<img [^>]*alt="([^"]*)"/g)].every((m) => m[1] === "")).toBe(true);
        expect(fred.text).toContain("Dear Fred & Ann,");
        expect(fred.text).toContain("SAVE THE DATE\n\nAidan & Amelia\nAre getting married!\n\nSaturday, 23 October 2027\nRhino Lodge, Dubbo NSW");
        expect(fred.text).toContain(`Apple Calendar: ${SITE}/save-the-date.ics`);
        expect(fred.text).toContain(`View the Save the Date: ${SITE}/save-the-date`);
        const sam = send.mock.calls.map((c) => c[0]).find((m) => m.to.email === "sam@example.com")!;
        expect(sam.text).toContain("Dear Sam & Tom,");
        expect(sam.html).not.toContain("Fred");

        expect(await state()).toEqual(before);
        // Sending it again is held back unless "send another" is chosen.
        const again = await prepare({ category: "save_the_date", subject, body });
        expect((await check(again.json.message.id)).recipients).toBe(0);
    });

    it("leaves out the page and .ics links until the page is served, and says so in the send check", async () => {
        const f = await setup();
        const { subject, body } = CAMPAIGNS.save_the_date.copy;
        const rendered = await preview({ category: "save_the_date", channel: "email", subject, body, householdId: f.couple.id });
        expect(rendered.json.html).toContain(">Google Calendar</a>");
        expect(rendered.json.html).not.toContain("save-the-date");
        expect(rendered.json.html).not.toContain("Apple Calendar");
        const message = await prepare({ category: "save_the_date", subject, body });
        expect((await check(message.json.message.id)).warnings.join(" ")).toContain("The Save the Date page isn't switched on yet");
    });

    it("refuses RSVP details: links, codes, deadlines and the invitation page", async () => {
        await setup();
        for (const field of ["rsvp_link", "rsvp_code", "rsvp_deadline", "invitation_link", "invitation_card"]) {
            const refused = await prepare({ category: "save_the_date", subject: "Save the date", body: `{{${field}}}` });
            expect(refused.status, field).toBe(422);
        }
        // And the Save the Date itself belongs only to a save the date.
        expect((await prepare({ category: "reminder", subject: "Reminder", body: "{{save_the_date_card}}" })).status).toBe(422);
    });

    it("texts a short personal note with the page link, and reports parts and cost before sending", async () => {
        const f = await setup();
        await enable("wedding.save_the_date.public");
        await apiCall("PUT", "/api/portal/settings/comms", { testEmails: [], testMobiles: [], smsCentsPerPart: 8 });
        const { subject, smsBody } = CAMPAIGNS.save_the_date.copy;
        const rendered = await preview({ category: "save_the_date", channel: "sms", subject, body: smsBody, householdId: f.couple.id });
        expect(rendered.json.body).toBe(
            `Hi Fred & Ann! Save the date: Aidan & Amelia are getting married on Saturday 23 October 2027 at Rhino Lodge, Dubbo NSW. Add it to your calendar and see the details: ${SITE}/save-the-date Formal invitation to follow.`,
        );
        expect(rendered.json.sms).toMatchObject({ encoding: "gsm", segments: 2 });

        // Sam has opted out of texts: held back, and the cost covers only Fred's household.
        await db().prepare("UPDATE guests SET sms_opt_out_at = '2026-10-01T00:00:00Z' WHERE id = ?").bind(f.sam.id).run();
        const message = await prepare({ category: "save_the_date", channel: "sms", subject, body: smsBody });
        const plan = await check(message.json.message.id);
        expect(plan).toMatchObject({ households: 1, recipients: 1, sms: { parts: 2, maxParts: 2, estimatedCents: 16 } });
        expect(plan.excluded.map((e) => e.reason)).toContain("Opted out of texts");
    });

    it("holds back a text that links to the page while the page isn't served", async () => {
        await setup();
        const { subject, smsBody } = CAMPAIGNS.save_the_date.copy;
        const message = await prepare({ category: "save_the_date", channel: "sms", subject, body: smsBody });
        const plan = await check(message.json.message.id);
        expect(plan.recipients).toBe(0);
        expect(plan.excluded.map((e) => e.reason)).toContain("A detail this message needs is missing: {{save_the_date_link}}");
    });

    it("serves a public page and a calendar file with no household details, only when switched on", async () => {
        await setup();
        expect((await call("/save-the-date", { host: WEDDING_HOST })).status).toBe(404);
        expect((await call("/save-the-date.ics", { host: WEDDING_HOST })).status).toBe(404);
        await enable("wedding.save_the_date.public");

        const response = await call("/save-the-date", { host: WEDDING_HOST });
        expect(response.status).toBe(200);
        expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
        const html = await response.text();
        for (const text of ["Save the date", "Are getting married!", "Saturday, 23 October 2027", "Rhino Lodge, Dubbo NSW", "Formal invitation to follow."])
            expect(html).toContain(text);
        for (const label of ["Apple Calendar", "Google Calendar", "Outlook", "Microsoft 365", "Download the calendar event (.ics)"])
            expect(html).toContain(label);
        expect(html).not.toMatch(/Fred|Sample|rsvp|invite=/i);
        // The website link appears only once the website is published.
        expect(html).not.toContain("Our wedding website");

        const ics = await call("/save-the-date.ics", { host: WEDDING_HOST });
        expect(ics.status).toBe(200);
        expect(ics.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
        expect(ics.headers.get("Content-Disposition")).toBe('attachment; filename="aidan-amelia-wedding.ics"');
        const file = await ics.text();
        expect(file.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
        // The ceremony and reception times are confirmed (15:30 to 23:30 AEDT).
        expect(file).toContain("DTSTART:20271023T043000Z");
        expect(file).toContain("DTEND:20271023T123000Z");
        expect(file).not.toMatch(/Fred|Sample|invite=|rsvp/i);

        // The path-based site serves them too.
        expect((await call("/wedding/save-the-date.ics")).status).toBe(200);
    });
});

describe("stationery email without a Save the Date card", () => {
    it("keeps the standard layout when the copy doesn't use the card", () => {
        const html = stationeryEmailHtml({
            kind: "save_the_date",
            text: "Dear Fred,\n\nSave the date!",
            coupleNames: "Aidan & Amelia",
            weddingDate: "",
            assetOrigin: SITE,
        });
        expect(html).toContain("Save the date");
        expect(html).not.toContain("ADD TO CALENDAR");
    });
});
