// Wallboard Mode: display credentials (least privilege, hashed, revocable, expiring), what a
// display may see (one wallboard, no watch-area location), the switch, the page itself, and the
// display's own token handling. Invented data only.
import { beforeEach, describe, expect, it } from "vitest";
import { tokenFromHash } from "../src/display/display-app";
import type { Wallboard, WallboardPayload, WatchArea } from "../src/shared/centre/types";
import { hashDisplayToken } from "../worker/centre/wallboard";
import { C, centreEnv, collect, enableSource, exampleWatch, fakeTransport, setFlag } from "./centre-helpers";
import { OWNER, SECOND_OWNER, apiCall, call, db, resetPortal } from "./portal-helpers";

const A = OWNER;
const B = SECOND_OWNER;

beforeEach(resetPortal);

async function setup(board: Record<string, unknown> = {}) {
    const env = await centreEnv();
    for (const id of ["rfs-incidents", "rfs-fire-danger", "bom-observations", "dea-hotspots"]) {
        await enableSource(id);
        await collect(env, id, fakeTransport(new Date()), new Date());
    }
    const watch = (await apiCall<{ watch: WatchArea }>("POST", `${C}/watches`, exampleWatch())).json.watch;
    const created = await apiCall<{ wallboard: Wallboard }>("POST", `${C}/wallboards`, { name: "Kitchen", layout: "local", watchId: watch.id, ...board });
    expect(created.status, created.text).toBe(201);
    const issued = await apiCall<{ id: string; token: string; path: string }>("POST", `${C}/wallboards/${created.json.wallboard.id}/displays`, {
        label: "Kitchen TV",
    });
    expect(issued.status, issued.text).toBe(201);
    return { env, watch, board: created.json.wallboard, token: issued.json.token, tokenId: issued.json.id, path: issued.json.path };
}

const display = (token: string | null, headers: Record<string, string> = {}) =>
    call("/api/display/wallboard", { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });

