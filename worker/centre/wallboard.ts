// Wallboard Mode (docs/INTELLIGENCE_CENTRE.md#wallboard-mode): a full-screen, read-only view for a
// monitor, television or kiosk, reusing the Centre's records, watch areas and map.
//
// A display signs in with a display credential, not a person's Cloudflare Access identity. Each
// credential reads exactly one wallboard and nothing else in the portal. It is 256 random bits, is
// shown once, and only its SHA-256 is stored; it can expire and is revoked instantly. The page
// keeps it in the URL fragment (/display#t=…), which browsers never send to a server, and passes it
// in an Authorization header, so it never appears in logs or Referer headers.
//
// Every request re-checks the wallboard's owner as they are now (still allowed to open the
// Centre). The payload carries the board's records and a frame rounded outwards to 0.1° (about
// 10 km), never the watch area's own coordinates or name; drawing the watch outline is a separate
// opt-in. A display never runs a model: it can only show an interpretation the owner already
// generated.
import type { D1Database } from "@cloudflare/workers-types";
import type { CentreChange, CentreRecord, DisplayToken, MapLayer, Wallboard, WallboardInput, WallboardPayload } from "../../src/shared/centre/types";
import { wallboardInputSchema } from "../../src/shared/centre/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can, userForEmail } from "../portal/auth";
import { auditStatement, newId, nowIso, parseJson } from "../portal/db";
import { isEnabled } from "../portal/flags";
import { HttpError } from "../portal/http";
import { allow } from "../wedding/rsvp";
import { type BBox, NSW_BBOX, coarseBBox, expandBBox } from "./geo";
import { mapFeatures } from "./map";
import { listChanges, listRecords, loadCentreSettings, loadPreferences, sourceHealth } from "./store";
import { recordsForWatch, requireWatch, watchBBox } from "./watch";

export const MAX_WALLBOARDS = 10;
export const MAX_TOKENS_PER_BOARD = 5;

const b64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

export async function hashDisplayToken(token: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`daly-centre-display-token:${token}`));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface BoardRow {
    id: string;
    email: string;
    name: string;
    config: string;
    version: number;
    created_at: string;
    updated_at: string;
}

interface TokenRow {
    id: string;
    wallboard_id: string;
    label: string;
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    last_used_at: string | null;
}

const toToken = (t: TokenRow): DisplayToken => ({
    id: t.id,
    label: t.label,
    createdAt: t.created_at,
    expiresAt: t.expires_at,
    revokedAt: t.revoked_at,
    lastUsedAt: t.last_used_at,
});

function toBoard(row: BoardRow, tokens: TokenRow[]): Wallboard {
    const config = wallboardInputSchema.safeParse({ ...parseJson<object>(row.config, {}), name: row.name });
    const base = config.success ? config.data : wallboardInputSchema.parse({ name: row.name, layout: "nsw" });
    return { ...base, id: row.id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, tokens: tokens.map(toToken) };
}

export async function listWallboards(db: D1Database, email: string): Promise<Wallboard[]> {
    const boards = await db.prepare("SELECT * FROM ic_wallboards WHERE email = ? ORDER BY name COLLATE NOCASE").bind(email).all<BoardRow>();
    if (!boards.results.length) return [];
    const tokens = await db
        .prepare(
            `SELECT id, wallboard_id, label, created_at, expires_at, revoked_at, last_used_at FROM ic_display_tokens WHERE wallboard_id IN (${boards.results.map(() => "?").join(",")}) ORDER BY created_at DESC`,
        )
        .bind(...boards.results.map((b) => b.id))
        .all<TokenRow>();
    return boards.results.map((b) =>
        toBoard(
            b,
            tokens.results.filter((t) => t.wallboard_id === b.id),
        ),
    );
}

export async function requireWallboard(db: D1Database, email: string, id: string): Promise<Wallboard> {
    if (!/^icb_[a-z0-9]{14}$/.test(id)) throw new HttpError(404, "not_found", "Not found");
    const row = await db.prepare("SELECT * FROM ic_wallboards WHERE id = ? AND email = ?").bind(id, email).first<BoardRow>();
    if (!row) throw new HttpError(404, "not_found", "Not found");
    const tokens = await db
        .prepare(
            "SELECT id, wallboard_id, label, created_at, expires_at, revoked_at, last_used_at FROM ic_display_tokens WHERE wallboard_id = ? ORDER BY created_at DESC",
        )
        .bind(id)
        .all<TokenRow>();
    return toBoard(row, tokens.results);
}

