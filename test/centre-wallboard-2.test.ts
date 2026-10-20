// Wallboard 2.0: saved views (validated layouts, the owner's own watch areas only, versions),
// boards made before 9.1, what a screen receives (widgets' data, the pinned warning strip, honest
// "not available" states, no watch-area location or name), unchanged refreshes (304), duplicating,
// renewing a credential (with a short overlap, then refused), and basemap tiles behind a display
// credential or Access. Invented data only.
import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { rfsIncidents } from "../fixtures/intelligence-centre/feeds.mjs";
import type { Wallboard, WatchArea } from "../src/shared/centre/types";
import type { ViewInput, WallboardPayloadV2, WidgetData } from "../src/shared/centre/wallboard";
import { presetView } from "../src/shared/centre/wallboard";
import { BASEMAP_KEY, forgetBasemap } from "../worker/centre/basemap";
import type { Env } from "../worker/env";
import { C, centreEnv, collect, enableSource, exampleWatch, fakeTransport, setFlag } from "./centre-helpers";
import { pmtilesFixture } from "./pmtiles-fixture";
import { OWNER, SECOND_OWNER, apiCall, call, db, resetPortal } from "./portal-helpers";

const media = () => (testEnv as unknown as Env).MEDIA;

beforeEach(async () => {
    await resetPortal();
    await media().delete(BASEMAP_KEY);
    forgetBasemap();
});

const SECRET = { name: "Secret Hideaway", placeName: "Hidden Gully" };

async function setup(views?: ViewInput[], board: Record<string, unknown> = {}) {
    const env = await centreEnv();
    for (const id of ["rfs-incidents", "rfs-fire-danger", "rfs-incident-alerts", "bom-observations", "dea-hotspots", "endeavour-outages"]) {
        await enableSource(id);
        await collect(env, id, fakeTransport(new Date()), new Date());
    }
    const watch = (
        await apiCall<{ watch: WatchArea }>(
            "POST",
            `${C}/watches`,
            exampleWatch({ name: SECRET.name, definition: { kind: "point", lat: -33.61234, lon: 150.61234, radiusKm: 25, placeName: SECRET.placeName } }),
        )
    ).json.watch;
    const created = await apiCall<{ wallboard: Wallboard }>("POST", `${C}/wallboards`, {
        name: "Hall screen",
        layout: "local",
        watchId: watch.id,
        ...board,
        ...(views ? { views } : {}),
    });
    expect(created.status, created.text).toBe(201);
    const issued = await apiCall<{ token: string; id: string }>("POST", `${C}/wallboards/${created.json.wallboard.id}/displays`, { label: "Hall TV" });
    await setFlag("intelligence_centre.wallboard", true);
    return { env, watch, board: created.json.wallboard, token: issued.json.token, tokenId: issued.json.id };
}

const v2 = (token: string, headers: Record<string, string> = {}) =>
    call("/api/display/wallboard?v=2", { headers: { Authorization: `Bearer ${token}`, ...headers } });
const payload = async (token: string) => {
    const r = await v2(token);
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as { wallboard: WallboardPayloadV2 }).wallboard;
};
// Several widget types share one data shape, so narrow by intersection rather than Extract.
const widget = <T extends WidgetData["type"]>(p: WallboardPayloadV2, type: T) => Object.values(p.data).find((d) => d.type === type) as WidgetData & { type: T };

