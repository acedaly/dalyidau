// Display feed (docs/INTELLIGENCE_CENTRE.md#display-feed): credentials scoped "display:<name>" read
// /api/display/feed and nothing else; wallboard credentials keep reading only their wallboard.
// Distinct refusals (401 credential, 403 scope), the switch, the rate limit, and a payload that
// never carries the watch area's name or location. Invented data only.
import { beforeEach, describe, expect, it } from "vitest";
import type { DisplayFeed, Wallboard, WatchArea } from "../src/shared/centre/types";
import { FEED_RATE } from "../worker/centre/display-feed";
import { C, centreEnv, collect, enableSource, exampleWatch, fakeTransport, setFlag } from "./centre-helpers";
import { apiCall, call, db, resetPortal } from "./portal-helpers";

beforeEach(resetPortal);

// A watch area whose name and place can't coincide with any provider record's text.
const privateWatch = () =>
    exampleWatch({ name: "Zzq Private Watch", definition: { kind: "point", lat: -33.6123, lon: 150.6789, radiusKm: 25, placeName: "Zzq Place" } });

async function setup({ watch = true }: { watch?: boolean } = {}) {
    const env = await centreEnv();
    for (const id of ["rfs-incidents", "rfs-fire-danger"]) {
        await enableSource(id);
        await collect(env, id, fakeTransport(new Date()), new Date());
    }
    const area = watch ? (await apiCall<{ watch: WatchArea }>("POST", `${C}/watches`, privateWatch())).json.watch : null;
    const created = await apiCall<{ wallboard: Wallboard }>("POST", `${C}/wallboards`, {
        name: "Hall",
        layout: area ? "local" : "nsw",
        ...(area ? { watchId: area.id } : {}),
    });
    expect(created.status, created.text).toBe(201);
    const boardId = created.json.wallboard.id;
    const mint = async (body: Record<string, unknown>) => {
        const r = await apiCall<{ id: string; token: string; path: string; scope: string }>("POST", `${C}/wallboards/${boardId}/displays`, body);
        expect(r.status, r.text).toBe(201);
        return r.json;
    };
    const feedCred = await mint({ label: "Daly Display", scope: "display:daly-display" });
    const wallCred = await mint({ label: "Kitchen TV" });
    return { env, area, boardId, feedCred, wallCred };
}

