// Invitation Studio → Communications → Fastmail → RSVP, end to end, with every provider mocked:
// specific recipient selection that never broadens, Studio drafts with duplicate protection and an
// explicit replace, the botanical invitation in the email with each household's own signed link,
// per-household PDF attachments over JMAP, provider failures, permissions, and a guest replying from
// the link in the email. Nothing is ever sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Guest, Household, Message, MessagePreflight, RsvpHousehold, WeddingEvent } from "../src/shared/portal/types";
import { buildMime } from "../worker/comms/providers";
import type { Env } from "../worker/env";
import { listStudioHouseholds } from "../worker/portal/invitation-studio";
import { ORIGIN, accessToken, apiCall, call, db, portalEnv, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);
afterEach(() => vi.restoreAllMocks());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fastmailEnv = () =>
    portalEnv({
        EMAIL_DELIVERY: "fastmail",
        FASTMAIL_API_TOKEN: "fastmail-test-token",
        EMAIL_FROM: '"Aidan & Amelia" <wedding@daly.id.au>',
        EMAIL_REPLY_TO: "wedding@daly.id.au",
    });

interface SentEmail {
    to: { email: string; name: string }[];
    subject: string;
    bodyValues: { text: { value: string }; html: { value: string } };
    attachments?: { blobId: string; type: string; name: string; disposition: string }[];
}

/** A Fastmail JMAP server: session, identity check, blob upload and submission. */
function fastmail(options: { failSubmission?: boolean; failUpload?: boolean } = {}) {
    const sent: SentEmail[] = [];
    const uploads: Uint8Array[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === "https://api.fastmail.com/jmap/session")
            return json({
                apiUrl: "https://api.fastmail.test/jmap/api/",
                uploadUrl: "https://api.fastmail.test/jmap/upload/{accountId}/",
                capabilities: { "urn:ietf:params:jmap:mail": {}, "urn:ietf:params:jmap:submission": {} },
                primaryAccounts: { "urn:ietf:params:jmap:mail": "acc-1" },
            });
        if (url.startsWith("https://api.fastmail.test/jmap/upload/acc-1/")) {
            if (options.failUpload) return json({}, 503);
            uploads.push(new Uint8Array(init!.body as ArrayBuffer));
            return json({ blobId: `blob-${uploads.length}`, type: "application/pdf", size: uploads.at(-1)!.length });
        }
        if (url === "https://api.fastmail.test/jmap/api/") {
            const body = JSON.parse(String(init!.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
            const [method, args] = body.methodCalls[0];
            if (method === "Identity/get")
                return json({
                    methodResponses: [
                        ["Identity/get", { list: [{ id: "identity-1", email: "wedding@daly.id.au", name: "Aidan & Amelia" }] }, "identities"],
                        ["Mailbox/query", { ids: ["drafts-1"] }, "drafts"],
                    ],
                });
            if (method === "Email/set") {
                if (options.failSubmission) return json({}, 500);
                const email = Object.values(args.create as Record<string, SentEmail>)[0];
                sent.push(email);
                const submission = Object.keys((body.methodCalls[1][1] as { create: Record<string, unknown> }).create)[0];
                return json({
                    methodResponses: [
                        ["Email/set", { created: { e: { id: `email-${sent.length}` } } }, "createEmail"],
                        ["EmailSubmission/set", { created: { [submission]: { id: `submission-${sent.length}` } } }, "submitEmail"],
                    ],
                });
            }
        }
        throw new Error(`Unexpected request to ${url}`);
    });
    return { sent, uploads, fetchMock };
}

/** Two fictional households invited to the ceremony, and a third with nobody invited. */
async function setup() {
    const ceremony = (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Ceremony", startsAt: "2027-10-23T14:00" })).json
        .item;
    const home = async (name: string, extra: Record<string, unknown> = {}) =>
        (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name, ...extra })).json.item;
    const guest = async (body: Record<string, unknown>) =>
        (await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", { events: [ceremony.id], ...body })).json.guest;
    const couple = await home("The Example Household");
    const fred = await guest({ firstName: "Fred", lastName: "Example", email: "fred@example.com", householdId: couple.id });
    const ann = await guest({ firstName: "Ann", lastName: "Example", householdId: couple.id });
    const family = await home("The Sample Family");
    const sam = await guest({ firstName: "Sam", lastName: "Sample", email: "sam@example.com", householdId: family.id });
    const other = await home("The Uninvited Household");
    await guest({ firstName: "Una", lastName: "Other", email: "una@example.com", householdId: other.id, events: [] });
    return { ceremony, couple, fred, ann, family, sam, other };
}

