// Security regression tests from docs/WEDDING_SECURITY_REVIEW.md: the private portal fails closed
// for everyone without a role, signed invitation links open exactly one household, credentials never
// reach viewers, logs or public pages, webhooks need their secret, and bodies are size-limited while
// they stream. Every provider is mocked: nothing is ever sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Guest, Household, RsvpHousehold, WeddingEvent } from "../src/shared/portal/types";
import apiSource from "../worker/portal/api.ts?raw";
import { hideCredentials } from "../worker/portal/redact";
import { invitationToken } from "../worker/wedding/invitations";
import { accessToken, apiCall, call, db, portalEnv, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);
afterEach(() => vi.restoreAllMocks());

const WEDDING_HOST = "wedding.daly.id.au";
const SECRET = "webhook-secret-0123456789abcdef";
const LINK_SECRET = "test-rsvp-link-secret-that-is-at-least-32-bytes";

const enable = (...flags: string[]) => Promise.all(flags.map((flag) => apiCall("PUT", `/api/portal/flags/${flag}`, { enabled: true })));

/** Two households, each invited to the ceremony, each with a distinctive name, email, mobile and dietary note. */
async function households() {
    const event = (await apiCall<{ item: WeddingEvent }>("POST", "/api/portal/wedding/events", { name: "Ceremony", startsAt: "2027-10-23T15:30" })).json.item;
    const make = async (surname: string, email: string, phone: string) => {
        const household = (await apiCall<{ item: Household }>("POST", "/api/portal/wedding/households", { name: surname })).json.item;
        const guest = (
            await apiCall<{ guest: Guest }>("POST", "/api/portal/wedding/guests", {
                firstName: "Quill",
                lastName: surname,
                email,
                phone,
                dietary: `${surname} dietary note`,
                householdId: household.id,
                events: [event.id],
            })
        ).json.guest;
        const link = (
            await apiCall<{ body: string }>("POST", "/api/portal/wedding/messages/preview", {
                category: "invitation",
                channel: "email",
                subject: "x",
                body: "{{rsvp_link}}",
                householdId: household.id,
            })
        ).json.body.trim();
        return { household, guest, link, token: new URL(link).searchParams.get("invite")! };
    };
    return {
        event,
        a: await make("Zephyrine", "zephyrine@example.com", "0412 000 101"),
        b: await make("Marrowby", "marrowby@example.com", "0412 000 202"),
    };
}

const rsvp = (action: "lookup" | "submit", body: unknown, init: RequestInit = {}) =>
    call(`/api/wedding/rsvp/${action}`, {
        host: WEDDING_HOST,
        method: "POST",
        headers: { Origin: `https://${WEDDING_HOST}`, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.77" },
        body: JSON.stringify(body),
        ...init,
    });

/** Every route the portal API declares, with its path parameters filled in. */
const portalRoutes = () =>
    [...apiSource.matchAll(/\badd\(\s*"(GET|POST|PUT|PATCH|DELETE)",\s*"(\/api\/portal\/[^"]+)"/g)].map(([, method, path]) => ({
        method,
        path: path
            .replace(/:collection/g, "events")
            .replace(/:key/g, "wedding")
            .replace(/:[a-zA-Z]+/g, "x"),
    }));