const feed = (token: string | null, query = "") => call(`/api/display/feed${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe("Display feed credentials", () => {
    it("is off until its switch is on", async () => {
        const { feedCred } = await setup();
        expect((await feed(feedCred.token)).status).toBe(404);
    });

    it("refuses a missing, malformed or unknown credential with 401", async () => {
        await setup();
        await setFlag("intelligence_centre.display_feed", true);
        const none = await feed(null);
        expect(none.status).toBe(401);
        expect(none.headers.get("WWW-Authenticate")).toContain("Bearer");
        expect((await feed("not-a-token")).status).toBe(401);
        expect((await feed("A".repeat(43))).status).toBe(401);
    });

    it("refuses a revoked or expired credential with 401", async () => {
        const { boardId, feedCred } = await setup();
        await setFlag("intelligence_centre.display_feed", true);
        expect((await feed(feedCred.token)).status).toBe(200);
        await db().prepare("UPDATE ic_display_tokens SET expires_at = ? WHERE id = ?").bind("2000-01-01T00:00:00.000Z", feedCred.id).run();
        expect((await feed(feedCred.token)).status).toBe(401);
        await db().prepare("UPDATE ic_display_tokens SET expires_at = NULL WHERE id = ?").bind(feedCred.id).run();
        expect((await apiCall("DELETE", `${C}/wallboards/${boardId}/displays/${feedCred.id}`)).status).toBe(200);
        expect((await feed(feedCred.token)).status).toBe(401);
    });

    it("refuses a wallboard credential with 403, and a feed credential can't read a wallboard", async () => {
        const { feedCred, wallCred } = await setup();
        await setFlag("intelligence_centre.display_feed", true);
        await setFlag("intelligence_centre.wallboard", true);
        expect((await feed(wallCred.token)).status).toBe(403);
        // Existing wallboard credentials keep working unchanged.
        expect((await call("/api/display/wallboard", { headers: { Authorization: `Bearer ${wallCred.token}` } })).status).toBe(200);
        expect((await call("/api/display/wallboard", { headers: { Authorization: `Bearer ${feedCred.token}` } })).status).toBe(404);
        expect((await call("/api/display/renew", { method: "POST", headers: { Authorization: `Bearer ${feedCred.token}` } })).status).toBe(404);
        for (const path of ["/api/portal/centre/summary", "/api/portal/centre/watches"]) {
            const r = await call(path, { headers: { Authorization: `Bearer ${feedCred.token}` } });
            expect([401, 403], path).toContain(r.status);
        }
    });

    it("validates the scope when minting", async () => {
        const { boardId } = await setup();
        for (const scope of ["display:", "display:Bad Name", "admin", "display:" + "a".repeat(33)]) {
            const r = await apiCall("POST", `${C}/wallboards/${boardId}/displays`, { label: "X", scope });
            expect(r.status, scope).toBe(422);
        }
        const renewing = await apiCall("POST", `${C}/wallboards/${boardId}/displays`, { label: "X", scope: "display:x", expiresInDays: 30, renewable: true });
        expect(renewing.status).toBe(422);
        const listed = (await apiCall<{ wallboards: Wallboard[] }>("GET", `${C}/wallboards`)).json.wallboards[0].tokens.map((t) => t.scope).sort();
        expect(listed).toEqual(["display:daly-display", "wallboard"]);
    });

    it("stores only the credential's hash", async () => {
        const { feedCred } = await setup();
        expect(feedCred.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(feedCred.path).toBe("/api/display/feed");
        const stored = JSON.stringify((await db().prepare("SELECT * FROM ic_display_tokens").all()).results);
        expect(stored).not.toContain(feedCred.token);
    });
});

describe("Display feed payload", () => {
    it("has holidays, school dates, warnings and fire danger, and caches for a minute", async () => {
        const { feedCred } = await setup();
        await setFlag("intelligence_centre.display_feed", true);
        const r = await feed(feedCred.token, "?school=western");
        expect(r.status).toBe(200);
        expect(r.headers.get("Cache-Control")).toBe("private, max-age=60");
        const { feed: body } = (await r.json()) as { feed: DisplayFeed };
        expect(Date.parse(body.generatedAt)).not.toBeNaN();
        expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(body.holidays.division).toBe("western");
        expect(Array.isArray(body.holidays.public)).toBe(true);
        for (const h of body.holidays.public) expect(h.date >= body.today).toBe(true);
        expect(body.holidays.school.every((s) => ["term", "holidays", "development_day"].includes(s.kind))).toBe(true);
        expect(typeof body.holidays.schoolHolidayToday).toBe("boolean");
        expect(Array.isArray(body.warnings)).toBe(true);
        for (const w of body.warnings) expect(Object.keys(w).sort()).toEqual(["category", "id", "level", "provider", "title", "updatedAt"]);
        expect(body.fireDanger.length).toBeGreaterThan(0);
        for (const f of body.fireDanger) {
            expect(typeof f.district).toBe("string");
            expect(typeof f.banToday).toBe("boolean");
        }
    });

    it("never carries the watch area's name or location", async () => {
        const { feedCred } = await setup();
        await setFlag("intelligence_centre.display_feed", true);
        const text = await (await feed(feedCred.token)).text();
        const watch = privateWatch();
        expect(text).not.toContain(watch.name);
        expect(text).not.toContain(String(watch.definition.lat));
        expect(text).not.toContain(String(watch.definition.lon));
        expect(text).not.toContain(watch.definition.placeName);
    });

    it("has no warnings or ratings for a board without a watch area", async () => {
        const { feedCred } = await setup({ watch: false });
        await setFlag("intelligence_centre.display_feed", true);
        const { feed: body } = (await (await feed(feedCred.token)).json()) as { feed: DisplayFeed };
        expect(body.warnings).toEqual([]);
        expect(body.fireDanger).toEqual([]);
        expect(body.holidays.division).toBe("eastern");
    });

    it("is rate limited per credential", async () => {
        const { feedCred } = await setup();
        await setFlag("intelligence_centre.display_feed", true);
        for (let i = 0; i < FEED_RATE.limit; i++) expect((await feed(feedCred.token)).status).toBe(200);
        expect((await feed(feedCred.token)).status).toBe(429);
    });
});