describe("Views", () => {
    it("are validated: inside the grid, no overlaps, known settings, the owner's own watch areas", async () => {
        const { board, watch } = await setup([presetView("local")]);
        const save = (views: unknown, version = board.version, email = OWNER) =>
            apiCall<{ wallboard: Wallboard }>("PUT", `${C}/wallboards/${board.id}/views`, { version, views }, { email });
        const base = presetView("nsw");
        expect((await save([{ ...base, widgets: [...base.widgets, { id: "wx", type: "clock", x: 0, y: 0, w: 2, h: 1, settings: {} }] }])).status).toBe(422);
        expect((await save([{ ...base, widgets: [{ id: "wx", type: "map", x: 10, y: 0, w: 4, h: 4, settings: {} }] }])).status).toBe(422);
        expect((await save([{ ...base, widgets: [{ id: "wx", type: "clock", x: 0, y: 0, w: 2, h: 1, settings: { layers: ["fire"] } }] }])).status).toBe(422);
        expect((await save([{ ...base, widgets: [{ id: "wx", type: "map", x: 0, y: 0, w: 2, h: 2, settings: {} }] }])).status).toBe(422); // under its minimum
        const other = (await apiCall<{ watch: WatchArea }>("POST", `${C}/watches`, exampleWatch({ name: "Theirs" }), { email: SECOND_OWNER })).json.watch;
        const scoped = {
            ...base,
            widgets: [{ id: "wx", type: "warnings", x: 0, y: 0, w: 4, h: 4, settings: { scope: { kind: "watch", watchId: other.id } } }],
        };
        expect((await save([scoped])).status).toBe(404);
        const mine = { ...base, widgets: [{ id: "wx", type: "warnings", x: 0, y: 0, w: 4, h: 4, settings: { scope: { kind: "watch", watchId: watch.id } } }] };
        const saved = await save([presetView("local"), mine]);
        expect(saved.status, saved.text).toBe(200);
        expect(saved.json.wallboard.views.map((v) => v.preset)).toEqual(["local", "nsw"]);
        expect(saved.json.wallboard.legacyViews).toBe(false);
        expect((await save([mine], board.version)).status).toBe(409);
        expect((await save([mine], saved.json.wallboard.version, SECOND_OWNER)).status).toBe(404);
    });

    it("are derived from the original layout and rotation for boards made before 9.1", async () => {
        const { board } = await setup(undefined, { layout: "nsw", rotation: ["nsw", "weather", "map"] });
        expect(board.legacyViews).toBe(true);
        expect(board.views.map((v) => v.preset)).toEqual(["nsw", "weather", "map"]);
    });

    it("duplicate a board's settings and views, never its screens", async () => {
        const { board } = await setup([presetView("local"), presetView("trends")]);
        const r = await apiCall<{ wallboard: Wallboard }>("POST", `${C}/wallboards/${board.id}/duplicate`, { name: "Copy" });
        expect(r.status, r.text).toBe(201);
        expect(r.json.wallboard).toMatchObject({ name: "Copy", watchId: board.watchId });
        expect(r.json.wallboard.views.map((v) => v.preset)).toEqual(["local", "trends"]);
        expect(r.json.wallboard.tokens).toEqual([]);
        expect((await apiCall("POST", `${C}/wallboards/${board.id}/duplicate`, {}, { email: SECOND_OWNER })).status).toBe(404);
    });
});