describe("the private portal", () => {
    it("refuses every API route to anonymous visitors and to signed-in people without a role", async () => {
        const routes = portalRoutes();
        expect(routes.length).toBeGreaterThan(80);
        const stranger = await accessToken({ email: "stranger@example.com" });
        for (const { method, path } of routes) {
            const init: RequestInit = {
                method,
                headers: method === "GET" ? {} : ({ Origin: "https://daly.id.au", "Content-Type": "application/json" } as Record<string, string>),
                body: method === "GET" ? undefined : "{}",
            };
            const anonymous = await call(path, init);
            expect(anonymous.status, `${method} ${path}`).toBe(401);
            expect(await anonymous.json()).toEqual({ error: "unauthenticated" });
            expect((await call(path, { ...init, token: stranger })).status, `${method} ${path} (no role)`).toBe(403);
        }
        // Self-signed test tokens only work in automated tests and local development, never on a deployed Worker.
        for (const ENVIRONMENT of ["staging", "production"])
            expect([401, 403], ENVIRONMENT).toContain(
                (await call("/api/portal/me", { token: await accessToken(), env: await portalEnv({ ENVIRONMENT }) })).status,
            );
        // A forged Access token signed with someone else's key is refused too.
        expect((await call("/api/portal/wedding/guests", { token: await accessToken({ key: "other" }) })).status).toBe(403);
        // Portal pages and private PDFs and exports behave the same.
        for (const path of ["/portal", "/portal/wedding/guests", "/api/portal/export/all.json", "/api/portal/wedding/messages/x/invitation.pdf"])
            expect((await call(path)).status, path).toBe(401);
    });

    it("never gives a viewer RSVP codes or signed links, in API responses or page data", async () => {
        const f = await households();
        await apiCall("POST", "/api/portal/users", { email: "viewer@example.com", role: "viewer" });
        const as = { email: "viewer@example.com" };
        const codes = (await db().prepare("SELECT rsvp_code FROM households").all<{ rsvp_code: string }>()).results.map((r) => r.rsvp_code);
        const leaks = (text: string) => codes.some((code) => text.includes(code)) || text.includes(f.a.token) || text.includes(f.b.token);

        for (const path of [
            "/api/portal/wedding/households",
            "/api/portal/wedding/households/overview",
            "/api/portal/wedding/guests",
            "/api/portal/wedding/messages",
        ]) {
            const response = await apiCall("GET", path, undefined, as);
            expect(response.status, path).toBe(200);
            expect(leaks(response.text), path).toBe(false);
        }
        const page = await call("/portal/wedding/invitations", { token: await accessToken(as) });
        expect(leaks(await page.text())).toBe(false);
        // The tools that build whole invitations or messages are for those who prepare them.
        expect((await apiCall("POST", "/api/portal/wedding/invitations/preview", { householdIds: [f.a.household.id] }, as)).status).toBe(403);
        expect(
            (
                await apiCall(
                    "POST",
                    "/api/portal/wedding/messages/preview",
                    { category: "invitation", channel: "email", subject: "x", body: "{{rsvp_link}}" },
                    as,
                )
            ).status,
        ).toBe(403);
        // Downloads stay behind the export permission.
        expect((await apiCall("GET", "/api/portal/export/households.csv", undefined, as)).status).toBe(403);
        // The owner still sees them, and the redaction itself leaves other values alone.
        expect(leaks((await apiCall("GET", "/api/portal/wedding/households")).text)).toBe(true);
        expect(hideCredentials({ rsvpCode: "ABCD2345", note: "see https://x.example/rsvp?invite=abc.1.def&x=1", count: 2 })).toEqual({
            rsvpCode: null,
            note: "see https://x.example/rsvp?invite=[hidden]&x=1",
            count: 2,
        });
    });
});