const prepareStudio = (body: Record<string, unknown>, email?: string) =>
    apiCall<{ drafts: Message[]; conflicts?: { messageId: string; others: number }[] }>(
        "POST",
        "/api/portal/wedding/invitations/prepare",
        { delivery: "household", channels: ["email"], ...body },
        email ? { email } : {},
    );

const preflight = async (id: string) => (await apiCall<{ preflight: MessagePreflight }>("GET", `/api/portal/wedding/messages/${id}/preflight`)).json.preflight;
const switchEmailOn = () => apiCall("PUT", "/api/portal/flags/communications.delivery", { enabled: true });

describe("choosing specific recipients", () => {
    it("reaches exactly the chosen household, however the filters are set, and never everyone by accident", async () => {
        const f = await setup();
        const prepare = (audience: Record<string, unknown>) =>
            apiCall<{ message: Message }>("POST", "/api/portal/wedding/messages", {
                category: "invitation",
                subject: "x",
                body: "{{invitation_card}}",
                audience,
            });
        // Filters left over from another mode can't add anyone to a specific selection.
        const one = await prepare({ mode: "specific", householdIds: [f.family.id], rsvp: ["pending", "attending"], side: ["shared"] });
        expect(one.status, one.text).toBe(201);
        const rows = await db().prepare("SELECT household_id, email, status FROM message_recipients WHERE message_id = ?").bind(one.json.message.id).all();
        expect(rows.results).toEqual([{ household_id: f.family.id, email: "sam@example.com", status: "pending" }]);

        // Choosing nobody is refused rather than meaning "all".
        expect((await prepare({ mode: "specific", householdIds: [], guestIds: [] })).status).toBe(422);

        // One guest chosen on their own: their household's invitation, to them, and nobody else.
        const plan = await apiCall<{ households: number; guests: number; recipients: { name: string; to: string }[] }>(
            "POST",
            "/api/portal/wedding/messages/plan",
            {
                audience: { mode: "specific", guestIds: [f.fred.id] },
                category: "invitation",
                channel: "email",
            },
        );
        expect(plan.json).toMatchObject({ households: 1, guests: 1, recipients: [{ name: "Fred & Ann Example", to: "fred@example.com" }] });

        // "Filtered group" ignores leftover selections; "all" is everyone eligible.
        const filtered = await apiCall<{ households: number }>("POST", "/api/portal/wedding/messages/plan", {
            audience: { mode: "filtered", householdIds: [f.family.id] },
            category: "update",
            channel: "email",
        });
        expect(filtered.json.households).toBe(3);
    });

    it("shows the actual delivery addresses before sending, and needs confirmation for more than one household", async () => {
        const f = await setup();
        const message = (
            await apiCall<{ message: Message }>("POST", "/api/portal/wedding/messages", {
                category: "invitation",
                subject: "x",
                body: "{{invitation_card}}",
                audience: { mode: "specific", householdIds: [f.couple.id, f.family.id] },
            })
        ).json.message;
        const check = await preflight(message.id);
        expect(check.sending.map((r) => [r.name, r.to])).toEqual([
            ["Fred & Ann Example", "fred@example.com"],
            ["Sam Sample", "sam@example.com"],
        ]);
        const { sent } = fastmail();
        await switchEmailOn();
        const env = await fastmailEnv();
        expect((await apiCall("POST", `/api/portal/wedding/messages/${message.id}/send`, {}, { env })).status).toBe(409);
        expect(sent).toHaveLength(0);
    });
});

