import jsQR from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Guest, Household, InvitationPreview, RsvpHousehold, WeddingEvent } from "../src/shared/portal/types";
import { emailProvider } from "../worker/comms/providers";
import type { Env } from "../worker/env";
import { accessToken, apiCall, call, db, portalEnv, resetPortal } from "./portal-helpers";

const WEDDING_HOST = "wedding.daly.id.au";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(resetPortal);
afterEach(() => vi.restoreAllMocks());

async function fixture(name = "The Studio Family") {
    const event = (
        await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", {
            name: "Ceremony",
            startsAt: "2027-10-23T15:30",
            venueName: "Rhino Lodge",
        })
    ).json.item;
    const household = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name, email: "family@example.com" })).json.item;
    const guest = (
        await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", {
            firstName: "Alex",
            lastName: "Studio",
            householdId: household.id,
            events: [event.id],
            email: "alex@example.com",
        })
    ).json.guest;
    return { event, household, guest };
}

describe("wedding hostname", () => {
    it("serves only the public wedding surface and preserves legacy invitation credentials", async () => {
        await fixture();
        await apiCall("PUT", "/api/portal/flags/wedding.site.public", { enabled: true });
        const home = await call("/", { host: WEDDING_HOST });
        expect(home.status).toBe(200);
        expect(await home.text()).toContain('<link rel="canonical" href="https://wedding.daly.id.au/">');

        const rsvp = await call("/rsvp", { host: WEDDING_HOST });
        expect(rsvp.status).toBe(200);
        expect(rsvp.headers.get("X-Robots-Tag")).toBe("noindex");

        const legacy = await call("/wedding/rsvp?invite=signed.token&guest=highlight", { redirect: "manual" });
        expect(legacy.status).toBe(301);
        expect(legacy.headers.get("Location")).toBe("https://wedding.daly.id.au/rsvp?invite=signed.token&guest=highlight");

        expect((await call("/portal/wedding", { host: WEDDING_HOST })).status).toBe(404);
        expect((await call("/api/portal/wedding/guests", { host: WEDDING_HOST })).status).toBe(404);
        expect((await call("/api/comms/webhooks/clicksend/secret", { host: WEDDING_HOST })).status).toBe(404);
        const sitemap = await (await call("/sitemap.xml", { host: WEDDING_HOST })).text();
        expect(sitemap).toContain("https://wedding.daly.id.au/");
        expect(sitemap).not.toContain("/portal");
    });
});

describe("household bulk safeguards", () => {
    it("previews affected records and preserves guests and RSVP history when unassigning", async () => {
        const f = await fixture("The Preserved Family");
        await apiCall("PUT", `/api/portal/wedding/guests/${f.guest.id}/rsvp`, { eventId: f.event.id, status: "attending" });
        const preview = await apiCall<{
            preview: { households: unknown[]; guestCount: number; invitedGuests: number; confirmedResponses: number };
        }>("POST", "/api/portal/wedding/households/bulk", { action: "preview-delete", ids: [f.household.id] });
        expect(preview.json.preview).toMatchObject({ guestCount: 1, invitedGuests: 1, confirmedResponses: 1 });
        expect((await apiCall("POST", "/api/portal/wedding/households/bulk", { action: "delete", ids: [f.household.id], guests: "unassign" })).status).toBe(
            422,
        );

        expect(
            (await apiCall("POST", "/api/portal/wedding/households/bulk", { action: "delete", ids: [f.household.id], guests: "unassign", confirmed: true }))
                .status,
        ).toBe(200);
        const guest = (await apiCall<{ guest: Guest }>("GET", `/api/portal/wedding/guests/${f.guest.id}`)).json.guest;
        expect(guest.householdId).toBeNull();
        expect(await db().prepare("SELECT status FROM guest_events WHERE guest_id = ? AND event_id = ?").bind(f.guest.id, f.event.id).first()).toEqual({
            status: "attending",
        });
        expect(await db().prepare("SELECT COUNT(*) AS n FROM rsvp_submissions").first()).toEqual({ n: 0 });
    });

    it("soft-deletes and restores a household with its guests, and applies safe bulk edits", async () => {
        const f = await fixture("The Restorable Family");
        await apiCall("POST", "/api/portal/wedding/households/bulk", { action: "add-tag", ids: [f.household.id], tag: "family", confirmed: true });
        await apiCall("POST", "/api/portal/wedding/households/bulk", {
            action: "contact-preference",
            ids: [f.household.id],
            preference: "email",
            confirmed: true,
        });
        await apiCall("POST", "/api/portal/wedding/households/bulk", {
            action: "edit",
            ids: [f.household.id],
            patch: { region: "NSW", country: "Australia" },
            confirmed: true,
        });
        await apiCall("POST", "/api/portal/wedding/households/bulk", { action: "delete", ids: [f.household.id], guests: "delete", confirmed: true });
        expect((await apiCall("GET", `/api/portal/wedding/guests/${f.guest.id}`)).status).toBe(404);
        await apiCall("POST", "/api/portal/wedding/households/bulk", { action: "restore", ids: [f.household.id], restoreGuests: true, confirmed: true });
        const restored = (await apiCall<{ guest: Guest }>("GET", `/api/portal/wedding/guests/${f.guest.id}`)).json.guest;
        expect(restored.tags).toContain("family");
        expect(restored.contactPreference).toBe("email");
        expect(await db().prepare("SELECT region, country FROM households WHERE id = ?").bind(f.household.id).first()).toEqual({
            region: "NSW",
            country: "Australia",
        });
    });
});