describe("signed invitation links", () => {
    it("open exactly one household, and refuse anything outside it", async () => {
        const f = await households();
        await enable("wedding.site.public", "rsvp.native");
        const lookup = await rsvp("lookup", { token: f.a.token });
        expect(lookup.status).toBe(200);
        const text = await lookup.text();
        expect(text).toContain("Zephyrine");
        // Nothing about the other household, and no contact details or codes at all.
        for (const absent of ["Marrowby", "zephyrine@example.com", "0412", "rsvpCode", f.b.household.id]) expect(text).not.toContain(absent);
        const household = (JSON.parse(text) as { household: RsvpHousehold }).household;

        // Answering for the other household's guest, or an event this one isn't invited to, is refused.
        const before = await db().prepare("SELECT status FROM guest_events WHERE guest_id = ?").bind(f.b.guest.id).first();
        for (const guests of [
            [{ guestId: f.b.guest.id, events: { [f.event.id]: "declined" } }],
            [
                { guestId: f.a.guest.id, events: { [f.event.id]: "attending" } },
                { guestId: f.b.guest.id, events: { [f.event.id]: "declined" } },
            ],
            [{ guestId: f.a.guest.id, events: { [f.event.id]: "attending", evt_other: "attending" } }],
        ]) {
            const response = await rsvp("submit", { token: f.a.token, guests });
            expect(response.status).toBe(400);
        }
        expect(await db().prepare("SELECT status FROM guest_events WHERE guest_id = ?").bind(f.b.guest.id).first()).toEqual(before);
        expect(household.guests.map((g) => g.id)).toEqual([f.a.guest.id]);
    });

    it("can't be forged, altered, re-pointed or reused once revoked or replaced", async () => {
        const f = await households();
        await enable("wedding.site.public", "rsvp.native");
        const [payloadA, , signature] = [f.a.token.split(".")[0], f.a.token.split(".")[1], f.a.token.split(".").pop()!];
        const payloadB = f.b.token.split(".")[0];
        const refused = async (token: string) => {
            const response = await rsvp("lookup", { token });
            expect(response.status, token).toBe(404);
            expect(await response.text()).not.toMatch(/Zephyrine|Marrowby/);
        };
        // The other household's id with this household's signature.
        await refused(`${payloadB}.1.${signature}`);
        // A different version, a flipped signature character, a truncated token.
        await refused(`${payloadA}.2.${signature}`);
        await refused(`${f.a.token.slice(0, -1)}${f.a.token.endsWith("A") ? "B" : "A"}`);
        await refused(f.a.token.slice(0, -5));
        // Signed with another secret.
        await refused(await invitationToken("another-secret-that-is-also-at-least-32-bytes", f.a.household.id, 1));
        // A household id alone is never accepted.
        expect((await rsvp("lookup", { householdId: f.a.household.id })).status).toBe(404);

        // Revoke, then rotate: the old link stops working each time.
        await apiCall("POST", `/api/portal/wedding/households/${f.a.household.id}/invitation`, { action: "revoke" });
        await refused(f.a.token);
        expect((await call(`/invitation?invite=${f.a.token}`, { host: WEDDING_HOST })).status).toBe(404);
        expect((await call(`/invitation.pdf?invite=${f.a.token}`, { host: WEDDING_HOST })).status).toBe(404);
        await apiCall("POST", `/api/portal/wedding/households/${f.a.household.id}/invitation`, { action: "rotate" });
        await refused(f.a.token);
        const fresh = await invitationToken(
            LINK_SECRET,
            f.a.household.id,
            (await db().prepare("SELECT invite_version AS v FROM households WHERE id = ?").bind(f.a.household.id).first<{ v: number }>())!.v,
        );
        expect((await rsvp("lookup", { token: fresh })).status).toBe(200);
    });

    it("keep the RSVP page and the invitation pages out of caches, search engines and referrers", async () => {
        const f = await households();
        await enable("wedding.site.public", "rsvp.native");
        for (const path of [`/rsvp?invite=${f.a.token}`, `/invitation?invite=${f.a.token}`]) {
            const response = await call(path, { host: WEDDING_HOST });
            expect(response.status, path).toBe(200);
            expect(response.headers.get("Cache-Control"), path).toBe("no-store");
            expect(response.headers.get("Referrer-Policy"), path).toBe("no-referrer");
            expect(response.headers.get("X-Robots-Tag"), path).toContain("noindex");
            expect(await response.text(), path).toContain('<meta name="referrer" content="no-referrer">');
        }
        // Old links on the main site redirect without being cached or passed on.
        const legacy = await call(`/wedding/rsvp?invite=${f.a.token}`);
        expect(legacy.status).toBe(301);
        expect(legacy.headers.get("Location")).toBe(`https://${WEDDING_HOST}/rsvp?invite=${f.a.token}`);
        expect(legacy.headers.get("Cache-Control")).toBe("no-store");
        expect(legacy.headers.get("Referrer-Policy")).toBe("no-referrer");
        const pdf = await call(`/invitation.pdf?invite=${f.a.token}`, { host: WEDDING_HOST });
        expect(pdf.headers.get("Cache-Control")).toBe("no-store");
        expect(pdf.headers.get("Referrer-Policy")).toBe("no-referrer");
        // Without a link there's no PDF, and the household's portal PDF needs a portal sign-in.
        expect((await call("/invitation.pdf", { host: WEDDING_HOST })).status).toBe(404);
    });
});

describe("public pages and files", () => {
    it("never carry the guest list, contact details, codes or signed links", async () => {
        await households();
        await enable("wedding.site.public", "wedding.save_the_date.public");
        const codes = (await db().prepare("SELECT rsvp_code FROM households").all<{ rsvp_code: string }>()).results.map((r) => r.rsvp_code);
        for (const path of ["/", "/rsvp", "/save-the-date", "/save-the-date.ics", "/invitation", "/sitemap.xml", "/robots.txt"]) {
            const text = await (await call(path, { host: WEDDING_HOST })).text();
            for (const absent of ["Zephyrine", "Marrowby", "@example.com", "0412", "dietary", "invite=", ...codes])
                expect(text, `${path}: ${absent}`).not.toContain(absent);
        }
        // The RSVP API says nothing without a valid credential.
        const nothing = await rsvp("lookup", {});
        expect(nothing.status).toBe(404);
        expect(await nothing.text()).not.toMatch(/Zephyrine|Marrowby/);
    });
});