describe("Invitation Studio drafts", () => {
    it("generating never sends; preparing makes one draft per channel for exactly the selected households", async () => {
        const f = await setup();
        const { sent, fetchMock } = fastmail();
        await switchEmailOn();
        const generated = await apiCall<{ sent: number }>(
            "POST",
            "/api/portal/wedding/invitations/generate",
            { householdIds: [f.couple.id], channels: ["email", "print"] },
            { env: await fastmailEnv() },
        );
        expect(generated.json.sent).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(await db().prepare("SELECT COUNT(*) AS n FROM messages").first()).toEqual({ n: 0 });

        const prepared = await prepareStudio({ householdIds: [f.couple.id], channels: ["email", "sms"], attachPdf: true });
        expect(prepared.status, prepared.text).toBe(201);
        expect(prepared.json.drafts.map((d) => [d.channel, d.status, d.category])).toEqual([
            ["email", "draft", "invitation"],
            ["sms", "draft", "invitation"],
        ]);
        const [email, sms] = prepared.json.drafts;
        expect(email.options).toMatchObject({ source: "invitation-studio", invitation: { attachPdf: true, template: { greetingPrefix: "Dear" } } });
        expect(sms.options.invitation?.attachPdf).toBe(false);
        expect(email.body).toContain("{{invitation_card}}");
        expect(sms.body).toContain("{{rsvp_link}}");
        expect(email.audience).toEqual({ mode: "specific", householdIds: [f.couple.id] });
        const households = await db().prepare("SELECT DISTINCT household_id FROM message_recipients").all();
        expect(households.results).toEqual([{ household_id: f.couple.id }]);
        expect(sent).toHaveLength(0);

        // The Studio shows each household's draft.
        const studio = await listStudioHouseholds(db());
        // Nobody in the household has a mobile, so the text draft holds it back; the email is a draft.
        expect(
            studio
                .find((h) => h.id === f.couple.id)
                ?.messages.map((m) => [m.channel, m.status])
                .sort(),
        ).toEqual([
            ["email", "draft"],
            ["sms", "skipped"],
        ]);
    });

    it("refuses duplicate drafts on regeneration, replaces only on request, and never touches sent history", async () => {
        const f = await setup();
        const first = await prepareStudio({ householdIds: [f.couple.id] });
        expect(first.status).toBe(201);
        const again = await prepareStudio({ householdIds: [f.couple.id] });
        expect(again.status).toBe(409);
        expect(again.json.conflicts).toEqual([expect.objectContaining({ messageId: first.json.drafts[0].id, others: 0 })]);
        expect(await db().prepare("SELECT COUNT(*) AS n FROM messages").first()).toEqual({ n: 1 });

        const replaced = await prepareStudio({ householdIds: [f.couple.id], replace: true });
        expect(replaced.status).toBe(201);
        expect(await db().prepare("SELECT id FROM messages").all()).toMatchObject({ results: [{ id: replaced.json.drafts[0].id }] });
        expect(await db().prepare("SELECT action, summary FROM audit_log WHERE action = 'message.delete'").first()).toMatchObject({
            summary: expect.stringContaining("Replaced the Invitation Studio email draft"),
        });

        // A draft that also covers another household is never replaced from a narrower selection.
        await prepareStudio({ householdIds: [f.couple.id, f.family.id], replace: true });
        const narrow = await prepareStudio({ householdIds: [f.couple.id], replace: true });
        expect(narrow.status).toBe(422);

        // Once sent, a household's invitation is history: a new draft holds it back rather than resending.
        const draft = (await db().prepare("SELECT id FROM messages").first<{ id: string }>())!.id;
        fastmail();
        await switchEmailOn();
        await apiCall("POST", `/api/portal/wedding/messages/${draft}/send`, { confirmCount: 2 }, { env: await fastmailEnv() });
        const after = await prepareStudio({ householdIds: [f.couple.id] });
        expect(after.status).toBe(201);
        const rows = await db()
            .prepare("SELECT status, error FROM message_recipients WHERE message_id = ? AND guest_id = ?")
            .bind(after.json.drafts[0].id, f.fred.id)
            .first();
        expect(rows).toEqual({ status: "skipped", error: "Already prepared or sent to this household" });
        expect(await db().prepare("SELECT status FROM messages WHERE id = ?").bind(draft).first()).toEqual({ status: "sent" });
    });

    it("lets editors prepare drafts but only owners and admins send them; viewers can do neither", async () => {
        const f = await setup();
        await apiCall("POST", "/api/portal/users", { email: "editor@example.com", role: "editor" });
        await apiCall("POST", "/api/portal/users", { email: "viewer@example.com", role: "viewer" });
        expect((await prepareStudio({ householdIds: [f.couple.id] }, "viewer@example.com")).status).toBe(403);
        const prepared = await prepareStudio({ householdIds: [f.couple.id] }, "editor@example.com");
        expect(prepared.status).toBe(201);
        expect((await apiCall("POST", `/api/portal/wedding/messages/${prepared.json.drafts[0].id}/send`, {}, { email: "editor@example.com" })).status).toBe(
            403,
        );
    });
});