async function checkInput(db: D1Database, user: PortalUser, body: unknown): Promise<WallboardInput> {
    const input = wallboardInputSchema.parse(body);
    // Only the owner's own watch area (404 for anyone else's, as everywhere).
    if (input.watchId) await requireWatch(db, user.email, input.watchId);
    if (input.layout === "local" && !input.watchId) throw new HttpError(422, "validation", "Local Situation needs a watch area");
    return input;
}

const configJson = (input: WallboardInput) => {
    const { name: _name, ...config } = input;
    return JSON.stringify(config);
};

export async function createWallboard(db: D1Database, user: PortalUser, body: unknown) {
    const input = await checkInput(db, user, body);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM ic_wallboards WHERE email = ?").bind(user.email).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_WALLBOARDS) throw new HttpError(422, "validation", `You can have up to ${MAX_WALLBOARDS} wallboards`);
    const id = newId("icb");
    const now = nowIso();
    await db.batch([
        db
            .prepare("INSERT INTO ic_wallboards (id, email, name, config, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
            .bind(id, user.email, input.name, configJson(input), now, now),
        auditStatement(db, {
            actor: user.email,
            action: "centre.wallboard.create",
            entityType: "centre_wallboard",
            entityId: id,
            summary: `Created a ${input.layout} wallboard`,
        }),
    ]);
    return requireWallboard(db, user.email, id);
}

export async function updateWallboard(db: D1Database, user: PortalUser, id: string, body: unknown) {
    const { version, ...rest } = (body ?? {}) as { version?: unknown };
    if (typeof version !== "number") throw new HttpError(422, "validation", "Send the version you edited");
    await requireWallboard(db, user.email, id);
    const input = await checkInput(db, user, rest);
    const [result] = await db.batch([
        db
            .prepare("UPDATE ic_wallboards SET name = ?, config = ?, version = version + 1, updated_at = ? WHERE id = ? AND email = ? AND version = ?")
            .bind(input.name, configJson(input), nowIso(), id, user.email, version),
        auditStatement(db, {
            actor: user.email,
            action: "centre.wallboard.update",
            entityType: "centre_wallboard",
            entityId: id,
            summary: "Changed a wallboard",
        }),
    ]);
    if (!result.meta.changes) throw new HttpError(409, "conflict", "This wallboard was changed elsewhere. Reload and try again.");
    return requireWallboard(db, user.email, id);
}

export async function deleteWallboard(db: D1Database, user: PortalUser, id: string) {
    await requireWallboard(db, user.email, id);
    const now = nowIso();
    await db.batch([
        // Its credentials stop working at once.
        db.prepare("UPDATE ic_display_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE wallboard_id = ?").bind(now, id),
        db.prepare("DELETE FROM ic_wallboards WHERE id = ? AND email = ?").bind(id, user.email),
        auditStatement(db, {
            actor: user.email,
            action: "centre.wallboard.delete",
            entityType: "centre_wallboard",
            entityId: id,
            summary: "Deleted a wallboard and revoked its display credentials",
        }),
    ]);
}

/** A new display credential. The token is returned once and never again. */
export async function createDisplayToken(db: D1Database, user: PortalUser, boardId: string, body: unknown) {
    const board = await requireWallboard(db, user.email, boardId);
    const { label, expiresInDays } = (body ?? {}) as { label?: unknown; expiresInDays?: unknown };
    if (typeof label !== "string" || !label.trim() || label.trim().length > 60)
        throw new HttpError(422, "validation", "Name the display (up to 60 characters), e.g. Kitchen TV");
    if (
        expiresInDays !== undefined &&
        expiresInDays !== null &&
        (typeof expiresInDays !== "number" || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 730)
    )
        throw new HttpError(422, "validation", "Expiry is 1 to 730 days, or none");
    if (board.tokens.filter((t) => !t.revokedAt).length >= MAX_TOKENS_PER_BOARD)
        throw new HttpError(422, "validation", `Up to ${MAX_TOKENS_PER_BOARD} active displays per wallboard`);
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const id = newId("icd");
    const now = nowIso();
    const expires = typeof expiresInDays === "number" ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null;
    await db.batch([
        db
            .prepare("INSERT INTO ic_display_tokens (id, wallboard_id, token_hash, label, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(id, boardId, await hashDisplayToken(token), label.trim(), user.email, now, expires),
        auditStatement(db, {
            actor: user.email,
            action: "centre.display.create",
            entityType: "centre_display",
            entityId: id,
            summary: "Created a wallboard display credential",
        }),
    ]);
    return { id, token, path: `/display#t=${token}`, expiresAt: expires };
}

export async function revokeDisplayToken(db: D1Database, user: PortalUser, boardId: string, tokenId: string) {
    await requireWallboard(db, user.email, boardId);
    const result = await db
        .prepare("UPDATE ic_display_tokens SET revoked_at = ? WHERE id = ? AND wallboard_id = ? AND revoked_at IS NULL")
        .bind(nowIso(), tokenId, boardId)
        .run();
    if (!result.meta.changes) throw new HttpError(404, "not_found", "Not found");
    await auditStatement(db, {
        actor: user.email,
        action: "centre.display.revoke",
        entityType: "centre_display",
        entityId: tokenId,
        summary: "Revoked a wallboard display credential",
    }).run();
}

// --- The display's side --------------------------------------------------------------------------

const LAYER_FILTERS: Record<MapLayer, (r: CentreRecord) => boolean> = {
    fire: (r) => r.category === "fire" && r.kind === "incident",
    warnings: (r) => r.kind === "warning" && r.category !== "flood" && r.category !== "weather",
    weather: (r) => r.category === "weather",
    flood: (r) => r.category === "flood",
    water: (r) => r.category === "water",
    transport: (r) => r.category === "transport",
    power: (r) => r.category === "power",
    air: (r) => r.category === "air",
    hotspot: (r) => r.category === "hotspot",
    earthquake: (r) => r.category === "earthquake",
    emergency: (r) => r.category === "emergency",
    watch: () => false,
};

export class DisplayRefused extends Error {
    constructor(readonly status: 404 | 429) {
        super(status === 429 ? "Slow down" : "Not found");
    }
}

/** Who a display credential belongs to, or a refusal that looks the same for every reason. */
export async function authenticateDisplay(env: Env, request: Request): Promise<{ board: Wallboard; owner: PortalUser; tokenId: string }> {
    if (!(await isEnabled(env.DB, "intelligence_centre.wallboard"))) throw new DisplayRefused(404);
    const header = request.headers.get("Authorization") ?? "";
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header)?.[1];
    if (!token) throw new DisplayRefused(404);
    const row = await env.DB.prepare(
        `SELECT t.id, t.wallboard_id, t.expires_at, t.revoked_at, b.email FROM ic_display_tokens t JOIN ic_wallboards b ON b.id = t.wallboard_id WHERE t.token_hash = ?`,
    )
        .bind(await hashDisplayToken(token))
        .first<{ id: string; wallboard_id: string; expires_at: string | null; revoked_at: string | null; email: string }>();
    if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) < Date.now())) throw new DisplayRefused(404);
    // Generous for one screen refreshing every 30 seconds; stops anything hammering the database.
    if (!(await allow(env.DB, "centre-display", row.id, 30, 60))) throw new DisplayRefused(429);
    const auth = await userForEmail(env, row.email);
    if (!auth.ok || !can(auth.user, "centre.use")) throw new DisplayRefused(404);
    await env.DB.prepare("UPDATE ic_display_tokens SET last_used_at = ?, uses = uses + 1 WHERE id = ?").bind(nowIso(), row.id).run();
    return { board: await requireWallboard(env.DB, row.email, row.wallboard_id), owner: auth.user, tokenId: row.id };
}