describe("rate limits", () => {
    it("limit how often one visitor can build invitation PDFs", async () => {
        const f = await households();
        await enable("wedding.site.public");
        const pdf = () => call(`/invitation.pdf?invite=not-a-link`, { host: WEDDING_HOST, headers: { "CF-Connecting-IP": "203.0.113.9" } });
        for (let i = 0; i < 20; i++) expect((await pdf()).status).toBe(404);
        const limited = await pdf();
        expect(limited.status).toBe(429);
        expect(limited.headers.get("Retry-After")).toBe("600");
        // Another visitor is unaffected.
        const other = await call(`/invitation.pdf?invite=${f.a.token}`, { host: WEDDING_HOST, headers: { "CF-Connecting-IP": "203.0.113.10" } });
        expect(other.status).toBe(200);
    });
});

describe("request size limits", () => {
    it("refuse oversized bodies, including streamed ones without a Content-Length", async () => {
        await enable("wedding.site.public", "rsvp.native");
        const chunk = new TextEncoder().encode(" ".repeat(16_384));
        const stream = () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    for (let i = 0; i < 8; i++) controller.enqueue(chunk);
                    controller.close();
                },
            });
        const streamed = await rsvp("lookup", undefined, { body: stream(), duplex: "half" } as RequestInit);
        expect(streamed.status).toBe(413);
        const declared = await rsvp("lookup", undefined, { body: "x".repeat(60_000) });
        expect(declared.status).toBe(413);
        const webhook = await call(`/api/comms/webhooks/clicksend-inbound?key=${SECRET}`, {
            method: "POST",
            env: await portalEnv({ COMMS_WEBHOOK_SECRET: SECRET }),
            body: stream(),
            duplex: "half",
        } as RequestInit & { env: Awaited<ReturnType<typeof portalEnv>> });
        expect(webhook.status).toBe(400);
    });
});

describe("provider webhooks", () => {
    const env = () => portalEnv({ COMMS_WEBHOOK_SECRET: SECRET, SMS_DELIVERY: "clicksend", CLICKSEND_USERNAME: "u", CLICKSEND_API_KEY: "k" });
    const inbound = async (path: string) =>
        call(path, {
            method: "POST",
            env: await env(),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: "+61412000101", body: "Hello", message_id: `m-${Math.random()}` }),
        });
    const stored = async () => (await db().prepare("SELECT COUNT(*) AS n FROM comm_webhook_events").first<{ n: number }>())!.n;

    it("refuse a wrong or missing secret without storing anything, and accept the secret in the query string", async () => {
        for (const path of [
            "/api/comms/webhooks/clicksend-inbound",
            "/api/comms/webhooks/clicksend-inbound?key=wrong-secret",
            "/api/comms/webhooks/clicksend-inbound/wrong-secret",
            `/api/comms/webhooks/unknown?key=${SECRET}`,
        ])
            expect((await inbound(path)).status, path).toBe(404);
        expect(await stored()).toBe(0);
        expect((await inbound(`/api/comms/webhooks/clicksend-inbound?key=${SECRET}`)).status).toBe(200);
        // The older form, with the secret as the last path segment, still works for existing settings.
        expect((await inbound(`/api/comms/webhooks/clicksend-inbound/${SECRET}`)).status).toBe(200);
        expect(await stored()).toBe(2);
        // Not reachable on the wedding host at all.
        expect((await call(`/api/comms/webhooks/clicksend-inbound?key=${SECRET}`, { host: WEDDING_HOST, method: "POST" })).status).toBe(404);
    });
});

describe("telemetry", () => {
    it("never records signed links or the webhook secret in the Worker's own logs", async () => {
        const f = await households();
        await enable("wedding.site.public", "rsvp.native");
        const lines: string[] = [];
        for (const method of ["log", "error", "warn", "info"] as const)
            vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
        // A webhook whose handling fails, an unauthenticated portal call, and the guest journey.
        vi.spyOn(db(), "prepare");
        const failing = await portalEnv({
            COMMS_WEBHOOK_SECRET: SECRET,
            DB: {
                prepare: () => {
                    throw new Error("database unavailable");
                },
            } as never,
        });
        expect((await call(`/api/comms/webhooks/clicksend-inbound/${SECRET}`, { method: "POST", env: failing, body: "{}" })).status).toBe(500);
        await call(`/api/portal/wedding/guests?invite=${f.a.token}`);
        await call(`/invitation?invite=${f.a.token}`, { host: WEDDING_HOST });
        await call(`/rsvp?invite=${f.a.token}`, { host: WEDDING_HOST });
        await rsvp("lookup", { token: f.a.token });
        await rsvp("submit", { token: f.a.token, guests: [{ guestId: f.a.guest.id, events: { [f.event.id]: "attending" } }] });
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            expect(line).not.toContain(f.a.token);
            expect(line).not.toContain(SECRET);
            expect(line).not.toContain("zephyrine@example.com");
        }
    });
});