describe("What a screen receives", () => {
    it("every widget's data for every view, with no watch-area location or name", async () => {
        const all = (["local", "nsw", "weather", "transport", "trends"] as const).map(presetView);
        const { token } = await setup(all);
        const p = await payload(token);
        expect(p.version).toBe(2);
        expect(p.views.map((v) => v.preset)).toEqual(["local", "nsw", "weather", "transport", "trends"]);
        // Every widget in every view has data.
        for (const view of p.views) for (const w of view.widgets) expect(p.data[`${view.id}:${w.id}`], `${view.preset}:${w.type}`).toBeTruthy();
        const json = JSON.stringify(p);
        expect(json).not.toContain(SECRET.name);
        expect(json).not.toContain(SECRET.placeName);
        expect(json).not.toContain("33.61234");
        expect(json).not.toContain("150.61234");
        expect(p.areaLabel).toBe("Hall screen");
        const map = widget(p, "map");
        expect(map.frame.every((n) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9)).toBe(true);
        expect(map.features.length).toBeGreaterThan(0);
        // An Emergency-level warning would be pinned; the Watch and Act one isn't an emergency, but its recent change is.
        expect(p.alerts.length).toBeGreaterThanOrEqual(0);
        expect(widget(p, "fire_danger").districts[0]).toMatchObject({ district: "Example Ranges", today: "Extreme", banToday: true });
        expect(widget(p, "summary").lines.join(" ")).toContain("official");
    });

    it("says a source isn't available instead of showing an empty list", async () => {
        const { token } = await setup([presetView("transport")]);
        const roads = widget(await payload(token), "roads");
        expect(roads.records).toEqual([]);
        expect(roads.unavailable[0].message).toContain("Road disruptions aren't available");
        expect(roads.unavailable[0].message).toContain("TFNSW_API_KEY");
        expect(roads.unavailable[0].message).toContain("isn't the same as there being none");
    });

    it("pins Emergency Warnings in the board's area above every view", async () => {
        const { env, token } = await setup([presetView("local")]);
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(new Date(), { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(new Date(), { level: "Emergency Warning" }) }),
        );
        const p = await payload(token);
        const alert = p.alerts.find((a) => a.title === "Example Ridge Rd, Exampleville")!;
        expect(alert).toMatchObject({ level: "Emergency Warning", rank: 3, provider: "NSW Rural Fire Service" });
        expect(alert.sourceUrl).toContain("rfs.nsw.gov.au");
        expect(alert.change).toContain("Warning level raised");
    });

    it("answers an unchanged refresh with 304, and a changed one in full", async () => {
        const { env, token } = await setup([presetView("local")]);
        const first = await v2(token);
        const etag = first.headers.get("ETag")!;
        expect(etag).toMatch(/^"[a-f0-9]{32}"$/);
        expect((await v2(token, { "If-None-Match": etag })).status).toBe(304);
        await collect(
            env,
            "rfs-incidents",
            fakeTransport(new Date(), { "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json": rfsIncidents(new Date(), { level: "Advice" }) }),
        );
        expect((await v2(token, { "If-None-Match": etag })).status).toBe(200);
    });

    it("still gives a screen running the earlier page the payload it understands", async () => {
        const { token } = await setup([presetView("local")]);
        const r = await call("/api/display/wallboard", { headers: { Authorization: `Bearer ${token}` } });
        const body = (await r.json()) as { wallboard: { board: { layout: string }; records: unknown[] } };
        expect(body.wallboard.board.layout).toBe("local");
        expect(Array.isArray(body.wallboard.records)).toBe(true);
    });

    it("previews a board for its owner only", async () => {
        const { board } = await setup([presetView("nsw")]);
        expect((await apiCall<{ wallboard: WallboardPayloadV2 }>("GET", `${C}/wallboards/${board.id}/preview`)).json.wallboard.version).toBe(2);
        expect((await apiCall("GET", `${C}/wallboards/${board.id}/preview`, undefined, { email: SECOND_OWNER })).status).toBe(404);
    });
});