export async function wallboardPayload(env: Env, board: Wallboard, owner: PortalUser, now = new Date()): Promise<WallboardPayload> {
    const db = env.DB;
    const [health, { settings }, { preferences }] = await Promise.all([sourceHealth(env), loadCentreSettings(db), loadPreferences(db, owner.email)]);
    const watch = board.watchId ? await requireWatch(db, owner.email, board.watchId).catch(() => null) : null;
    let records: CentreRecord[];
    let frame: BBox = NSW_BBOX;
    if (watch) {
        records = (await recordsForWatch(db, watch, 400)).map((m) => m.record);
        const box = watchBBox(watch.definition);
        const located = records.filter((r) => r.lat !== null && r.lon !== null);
        if (box) frame = coarseBBox(expandBBox(box, 10));
        else if (located.length)
            frame = coarseBBox(
                expandBBox(
                    [
                        Math.min(...located.map((r) => r.lon!)),
                        Math.min(...located.map((r) => r.lat!)),
                        Math.max(...located.map((r) => r.lon!)),
                        Math.max(...located.map((r) => r.lat!)),
                    ],
                    15,
                ),
            );
    } else {
        records = (await listRecords(db, { kinds: ["incident", "warning", "disruption", "detection", "event", "rating"] }, 1500)).records;
    }
    const layers = board.layers;
    const mapped = records.filter((r) => r.kind !== "rating" && r.kind !== "observation" && layers.some((l) => LAYER_FILTERS[l](r)));
    const observations = (await listRecords(db, { kinds: ["observation"], bbox: frame }, 400)).records;
    const ratings = (watch ? records : (await listRecords(db, { kinds: ["rating"] }, 100)).records).filter((r) => r.kind === "rating");
    const ids = new Set(records.map((r) => r.id));
    const recent: CentreChange[] = (await listChanges(db, { since: new Date(now.getTime() - 12 * 3_600_000).toISOString(), limit: 200 })).filter(
        (c) => (c.recordId && ids.has(c.recordId)) || (!watch && !c.recordId),
    );
    // Highlight official warning changes in this area from the last two hours.
    const highlights = recent.filter(
        (c) =>
            Date.parse(c.at) > now.getTime() - 2 * 3_600_000 &&
            ["new", "escalated", "ban_declared", "rating_changed", "geometry_changed"].includes(c.kind) &&
            records.some((r) => r.id === c.recordId && (r.kind === "warning" || r.kind === "incident" || r.kind === "rating")),
    );
    let interpretation: WallboardPayload["interpretation"] = null;
    if (board.showInterpretation) {
        const stored = await db
            .prepare("SELECT interpretation, model FROM ic_briefings WHERE email = ? AND scope = ?")
            .bind(owner.email, watch ? `watch:${watch.id}` : "nsw:nsw")
            .first<{ interpretation: string; model: string | null }>();
        interpretation = stored
            ? { status: "ready", items: parseJson(stored.interpretation, []), model: stored.model }
            : { status: "not_requested", items: [], model: null };
    }
    let outline: [number, number][] | null = null;
    if (board.showWatchOutline && watch?.definition.kind === "polygon")
        outline = watch.definition.ring.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
    const shown = mapped.slice(0, settings.maxMapRecords);
    return {
        board: {
            name: board.name,
            layout: board.layout,
            rotation: board.rotation,
            rotationSeconds: board.rotationSeconds,
            refreshSeconds: board.refreshSeconds,
            layers,
        },
        frame,
        areaLabel: board.name,
        generatedAt: now.toISOString(),
        timeZone: preferences.timeZone,
        records: shown,
        map: await mapFeatures(db, shown),
        fireDanger: ratings.map((r) => ({
            district: r.title,
            today: r.attributes.today ?? "No rating",
            tomorrow: r.attributes.tomorrow ?? "No rating",
            banToday: r.attributes.banToday === "yes",
            banTomorrow: r.attributes.banTomorrow === "yes",
            updatedAt: r.updatedAt,
        })),
        observations,
        changes: recent.slice(0, 40),
        highlights,
        sources: health
            .filter((h) => h.source.implemented && h.enabled)
            .map((h) => ({
                id: h.source.id,
                dataset: h.source.dataset,
                provider: h.source.provider,
                status: h.status,
                lastSuccessAt: h.lastSuccessAt,
                attribution: h.source.attribution,
            })),
        interpretation,
        outline,
        basemap: settings.basemap,
    };
}
