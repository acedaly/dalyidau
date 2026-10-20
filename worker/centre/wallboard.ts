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
//
// Wallboard 2.0 (9.1): a board has views (presets or custom widget grids, in ic_wallboard_views)
// that it rotates through; boards saved before then show the views their layout and rotation
// describe. A credential the owner marked renewable can be swapped by the screen itself for a new
// one near its expiry; the old one keeps working for a few minutes so a screen mid-refresh isn't
// cut off. The payload a screen gets is built in display.ts.
import type { D1Database } from "@cloudflare/workers-types";
import type { CentreChange, CentreRecord, DisplayToken, MapLayer, Wallboard, WallboardInput, WallboardPayload } from "../../src/shared/centre/types";
import { wallboardInputSchema } from "../../src/shared/centre/types";
import type { ViewInput, WallboardView, Widget } from "../../src/shared/centre/wallboard";
import { legacyViews, viewsInputSchema } from "../../src/shared/centre/wallboard";
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
    renewable: number;
    renewed_at: string | null;
}

interface ViewRow {
    id: string;
    wallboard_id: string;
    position: number;
    name: string;
    preset: WallboardView["preset"];
    customised: number;
    widgets: string;
}

const TOKEN_COLUMNS = "id, wallboard_id, label, created_at, expires_at, revoked_at, last_used_at, renewable, renewed_at";

const toToken = (t: TokenRow): DisplayToken => ({
    id: t.id,
    label: t.label,
    createdAt: t.created_at,
    expiresAt: t.expires_at,
    revokedAt: t.revoked_at,
    lastUsedAt: t.last_used_at,
    renewable: t.renewable === 1,
    renewedAt: t.renewed_at,
});

const toView = (v: ViewRow): WallboardView => ({
    id: v.id,
    name: v.name,
    preset: v.preset,
    customised: v.customised === 1,
    widgets: parseJson<Widget[]>(v.widgets, []),
});

function toBoard(row: BoardRow, tokens: TokenRow[], views: ViewRow[]): Wallboard {
    const config = wallboardInputSchema.safeParse({ ...parseJson<object>(row.config, {}), name: row.name });
    const base = config.success ? config.data : wallboardInputSchema.parse({ name: row.name, layout: "nsw" });
    // A board saved before Wallboard 2.0 shows the views its layout and rotation describe.
    const saved = views.sort((a, b) => a.position - b.position).map(toView);
    const derived = saved.length ? saved : legacyViews(base.layout, base.rotation).map((v, i) => ({ ...v, id: `legacy_${i}` }));
    return {
        ...base,
        id: row.id,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tokens: tokens.map(toToken),
        views: derived,
        legacyViews: !saved.length,
    };
}

export async function listWallboards(db: D1Database, email: string): Promise<Wallboard[]> {
    const boards = await db.prepare("SELECT * FROM ic_wallboards WHERE email = ? ORDER BY name COLLATE NOCASE").bind(email).all<BoardRow>();
    if (!boards.results.length) return [];
    const ids = boards.results.map((b) => b.id);
    const marks = ids.map(() => "?").join(",");
    const [tokens, views] = await Promise.all([
        db.prepare(`SELECT ${TOKEN_COLUMNS} FROM ic_display_tokens WHERE wallboard_id IN (${marks}) ORDER BY created_at DESC`).bind(...ids).all<TokenRow>(),
        db.prepare(`SELECT * FROM ic_wallboard_views WHERE wallboard_id IN (${marks}) ORDER BY position`).bind(...ids).all<ViewRow>(),
    ]);
    return boards.results.map((b) =>
        toBoard(
            b,
            tokens.results.filter((t) => t.wallboard_id === b.id),
            views.results.filter((v) => v.wallboard_id === b.id),
        ),
    );
}