describe("Display credentials", () => {
    it("are shown once, stored only as a hash, and read only their own wallboard", async () => {
        const { token, path, board } = await setup();
        await setFlag("intelligence_centre.wallboard", true);
        expect(path).toBe(`/display#t=${token}`);
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const stored = (await db().prepare("SELECT * FROM ic_display_tokens").all()).results;
        expect(JSON.stringify(stored)).not.toContain(token);
        expect(stored[0].token_hash).toBe(await hashDisplayToken(token));
        // The wallboard list never returns a token again.
        expect((await apiCall("GET", `${C}/wallboards`)).text).not.toContain(token);
        const response = await display(token);
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        const { wallboard } = (await response.json()) as { wallboard: WallboardPayload };
        expect(wallboard.board.name).toBe(board.name);
        expect(wallboard.records.map((r) => r.title)).toContain("Example Ridge Rd, Exampleville");
    });

    it("can't reach anything else in the portal", async () => {
        const { token } = await setup();
        await setFlag("intelligence_centre.wallboard", true);
        for (const path of ["/api/portal/centre/summary", "/api/portal/centre/watches", "/api/portal/tasks/projects", "/portal/intelligence-centre"]) {
            const r = await call(path, { headers: { Authorization: `Bearer ${token}` } });
            expect([401, 403], path).toContain(r.status);
        }
    });

    it("give a display a coarse frame and the area's records, never the watch area's location or name", async () => {
        const { token, watch } = await setup();
        await setFlag("intelligence_centre.wallboard", true);
        const text = await (await display(token)).text();
        const { wallboard } = JSON.parse(text) as { wallboard: WallboardPayload };
        // Rounded outwards to 0.1° (about 10 km), 10 km beyond the area.
        expect(wallboard.frame.every((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9)).toBe(true);
        expect(wallboard.frame[0]).toBeLessThan(150.6 - 0.25);
        expect(wallboard.outline).toBeNull();
        expect(text).not.toContain(watch.id);
        expect(text).not.toContain('"Exampleville"'); // the watch area's own name
        expect(text).not.toContain("Home"); // its place name
        expect(text).not.toContain("radiusKm");
        expect(wallboard.areaLabel).toBe("Kitchen");
    });

    it("are refused, all alike, when unknown, revoked, expired, switched off, or their owner lost access", async () => {
        const { token, tokenId, board } = await setup();
        expect((await display(token)).status).toBe(404); // switch off
        await setFlag("intelligence_centre.wallboard", true);
        expect((await display(null)).status).toBe(404);
        expect((await display("x".repeat(43))).status).toBe(404);
        expect((await display(`${token}x`)).status).toBe(404);
        expect((await display(token)).status).toBe(200);
        // Revoking is immediate, and audited.
        expect((await apiCall("DELETE", `${C}/wallboards/${board.id}/displays/${tokenId}`)).status).toBe(200);
        expect((await display(token)).status).toBe(404);
        const actions = (await db().prepare("SELECT action FROM audit_log WHERE action LIKE 'centre.display%'").all<{ action: string }>()).results.map(
            (r) => r.action,
        );
        expect(actions).toEqual(["centre.display.create", "centre.display.revoke"]);
        // Expired.
        const second = (await apiCall<{ token: string; id: string }>("POST", `${C}/wallboards/${board.id}/displays`, { label: "Hall", expiresInDays: 1 })).json;
        expect((await display(second.token)).status).toBe(200);
        await db().prepare("UPDATE ic_display_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(second.id).run();
        expect((await display(second.token)).status).toBe(404);
        // Owner losing the Centre.
        const third = (await apiCall<{ token: string }>("POST", `${C}/wallboards/${board.id}/displays`, { label: "Garage" })).json;
        expect((await display(third.token)).status).toBe(200);
        // The owner is no longer an owner (and has no other role): their screens stop.
        const env = await centreEnv({ PORTAL_OWNER_EMAILS: B });
        expect((await call("/api/display/wallboard", { env, headers: { Authorization: `Bearer ${third.token}` } })).status).toBe(404);
        // Deleting the wallboard revokes everything on it.
        expect((await apiCall("DELETE", `${C}/wallboards/${board.id}`, undefined, { email: B })).status).toBe(404);
    });

    it("are rate limited per credential", async () => {
        const { token } = await setup();
        await setFlag("intelligence_centre.wallboard", true);
        const statuses: number[] = [];
        for (let i = 0; i < 32; i++) statuses.push((await display(token)).status);
        expect(statuses.filter((s) => s === 200)).toHaveLength(30);
        expect(statuses.at(-1)).toBe(429);
    });

    it("are refused from another site", async () => {
        const { token } = await setup();
        await setFlag("intelligence_centre.wallboard", true);
        expect((await display(token, { "Sec-Fetch-Site": "cross-site" })).status).toBe(404);
    });
});

describe("Wallboard profiles", () => {
    it("are their owner's own, can only use the owner's watch areas, and are limited in number", async () => {
        const { board, watch } = await setup();
        expect((await apiCall("POST", `${C}/wallboards/${board.id}/displays`, { label: "Sneaky" }, { email: B })).status).toBe(404);
        expect((await apiCall("PUT", `${C}/wallboards/${board.id}`, { name: "X", layout: "nsw", version: 1 }, { email: B })).status).toBe(404);
        // B can't point a wallboard at A's watch area.
        expect((await apiCall("POST", `${C}/wallboards`, { name: "B's", layout: "local", watchId: watch.id }, { email: B })).status).toBe(404);
        // Local Situation needs an area.
        expect((await apiCall("POST", `${C}/wallboards`, { name: "No area", layout: "local" })).status).toBe(422);
        expect((await apiCall("POST", `${C}/wallboards`, { name: "Bad", layout: "nsw", refreshSeconds: 5 })).status).toBe(422);
    });

    it("show a stored interpretation only when asked to, and never run a model", async () => {
        const { token, board } = await setup({ showInterpretation: true });
        await setFlag("intelligence_centre.wallboard", true);
        let { wallboard } = (await (await display(token)).json()) as { wallboard: WallboardPayload };
        expect(wallboard.interpretation).toMatchObject({ status: "not_requested", items: [] });
        await db()
            .prepare("INSERT INTO ic_briefings (email, scope, fingerprint, interpretation, model, generated_at) VALUES (?, ?, 'f', ?, 'm', 'now')")
            .bind(A, `watch:${board.watchId}`, JSON.stringify([{ text: "Prepared earlier.", refs: ["F1"] }]))
            .run();
        ({ wallboard } = (await (await display(token)).json()) as { wallboard: WallboardPayload });
        expect(wallboard.interpretation?.items[0].text).toBe("Prepared earlier.");
    });

    it("draw a polygon watch area's outline only when its owner opts in, rounded", async () => {
        await setup();
        await setFlag("intelligence_centre.wallboard", true);
        const poly = (
            await apiCall<{ watch: WatchArea }>("POST", `${C}/watches`, {
                name: "Block",
                definition: {
                    kind: "polygon",
                    ring: [
                        [150.512, -33.712],
                        [150.687, -33.712],
                        [150.687, -33.512],
                        [150.512, -33.712],
                    ],
                },
            })
        ).json.watch;
        const board = (
            await apiCall<{ wallboard: Wallboard }>("POST", `${C}/wallboards`, { name: "Map", layout: "map", watchId: poly.id, showWatchOutline: true })
        ).json.wallboard;
        const token = (await apiCall<{ token: string }>("POST", `${C}/wallboards/${board.id}/displays`, { label: "Map screen" })).json.token;
        const { wallboard } = (await (await display(token)).json()) as { wallboard: WallboardPayload };
        expect(wallboard.outline?.[0]).toEqual([150.51, -33.71]);
    });
});

describe("The display page", () => {
    it("is a static shell outside Access, 404 while switched off, with no referrer", async () => {
        expect((await call("/display")).status).toBe(404);
        await setFlag("intelligence_centre.wallboard", true);
        const page = await call("/display");
        expect(page.status).toBe(200);
        expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
        expect(page.headers.get("Cache-Control")).toBe("no-store");
        expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
        const html = await page.text();
        expect(html).toContain('"area":"display"');
        expect(html).not.toMatch(/icw_|owner@example\.com/);
        expect((await call("/display", { method: "POST" })).status).toBe(405);
        // Not on the wedding host.
        expect((await call("/display", { host: "wedding.daly.id.au" })).status).toBe(404);
    });

    it("reads its credential from the URL fragment only", () => {
        const token = "a".repeat(43);
        expect(tokenFromHash(`#t=${token}`)).toBe(token);
        expect(tokenFromHash(`#x=1&t=${token}`)).toBe(token);
        expect(tokenFromHash("#t=short")).toBeNull();
        expect(tokenFromHash("")).toBeNull();
        expect(tokenFromHash(`#t=${token}<script>`)).toBeNull();
    });
});