describe("Invitation Studio", () => {
    it("builds scannable guest-specific links, generates idempotently without sending, and revokes access", async () => {
        const f = await fixture();
        await apiCall("PUT", "/api/portal/flags/wedding.site.public", { enabled: true });
        await apiCall("PUT", "/api/portal/flags/rsvp.native", { enabled: true });
        const request = { householdIds: [f.household.id], guestSpecific: true, channels: ["email", "print"] };
        const response = await apiCall<{ previews: InvitationPreview[] }>("POST", "/api/portal/wedding/invitations/preview", request);
        expect(response.status, response.text).toBe(200);
        const invitation = response.json.previews[0];
        expect(invitation.rsvpUrl).toMatch(/^https:\/\/wedding\.daly\.id\.au\/rsvp\?invite=/);
        expect(invitation.highlightedGuest).toBe("Alex Studio");
        expect(invitation.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);

        const encoded = QRCode.create(invitation.rsvpUrl, { errorCorrectionLevel: "M" });
        const quiet = 4;
        const scale = 8;
        const width = (encoded.modules.size + quiet * 2) * scale;
        const png = new PNG({ width, height: width });
        for (let y = 0; y < width; y++) {
            for (let x = 0; x < width; x++) {
                const row = Math.floor(y / scale) - quiet;
                const column = Math.floor(x / scale) - quiet;
                const dark = row >= 0 && column >= 0 && row < encoded.modules.size && column < encoded.modules.size && encoded.modules.get(row, column);
                const offset = (y * width + x) * 4;
                png.data[offset] = png.data[offset + 1] = png.data[offset + 2] = dark ? 0 : 255;
                png.data[offset + 3] = 255;
            }
        }
        expect(jsQR(new Uint8ClampedArray(png.data), width, width)?.data).toBe(invitation.rsvpUrl);

        const token = new URL(invitation.rsvpUrl).searchParams.get("invite")!;
        const lookup = await call("/api/wedding/rsvp/lookup", {
            host: WEDDING_HOST,
            method: "POST",
            headers: { Origin: `https://${WEDDING_HOST}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.50" },
            body: JSON.stringify({ token }),
        });
        expect(((await lookup.json()) as { household: RsvpHousehold }).household.highlightedGuestId).toBe(f.guest.id);

        for (let i = 0; i < 2; i++) {
            const generated = await apiCall<{ sent: number }>("POST", "/api/portal/wedding/invitations/generate", request);
            expect(generated.json.sent).toBe(0);
        }
        expect(await db().prepare("SELECT COUNT(*) AS n FROM invitation_artifacts").first()).toEqual({ n: 2 });
        expect(await db().prepare("SELECT COUNT(*) AS n FROM messages").first()).toEqual({ n: 0 });

        const pdf = await call("/api/portal/wedding/invitations/print.pdf", {
            method: "POST",
            token: await accessToken(),
            headers: { Origin: "https://daly.id.au", "Content-Type": "application/json" },
            body: JSON.stringify(request),
        });
        expect(pdf.status).toBe(200);
        expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");

        await apiCall("POST", `/api/portal/wedding/households/${f.household.id}/invitation`, { action: "revoke" });
        const revoked = await call("/api/wedding/rsvp/lookup", {
            host: WEDDING_HOST,
            method: "POST",
            headers: { Origin: `https://${WEDDING_HOST}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.51" },
            body: JSON.stringify({ token }),
        });
        expect(revoked.status).toBe(404);
    });
});

describe("provider configuration", () => {
    const fastmailEnv = (overrides: Partial<Env> = {}) =>
        portalEnv({
            EMAIL_DELIVERY: "fastmail",
            FASTMAIL_API_TOKEN: "super-secret-fastmail-token",
            EMAIL_FROM: '"Aidan & Amelia" <wedding@daly.id.au>',
            EMAIL_REPLY_TO: "wedding@daly.id.au",
            ...overrides,
        });

    it("validates a Fastmail JMAP token and sender without exposing the token", async () => {
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                json({
                    apiUrl: "https://api.fastmail.test/jmap/api/",
                    capabilities: { "urn:ietf:params:jmap:mail": {}, "urn:ietf:params:jmap:submission": {} },
                    primaryAccounts: { "urn:ietf:params:jmap:mail": "acc-1" },
                }),
            )
            .mockResolvedValueOnce(
                json({
                    methodResponses: [
                        ["Identity/get", { list: [{ id: "identity-1", email: "wedding@daly.id.au", name: "Aidan & Amelia" }] }, "identities"],
                        ["Mailbox/query", { ids: ["drafts-1"] }, "drafts"],
                    ],
                }),
            );
        const result = await apiCall<{ connected: boolean; provider: string }>(
            "POST",
            "/api/portal/wedding/providers/validate",
            { channel: "email" },
            { env: await fastmailEnv() },
        );
        expect(result).toMatchObject({ status: 200, json: { connected: true, provider: "fastmail-jmap" } });
        expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get("Authorization")).toBe("Bearer super-secret-fastmail-token");
        expect(result.text).not.toContain("super-secret-fastmail-token");
        const page = await call("/portal/wedding/communications/providers", { token: await accessToken(), env: await fastmailEnv() });
        expect(await page.text()).not.toContain("super-secret-fastmail-token");
    });

    it("returns a safe Fastmail authentication error without exposing provider details", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ detail: "super-secret-fastmail-token" }, 401));
        const result = await apiCall("POST", "/api/portal/wedding/providers/validate", { channel: "email" }, { env: await fastmailEnv() });
        expect(result).toMatchObject({
            status: 422,
            json: { error: "provider_error", provider: "Fastmail", retryable: false, message: "Fastmail: authentication failed" },
        });
        expect(result.text).not.toContain("super-secret-fastmail-token");
    });

    it("creates a Fastmail draft and submits it with the configured identity", async () => {
        const env = await fastmailEnv();
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                json({
                    apiUrl: "https://api.fastmail.test/jmap/api/",
                    capabilities: { "urn:ietf:params:jmap:mail": {}, "urn:ietf:params:jmap:submission": {} },
                    primaryAccounts: { "urn:ietf:params:jmap:mail": "acc-1" },
                }),
            )
            .mockResolvedValueOnce(
                json({
                    methodResponses: [
                        ["Identity/get", { list: [{ id: "identity-1", email: "wedding@daly.id.au", name: "Aidan & Amelia" }] }, "identities"],
                        ["Mailbox/query", { ids: ["drafts-1"] }, "drafts"],
                    ],
                }),
            )
            .mockImplementationOnce(async (_url, init) => {
                const payload = JSON.parse(String(init?.body)) as {
                    methodCalls: [string, { create: Record<string, Record<string, unknown>> }, string][];
                };
                const emailCreate = payload.methodCalls[0][1].create;
                const submissionCreate = payload.methodCalls[1][1].create;
                const emailKey = Object.keys(emailCreate)[0];
                const submissionKey = Object.keys(submissionCreate)[0];
                expect(emailCreate[emailKey]).toMatchObject({
                    mailboxIds: { "drafts-1": true },
                    keywords: { $draft: true },
                    from: [{ email: "wedding@daly.id.au", name: "Aidan & Amelia" }],
                    replyTo: [{ email: "wedding@daly.id.au" }],
                });
                expect(submissionCreate[submissionKey]).toMatchObject({ emailId: `#${emailKey}`, identityId: "identity-1" });
                return json({ methodResponses: [["EmailSubmission/set", { created: { [submissionKey]: { id: "submission-1" } } }, "submitEmail"]] });
            });

        const result = await emailProvider(env)!.send({
            to: "guest@example.com",
            toName: "Alex Guest",
            subject: "Wedding invitation",
            text: "Please join us.",
            html: "<p>Please join us.</p>",
            reference: "invitation-1",
        });
        expect(result).toEqual({ providerId: "submission-1" });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("requires an explicit confirmation and complete approved SMS configuration for tests", async () => {
        const fetchMock = vi.spyOn(globalThis, "fetch");
        const env = await portalEnv({ SMS_DELIVERY: "clicksend", CLICKSEND_USERNAME: "user", CLICKSEND_API_KEY: "key" });
        expect((await apiCall("POST", "/api/portal/wedding/providers/test", { channel: "sms", to: "+61412345678", confirm: "yes" }, { env })).status).toBe(422);
        expect(
            (await apiCall("POST", "/api/portal/wedding/providers/test", { channel: "sms", to: "+61412345678", confirm: "SEND TEST" }, { env })).status,
        ).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