export async function requireWallboard(db: D1Database, email: string, id: string): Promise<Wallboard> {
    if (!/^icb_[a-z0-9]{14}$/.test(id)) throw new HttpError(404, "not_found", "Not found");
    const row = await db.prepare("SELECT * FROM ic_wallboards WHERE id = ? AND email = ?").bind(id, email).first<BoardRow>();
    if (!row) throw new HttpError(404, "not_found", "Not found");
    const [tokens, views] = await Promise.all([
        db.prepare(`SELECT ${TOKEN_COLUMNS} FROM ic_display_tokens WHERE wallboard_id = ? ORDER BY created_at DESC`).bind(id).all<TokenRow>(),
        db.prepare("SELECT * FROM ic_wallboard_views WHERE wallboard_id = ? ORDER BY position").bind(id).all<ViewRow>(),
    ]);
    return toBoard(row, tokens.results, views.results);
}

async function checkInput(db: D1Database, user: PortalUser, body: unknown): Promise<WallboardInput> {
    const input = wallboardInputSchema.parse(body);
    // Only the owner's own watch area (404 for anyone else's, as everywhere).
    if (input.watchId) await requireWatch(db, user.email, input.watchId);
    if (input.layout === "local" && !input.watchId) throw new HttpError(422, "validation", "Local Situation needs a watch area");
    return input;
}

/** Views as saved: valid layouts, and only the owner's own watch areas and existing records in widget settings. */
async function checkViews(db: D1Database, user: PortalUser, body: unknown, board: Pick<WallboardInput, "watchId">): Promise<ViewInput[]> {
    const views = viewsInputSchema.parse(body);
    const watchIds = new Set<string>();
    const recordIds = new Set<string>();
    for (const view of views)
        for (const w of view.widgets) {
            if (w.settings.scope?.kind === "watch") watchIds.add(w.settings.scope.watchId);
            if (w.settings.recordId) recordIds.add(w.settings.recordId);
            if (view.preset === "local" && !board.watchId && (!w.settings.scope || w.settings.scope.kind === "board") && w.type === "map")
                throw new HttpError(422, "validation", "Local Situation needs the board's area to be a watch area, or each widget's own area");
        }
    for (const id of watchIds) await requireWatch(db, user.email, id);
    for (const id of recordIds)
        if (!(await db.prepare("SELECT 1 FROM ic_records WHERE id = ?").bind(id).first())) throw new HttpError(422, "validation", "A timeline widget names a record that isn't stored");
    return views;
}