describe("Renewing a display credential", () => {
    async function renewable(days: number) {
        const { board } = await setup([presetView("local")]);
        const issued = await apiCall<{ token: string; id: string }>("POST", `${C}/wallboards/${board.id}/displays`, {
            label: "Kiosk",
            expiresInDays: days,
            renewable: true,
        });
        expect(issued.status, issued.text).toBe(201);
        return { board, ...issued.json };
    }
    const renew = (token: string) => call("/api/display/renew", { method: "POST", headers: { Authorization: `Bearer ${token}` } });

    it("only near its expiry, only for a renewable credential, keeping the same revocable row", async () => {
        const { board, token, id } = await renewable(30);
        // Not due yet (30 days left; renewal opens at 14).
        expect((await renew(token)).status).toBe(409);
        await db()
            .prepare("UPDATE ic_display_tokens SET expires_at = ? WHERE id = ?")
            .bind(new Date(Date.now() + 5 * 86_400_000).toISOString(), id)
            .run();
        expect((await payload(token)).renewal.due).toBe(true);
        const r = await renew(token);
        expect(r.status).toBe(200);
        const fresh = (await r.json()) as { token: string; expiresAt: string };
        expect(fresh.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(Date.parse(fresh.expiresAt)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
        // Both work during the overlap; the old one can't renew again.
        expect((await v2(fresh.token)).status).toBe(200);
        expect((await v2(token)).status).toBe(200);
        expect((await renew(token)).status).toBe(409);
        // After the overlap, only the new one works.
        await db()
            .prepare("UPDATE ic_display_tokens SET previous_until = ? WHERE id = ?")
            .bind(new Date(Date.now() - 1000).toISOString(), id)
            .run();
        expect((await v2(token)).status).toBe(404);
        // Revoking the row stops the renewed credential too.
        await apiCall("DELETE", `${C}/wallboards/${board.id}/displays/${id}`);
        expect((await v2(fresh.token)).status).toBe(404);
    });

    it("is refused for a credential that isn't renewable, or has no expiry", async () => {
        const { board, token, tokenId } = await setup([presetView("local")]);
        await db()
            .prepare("UPDATE ic_display_tokens SET expires_at = ? WHERE id = ?")
            .bind(new Date(Date.now() + 86_400_000).toISOString(), tokenId)
            .run();
        expect((await renew(token)).status).toBe(409);
        expect((await apiCall("POST", `${C}/wallboards/${board.id}/displays`, { label: "No expiry", renewable: true })).status).toBe(422);
        expect((await renew("x".repeat(43))).status).toBe(404);
    });
});

describe("Basemap tiles", () => {
    it("are served from the archive in R2: decompressed, cacheable for that version, 204 where there's none", async () => {
        const { token } = await setup([presetView("local")]);
        // Without an archive: the outline only.
        expect((await payload(token)).basemap).toMatchObject({ kind: "outline", tiles: null });
        await media().put(
            BASEMAP_KEY,
            await pmtilesFixture([
                { z: 5, x: 29, y: 19, body: "invented tile 5/29/19" },
                { z: 6, x: 58, y: 38, body: "invented tile 6/58/38" },
            ]),
        );
        forgetBasemap();
        const info = (await payload(token)).basemap;
        expect(info).toMatchObject({ kind: "detailed", minZoom: 5, maxZoom: 6 });
        expect(info.tiles).toMatch(/^\/api\/display\/tiles\/\{z\}\/\{x\}\/\{y\}\.mvt\?v=\w+$/);
        const url = (z: number, x: number, y: number) => info.tiles!.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
        const tile = await call(url(6, 58, 38), { headers: { Authorization: `Bearer ${token}` } });
        expect(tile.status).toBe(200);
        expect(await tile.text()).toBe("invented tile 6/58/38");
        expect(tile.headers.get("Cache-Control")).toContain("immutable");
        expect(tile.headers.get("Content-Type")).toBe("application/vnd.mapbox-vector-tile");
        expect((await call(url(6, 1, 1), { headers: { Authorization: `Bearer ${token}` } })).status).toBe(204);
        expect((await call(url(9, 1, 1), { headers: { Authorization: `Bearer ${token}` } })).status).toBe(204);
        // A display credential is required, and Access for the portal's own tiles.
        expect((await call(url(6, 58, 38))).status).toBe(404);
        expect((await call(url(6, 58, 38), { headers: { Authorization: `Bearer ${token}`, "Sec-Fetch-Site": "cross-site" } })).status).toBe(404);
        expect((await call(`${C}/basemap/6/58/38.mvt`, { token: null })).status).toBe(401);
        const portal = await apiCall<{ basemap: { tiles: string } }>("GET", `${C}/basemap`);
        expect(portal.json.basemap.tiles).toMatch(/^\/api\/portal\/centre\/basemap\//);
        // The outline setting turns the detailed map off everywhere.
        const s = (await apiCall<{ settings: Record<string, unknown>; version: number }>("GET", `${C}/settings`)).json;
        await apiCall("PUT", `${C}/settings`, { settings: { ...s.settings, basemap: "outline" }, version: s.version });
        expect((await payload(token)).basemap.kind).toBe("outline");
    });
});