describe("the invitation email", () => {
    it("shows the designed invitation with each household's own link, and nobody else's", async () => {
        const f = await setup();
        const draft = (await prepareStudio({ householdIds: [f.couple.id, f.family.id], attachPdf: true })).json.drafts[0];
        const { sent, uploads } = fastmail();
        await switchEmailOn();
        const env = await fastmailEnv();
        const result = await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${draft.id}/send`, { confirmCount: 2 }, { env });
        expect(result.json.message.status).toBe("sent");
        expect(sent.map((e) => e.to[0].email)).toEqual(["fred@example.com", "sam@example.com"]);

        const links = await db().prepare("SELECT id FROM households WHERE id IN (?, ?)").bind(f.couple.id, f.family.id).all();
        expect(links.results).toHaveLength(2);
        const tokenOf = (text: string) => /https:\/\/wedding\.daly\.id\.au\/rsvp\?invite=([A-Za-z0-9._~-]+)/.exec(text)?.[1];
        const [fred, sam] = sent;
        const fredToken = tokenOf(fred.bodyValues.text.value)!;
        const samToken = tokenOf(sam.bodyValues.text.value)!;
        expect(fredToken).toBeTruthy();
        expect(samToken).toBeTruthy();
        expect(fredToken).not.toBe(samToken);
        // Each email carries only its own household's link, in the button and written out in full.
        expect(fred.bodyValues.html.value).toContain(`href="https://wedding.daly.id.au/rsvp?invite=${fredToken}"`);
        expect(fred.bodyValues.html.value).toContain(`>https://wedding.daly.id.au/rsvp?invite=${fredToken}</a>`);
        expect(fred.bodyValues.html.value).not.toContain(samToken);
        expect(sam.bodyValues.html.value).not.toContain(fredToken);

        // The invitation itself: household addressing, date, venue, deadline and the RSVP button.
        const html = fred.bodyValues.html.value;
        for (const text of [
            "WITH PLEASURE, FOR",
            "Fred &amp; Ann Example",
            "SATURDAY 23 OCTOBER 2027",
            "Rhino Lodge, Dubbo NSW",
            "Ceremony - 2:00 pm",
            "Kindly reply by Saturday 25 September 2027",
            "View Invitation &amp; RSVP",
        ])
            expect(html).toContain(text);
        expect(html).toContain("/wedding/email/botanical-header.jpg");
        // Readable with images blocked: the artwork is decorative and every word is text.
        expect([...html.matchAll(/<img [^>]*alt="([^"]*)"/g)].every((m) => m[1] === "")).toBe(true);
        expect(fred.bodyValues.text.value).toContain("This invitation is for Fred & Ann Example.");
        expect(fred.subject).toBe("You're invited to Aidan & Amelia's wedding");

        // Each household's own printable invitation, uploaded and attached over JMAP.
        expect(uploads).toHaveLength(2);
        for (const upload of uploads) expect(new TextDecoder().decode(upload.slice(0, 5))).toBe("%PDF-");
        expect(fred.attachments).toEqual([
            { blobId: "blob-1", type: "application/pdf", name: "Wedding invitation - Fred & Ann Example.pdf", disposition: "attachment" },
        ]);
        expect(sam.attachments?.[0]).toMatchObject({ blobId: "blob-2", name: "Wedding invitation - Sam Sample.pdf" });
    });

    it("keeps the template it was prepared with, so later edits can't change what was previewed", async () => {
        const f = await setup();
        const draft = (await prepareStudio({ householdIds: [f.couple.id] })).json.drafts[0];
        const template = (await apiCall<{ value: Record<string, string> }>("GET", "/api/portal/settings/invitation")).json?.value;
        await apiCall("PUT", "/api/portal/settings/invitation", {
            ...(template ?? {}),
            artwork: "native-botanicals",
            accent: "burgundy",
            eyebrow: "Changed afterwards",
            invitationLine: "invite you to celebrate their marriage",
            greetingPrefix: "Dear",
            emailIntroduction: "We would love you to join us as we celebrate our wedding.",
            emailSignoff: "With love,\n{{couple_names}}",
        });
        const { sent } = fastmail();
        await switchEmailOn();
        await apiCall("POST", `/api/portal/wedding/messages/${draft.id}/send`, {}, { env: await fastmailEnv() });
        expect(sent[0].bodyValues.html.value).toContain("TOGETHER WITH THEIR FAMILIES");
        expect(sent[0].bodyValues.html.value).not.toContain("CHANGED AFTERWARDS");
    });

    it("previews the exact attachment for one household, and refuses a provider that can't attach", async () => {
        const f = await setup();
        const draft = (await prepareStudio({ householdIds: [f.couple.id], attachPdf: true })).json.drafts[0];
        const pdf = await call(`/api/portal/wedding/messages/${draft.id}/invitation.pdf?household=${f.couple.id}`, { token: await accessToken() });
        expect(pdf.status).toBe(200);
        expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
        expect(new TextDecoder().decode(new Uint8Array(await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
        // Not a recipient of this message: no PDF.
        const other = await call(`/api/portal/wedding/messages/${draft.id}/invitation.pdf?household=${f.family.id}`, { token: await accessToken() });
        expect(other.status).toBe(404);

        const send = vi.fn(async () => ({ messageId: "cf" }));
        const cloudflare = await portalEnv({ EMAIL_DELIVERY: "cloudflare", EMAIL_FROM: "wedding@daly.id.au", EMAIL: { send } as unknown as Env["EMAIL"] });
        await switchEmailOn();
        expect((await preflight(draft.id)).warnings.join(" ")).toContain("Each household's printable invitation");
        const refused = await apiCall("POST", `/api/portal/wedding/messages/${draft.id}/send`, {}, { env: cloudflare });
        expect(refused.status).toBe(422);
        expect(refused.text).toContain("can't attach the printable invitation");
        expect(send).not.toHaveBeenCalled();
    });

    it("records provider failures per household and retries only the failures", async () => {
        const f = await setup();
        const draft = (await prepareStudio({ householdIds: [f.couple.id] })).json.drafts[0];
        fastmail({ failSubmission: true });
        await switchEmailOn();
        const env = await fastmailEnv();
        const failed = await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${draft.id}/send`, {}, { env });
        expect(failed.json.message.status).toBe("failed");
        expect(await db().prepare("SELECT status, attempts FROM message_recipients WHERE guest_id = ?").bind(f.fred.id).first()).toEqual({
            status: "failed",
            attempts: 1,
        });
        vi.restoreAllMocks();
        const { sent } = fastmail();
        const retried = await apiCall<{ message: Message }>("POST", `/api/portal/wedding/messages/${draft.id}/retry`, {}, { env });
        expect(retried.json.message.status).toBe("sent");
        expect(sent).toHaveLength(1);
    });

    it("never omits a promised attachment: an upload failure fails that household instead", async () => {
        const f = await setup();
        const draft = (await prepareStudio({ householdIds: [f.couple.id], attachPdf: true })).json.drafts[0];
        const { sent } = fastmail({ failUpload: true });
        await switchEmailOn();
        await apiCall("POST", `/api/portal/wedding/messages/${draft.id}/send`, {}, { env: await fastmailEnv() });
        expect(sent).toHaveLength(0);
        expect(await db().prepare("SELECT status, error FROM message_recipients WHERE guest_id = ?").bind(f.fred.id).first()).toMatchObject({
            status: "failed",
            error: expect.stringContaining("attachment upload failed"),
        });
    });
});

describe("individual invitations", () => {
    it("preview each guest's own attachment, not the first guest's in the household", async () => {
        const f = await setup();
        await apiCall("PATCH", `/api/portal/wedding/guests/${f.ann.id}`, { email: "ann@example.com" });
        const draft = (await prepareStudio({ householdIds: [f.couple.id], delivery: "individual", attachPdf: true })).json.drafts[0];
        const check = await preflight(draft.id);
        expect(check.sending.map((r) => [r.to, r.guestId])).toEqual([
            ["ann@example.com", f.ann.id],
            ["fred@example.com", f.fred.id],
        ]);
        const pdf = async (guestId: string) =>
            new Uint8Array(
                await (
                    await call(`/api/portal/wedding/messages/${draft.id}/invitation.pdf?household=${f.couple.id}&guest=${guestId}`, {
                        token: await accessToken(),
                    })
                ).arrayBuffer(),
            );
        const [fred, ann] = [await pdf(f.fred.id), await pdf(f.ann.id)];
        expect(new TextDecoder().decode(fred.slice(0, 5))).toBe("%PDF-");
        // Each is addressed to that guest alone, with their own signed link and QR code.
        const text = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);
        expect(Buffer.compare(Buffer.from(fred), Buffer.from(ann))).not.toBe(0);
        expect(text(fred)).not.toEqual(text(ann));
        // A guest who isn't a recipient of this message gets nothing.
        const stranger = await call(`/api/portal/wedding/messages/${draft.id}/invitation.pdf?household=${f.couple.id}&guest=${f.sam.id}`, {
            token: await accessToken(),
        });
        expect(stranger.status).toBe(404);
    });
});

describe("MIME for SMTP providers", () => {
    it("wraps the text and HTML alternatives and a base64 PDF in multipart/mixed", () => {
        const mime = buildMime({
            from: '"Aidan & Amelia" <wedding@daly.id.au>',
            to: '"Fred Example" <fred@example.com>',
            replyTo: null,
            subject: "You're invited",
            text: "Plain",
            html: "<p>Rich</p>",
            attachments: [
                { filename: "Wedding invitation - Fred & Ann.pdf", contentType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.7 test") },
            ],
        });
        const mixed = /multipart\/mixed; boundary="([^"]+)"/.exec(mime)![1];
        const alternative = /multipart\/alternative; boundary="([^"]+)"/.exec(mime)![1];
        expect(mime.split(`--${mixed}`)).toHaveLength(4);
        expect(mime).toContain(`--${alternative}\r\nContent-Type: text/plain; charset=UTF-8`);
        expect(mime).toContain(`--${alternative}\r\nContent-Type: text/html; charset=UTF-8`);
        expect(mime).toContain('Content-Type: application/pdf; name="Wedding invitation - Fred & Ann.pdf"');
        expect(mime).toContain('Content-Disposition: attachment; filename="Wedding invitation - Fred & Ann.pdf"');
        expect(mime).toContain(btoa("%PDF-1.7 test"));
        expect(mime.trimEnd().endsWith(`--${mixed}--`)).toBe(true);
        // Without attachments, a plain multipart/alternative message.
        expect(buildMime({ from: "a@b.c", to: "d@e.f", replyTo: null, subject: "s", text: "t", html: "h", attachments: [] })).not.toContain("multipart/mixed");
    });
});

describe("one-household UAT, end to end", () => {
    it("sends to one chosen household only, and its guests can reply from the link in the email", async () => {
        const f = await setup();
        for (const flag of ["wedding.site.public", "rsvp.native"]) await apiCall("PUT", `/api/portal/flags/${flag}`, { enabled: true });
        const draft = (await prepareStudio({ householdIds: [f.couple.id], attachPdf: true })).json.drafts[0];
        const check = await preflight(draft.id);
        expect(check.sending).toEqual([{ name: "Fred & Ann Example", to: "fred@example.com", householdId: f.couple.id, guestId: f.fred.id }]);
        const { sent } = fastmail();
        await switchEmailOn();
        await apiCall("POST", `/api/portal/wedding/messages/${draft.id}/send`, {}, { env: await fastmailEnv() });
        expect(sent.map((e) => e.to[0].email)).toEqual(["fred@example.com"]);
        expect(await db().prepare("SELECT COUNT(*) AS n FROM message_recipients WHERE status = 'sent'").first()).toEqual({ n: 1 });
        vi.restoreAllMocks();

        const token = /rsvp\?invite=([A-Za-z0-9._~-]+)/.exec(sent[0].bodyValues.text.value)![1];
        const post = async (action: "lookup" | "submit", body: unknown) => {
            const response = await call(`/api/wedding/rsvp/${action}`, {
                method: "POST",
                headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.77" },
                body: JSON.stringify(body),
            });
            return { status: response.status, json: (await response.json()) as { household?: RsvpHousehold } };
        };
        const lookup = await post("lookup", { token });
        expect(lookup.status).toBe(200);
        expect(lookup.json.household?.guests.map((g) => `${g.firstName} ${g.lastName}`)).toEqual(["Fred Example", "Ann Example"]);
        const submitted = await post("submit", {
            token,
            clientId: "uat-submission-000000001",
            guests: [
                { guestId: f.fred.id, events: { [f.ceremony.id]: "attending" } },
                { guestId: f.ann.id, events: { [f.ceremony.id]: "declined" } },
            ],
        });
        expect(submitted.status).toBe(200);
        const statuses = await db()
            .prepare("SELECT guest_id, status FROM guest_events WHERE guest_id IN (?, ?) ORDER BY guest_id")
            .bind(f.fred.id, f.ann.id)
            .all<{ guest_id: string; status: string }>();
        expect(Object.fromEntries(statuses.results.map((r) => [r.guest_id, r.status]))).toEqual({ [f.fred.id]: "attending", [f.ann.id]: "declined" });
        // The household is now complete; nothing reached the other households.
        expect(await db().prepare("SELECT COUNT(*) AS n FROM message_recipients WHERE household_id != ?").bind(f.couple.id).first()).toEqual({ n: 0 });
    });
});