const viewStatements = (db: D1Database, boardId: string, views: ViewInput[], now: string) => [
    db.prepare("DELETE FROM ic_wallboard_views WHERE wallboard_id = ?").bind(boardId),
    ...views.map((v, position) =>
        db
            .prepare("INSERT INTO ic_wallboard_views (id, wallboard_id, position, name, preset, customised, widgets, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(v.id ?? newId("icl"), boardId, position, v.name, v.preset, v.customised ? 1 : 0, JSON.stringify(v.widgets), now, now),
    ),
];

/** Replaces a board's views (and so its rotation) in one step; the board's version goes up. */
export async function saveViews(db: D1Database, user: PortalUser, id: string, body: unknown) {
    const { version, views } = (body ?? {}) as { version?: unknown; views?: unknown };
    if (typeof version !== "number") throw new HttpError(422, "validation", "Send the version you edited");
    const board = await requireWallboard(db, user.email, id);
    const checked = await checkViews(db, user, views, board);
    // Ids are kept only when they're this board's own (never another board's view).
    const own = new Set(board.legacyViews ? [] : board.views.map((v) => v.id));
    const list = checked.map((v) => (v.id && own.has(v.id) ? v : { ...v, id: undefined }));
    if (board.version !== version) throw new HttpError(409, "conflict", "This wallboard was changed elsewhere. Reload and try again.");
    const now = nowIso();
    // One transaction: the version and every view change together, or not at all.
    await db.batch([
        db.prepare("UPDATE ic_wallboards SET version = version + 1, updated_at = ? WHERE id = ? AND email = ? AND version = ?").bind(now, id, user.email, version),
        ...viewStatements(db, id, list, now),
        auditStatement(db, {
            actor: user.email,
            action: "centre.wallboard.views",
            entityType: "centre_wallboard",
            entityId: id,
            summary: `Saved ${list.length} wallboard ${list.length === 1 ? "view" : "views"}`,
        }),
    ]);
    return requireWallboard(db, user.email, id);
}

/** A copy of a board (settings and views, never its display credentials). */
export async function duplicateWallboard(db: D1Database, user: PortalUser, id: string, body: unknown) {
    const board = await requireWallboard(db, user.email, id);
    const name = typeof (body as { name?: unknown })?.name === "string" ? (body as { name: string }).name.trim().slice(0, 60) : "";
    const { id: _id, version: _v, createdAt: _c, updatedAt: _u, tokens: _t, views, legacyViews: legacy, ...config } = board;
    const copy = await createWallboard(db, user, { ...config, name: name || `${board.name} (copy)`.slice(0, 60) });
    if (legacy) return copy;
    return saveViews(db, user, copy.id, { version: copy.version, views: views.map(({ id: _view, ...v }) => v) });
}

const configJson = (input: WallboardInput) => {
    const { name: _name, ...config } = input;
    return JSON.stringify(config);
};

export async function createWallboard(db: D1Database, user: PortalUser, body: unknown) {
    const { views: viewBody, ...rest } = (body ?? {}) as { views?: unknown };
    const input = await checkInput(db, user, rest);
    const views = viewBody === undefined ? null : await checkViews(db, user, viewBody, input);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM ic_wallboards WHERE email = ?").bind(user.email).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_WALLBOARDS) throw new HttpError(422, "validation", `You can have up to ${MAX_WALLBOARDS} wallboards`);
    const id = newId("icb");
    const now = nowIso();
    await db.batch([
        db
            .prepare("INSERT INTO ic_wallboards (id, email, name, config, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
            .bind(id, user.email, input.name, configJson(input), now, now),
        ...(views ? viewStatements(db, id, views.map((v) => ({ ...v, id: undefined })), now) : []),
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
        db.prepare("DELETE FROM ic_wallboard_views WHERE wallboard_id = ?").bind(id),
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
    const { label, expiresInDays, renewable } = (body ?? {}) as { label?: unknown; expiresInDays?: unknown; renewable?: unknown };
    if (typeof label !== "string" || !label.trim() || label.trim().length > 60)
        throw new HttpError(422, "validation", "Name the display (up to 60 characters), e.g. Kitchen TV");
    if (
        expiresInDays !== undefined &&
        expiresInDays !== null &&
        (typeof expiresInDays !== "number" || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 730)
    )
        throw new HttpError(422, "validation", "Expiry is 1 to 730 days, or none");
    if (renewable !== undefined && typeof renewable !== "boolean") throw new HttpError(422, "validation", "Renewable is true or false");
    if (renewable && typeof expiresInDays !== "number") throw new HttpError(422, "validation", "Only an expiring display address can renew itself");
    if (board.tokens.filter((t) => !t.revokedAt).length >= MAX_TOKENS_PER_BOARD)
        throw new HttpError(422, "validation", `Up to ${MAX_TOKENS_PER_BOARD} active displays per wallboard`);
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const id = newId("icd");
    const now = nowIso();
    const expires = typeof expiresInDays === "number" ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null;
    await db.batch([
        db
            .prepare(
                "INSERT INTO ic_display_tokens (id, wallboard_id, token_hash, label, created_by, created_at, expires_at, renewable, lifetime_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(id, boardId, await hashDisplayToken(token), label.trim(), user.email, now, expires, renewable ? 1 : 0, typeof expiresInDays === "number" ? expiresInDays : null),
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

interface CredentialRow {
    id: string;
    wallboard_id: string;
    expires_at: string | null;
    revoked_at: string | null;
    renewable: number;
    lifetime_days: number | null;
    email: string;
    current: number;
}

/** A display credential by its hash, or by the hash it just replaced (only during the short overlap). */
async function credential(env: Env, request: Request): Promise<CredentialRow> {
    if (!(await isEnabled(env.DB, "intelligence_centre.wallboard"))) throw new DisplayRefused(404);
    const header = request.headers.get("Authorization") ?? "";
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header)?.[1];
    if (!token) throw new DisplayRefused(404);
    const hash = await hashDisplayToken(token);
    const now = new Date().toISOString();
    const row = await env.DB.prepare(
        `SELECT t.id, t.wallboard_id, t.expires_at, t.revoked_at, t.renewable, t.lifetime_days, b.email, CASE WHEN t.token_hash = ?1 THEN 1 ELSE 0 END AS current
         FROM ic_display_tokens t JOIN ic_wallboards b ON b.id = t.wallboard_id
         WHERE t.token_hash = ?1 OR (t.previous_hash = ?1 AND t.previous_until > ?2)`,
    )
        .bind(hash, now)
        .first<CredentialRow>();
    if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) < Date.now())) throw new DisplayRefused(404);
    return row;
}

/** Who a display credential belongs to, or a refusal that looks the same for every reason. */
export async function authenticateDisplay(
    env: Env,
    request: Request,
): Promise<{ board: Wallboard; owner: PortalUser; tokenId: string; expiresAt: string | null; renewable: boolean }> {
    const row = await credential(env, request);
    // Generous for one screen refreshing every 30 seconds; stops anything hammering the database.
    if (!(await allow(env.DB, "centre-display", row.id, 30, 60))) throw new DisplayRefused(429);
    const auth = await userForEmail(env, row.email);
    if (!auth.ok || !can(auth.user, "centre.use")) throw new DisplayRefused(404);
    await env.DB.prepare("UPDATE ic_display_tokens SET last_used_at = ?, uses = uses + 1 WHERE id = ?").bind(nowIso(), row.id).run();
    return {
        board: await requireWallboard(env.DB, row.email, row.wallboard_id),
        owner: auth.user,
        tokenId: row.id,
        expiresAt: row.expires_at,
        renewable: row.renewable === 1 && row.current === 1,
    };
}

/**
 * For map tiles: the same checks as a refresh (switch on, credential valid and unexpired, owner
 * still allowed), with its own higher rate limit and without recording a use for every tile.
 */
export async function authenticateDisplayTiles(env: Env, request: Request): Promise<void> {
    const row = await credential(env, request);
    if (!(await allow(env.DB, "centre-display-tiles", row.id, 600, 60))) throw new DisplayRefused(429);
    const auth = await userForEmail(env, row.email);
    if (!auth.ok || !can(auth.user, "centre.use")) throw new DisplayRefused(404);
}

/** How close to its expiry a renewable credential may be renewed by its screen. */
export const RENEW_WITHIN_MS = 14 * 86_400_000;
/** How long the replaced credential keeps working, for a screen that's mid-refresh. */
const OVERLAP_MS = 15 * 60_000;

/**
 * A screen swapping its renewable credential for a new one near expiry. The credential row stays
 * the same (the owner revokes it as before); only its hash and expiry change, and the old hash
 * works for a short overlap. The new token is returned once.
 */
export async function renewDisplayToken(env: Env, request: Request): Promise<{ token: string; expiresAt: string }> {
    const row = await credential(env, request);
    if (!(await allow(env.DB, "centre-display-renew", row.id, 3, 3600))) throw new DisplayRefused(429);
    const auth = await userForEmail(env, row.email);
    if (!auth.ok || !can(auth.user, "centre.use")) throw new DisplayRefused(404);
    if (!row.current || row.renewable !== 1 || !row.expires_at || !row.lifetime_days || Date.parse(row.expires_at) - Date.now() > RENEW_WITHIN_MS)
        throw new HttpError(409, "not_renewable", "This display address can't be renewed now");
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const now = Date.now();
    const expiresAt = new Date(now + row.lifetime_days * 86_400_000).toISOString();
    const old = await hashDisplayToken(/^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")![1]);
    const [updated] = await env.DB.batch([
        env.DB.prepare(
            `UPDATE ic_display_tokens SET token_hash = ?, previous_hash = ?, previous_until = ?, expires_at = ?, renewed_at = ?
             WHERE id = ? AND token_hash = ? AND revoked_at IS NULL`,
        ).bind(await hashDisplayToken(token), old, new Date(now + OVERLAP_MS).toISOString(), expiresAt, new Date(now).toISOString(), row.id, old),
        auditStatement(env.DB, {
            actor: row.email,
            action: "centre.display.renew",
            entityType: "centre_display",
            entityId: row.id,
            summary: "A wallboard display renewed its own credential",
        }),
    ]);
    if (!updated.meta.changes) throw new DisplayRefused(404);
    return { token, expiresAt };
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
