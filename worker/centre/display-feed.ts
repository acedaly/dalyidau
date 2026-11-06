// Display feed (docs/INTELLIGENCE_CENTRE.md#display-feed): a small JSON feed for a third-party wall
// display on the owner's network (Daly Display), read with a display credential whose scope is
// "display:<name>". It reuses the wallboard credential model (256 random bits, only the SHA-256
// stored, expiring, revoked instantly) and the credential's wallboard: the board's watch area decides
// which warnings and fire danger ratings are included.
//
// What it carries: NSW public holidays and school dates (src/shared/calendar), the provider's own
// warnings and fire danger ratings. Never the watch area's name or location, no people, no calendar
// events. Unlike /display it answers with distinct statuses, because its client is a server that
// needs to tell "credential gone" (401) from "wrong kind of credential" (403).
import { holidayOverlays, schoolOverlays } from "../../src/shared/calendar/holidays";
import { addDays, localDate } from "../../src/shared/calendar/time";
import type { CentreRecord, DisplayFeed, Wallboard } from "../../src/shared/centre/types";
import { isFeedScope } from "../../src/shared/centre/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can, userForEmail } from "../portal/auth";
import { nowIso } from "../portal/db";
import { isEnabled } from "../portal/flags";
import { allow } from "../wedding/rsvp";
import { loadPreferences } from "./store";
import { hashDisplayToken, requireWallboard } from "./wallboard";
import { recordsForWatch, requireWatch } from "./watch";

export const FEED_FLAG = "intelligence_centre.display_feed";
/** One display polling every two minutes uses 1 of these a minute; the rest is headroom. */
export const FEED_RATE = { limit: 10, seconds: 60 };
const DAYS_AHEAD = 90;
/** Incidents carrying one of these provider levels count as warnings for a household display. */
const WARNING_INCIDENT_LEVELS = new Set(["Emergency Warning", "Watch and Act"]);

export class FeedRefused extends Error {
    constructor(readonly status: 401 | 403 | 404 | 429) {
        super(status === 429 ? "Slow down" : status === 403 ? "Forbidden" : status === 401 ? "Unauthorized" : "Not found");
    }
}

interface FeedCredentialRow {
    id: string;
    wallboard_id: string;
    expires_at: string | null;
    revoked_at: string | null;
    scope: string;
    email: string;
}

/** The credential's wallboard and owner, or a refusal: 404 switch off, 401 no/unknown/revoked/expired, 403 not a feed credential, 429. */
export async function authenticateFeed(env: Env, request: Request): Promise<{ board: Wallboard; owner: PortalUser; tokenId: string; scope: string }> {
    if (!(await isEnabled(env.DB, FEED_FLAG))) throw new FeedRefused(404);
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("Authorization") ?? "")?.[1];
    if (!token) throw new FeedRefused(401);
    const row = await env.DB.prepare(
        `SELECT t.id, t.wallboard_id, t.expires_at, t.revoked_at, t.scope, b.email
         FROM ic_display_tokens t JOIN ic_wallboards b ON b.id = t.wallboard_id
         WHERE t.token_hash = ?`,
    )
        .bind(await hashDisplayToken(token))
        .first<FeedCredentialRow>();
    if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) < Date.now())) throw new FeedRefused(401);
    if (!isFeedScope(row.scope)) throw new FeedRefused(403);
    if (!(await allow(env.DB, "display-feed", row.id, FEED_RATE.limit, FEED_RATE.seconds))) throw new FeedRefused(429);
    // The owner as they are now: someone who can no longer open the Centre has no feed either.
    const auth = await userForEmail(env, row.email);
    if (!auth.ok || !can(auth.user, "centre.use")) throw new FeedRefused(401);
    await env.DB.prepare("UPDATE ic_display_tokens SET last_used_at = ?, uses = uses + 1 WHERE id = ?").bind(nowIso(), row.id).run();
    return { board: await requireWallboard(env.DB, row.email, row.wallboard_id), owner: auth.user, tokenId: row.id, scope: row.scope };
}

const isWarning = (r: CentreRecord) => r.kind === "warning" || (r.kind === "incident" && !!r.warningLevel && WARNING_INCIDENT_LEVELS.has(r.warningLevel));

export async function displayFeed(
    env: Env,
    board: Wallboard,
    owner: PortalUser,
    options: { division?: "eastern" | "western" | "none"; now?: Date } = {},
): Promise<DisplayFeed> {
    const now = options.now ?? new Date();
    const division = options.division ?? "eastern";
    const { preferences } = await loadPreferences(env.DB, owner.email);
    const timeZone = preferences.timeZone;
    const today = localDate(now, timeZone);
    const until = addDays(today, DAYS_AHEAD);

    const school = schoolOverlays(today, until, division, [])
        .filter((s): s is typeof s & { kind: "term" | "holidays" | "development_day" } => s.kind !== "school_event")
        .map((s) => ({ name: s.name, kind: s.kind, start: s.start, end: s.end, provisional: s.provisional }));
    const publicHolidays = holidayOverlays(today, until, { includeBankHoliday: false, region: null }, [])
        .filter((h) => h.kind !== "bank")
        .map((h) => ({ date: h.date, name: h.name, provisional: h.provisional }));

    // Warnings and ratings come only from the board's watch area; a board without one gets none
    // rather than all of NSW, which would bury a household display.
    const watch = board.watchId ? await requireWatch(env.DB, owner.email, board.watchId).catch(() => null) : null;
    const records = watch ? (await recordsForWatch(env.DB, watch, 300)).map((m) => m.record) : [];

    return {
        generatedAt: now.toISOString(),
        timeZone,
        today,
        holidays: {
            public: publicHolidays,
            school,
            schoolHolidayToday: school.some((s) => s.kind === "holidays" && s.start <= today && s.end >= today),
            division,
        },
        warnings: records.filter(isWarning).map((r) => ({
            id: r.id,
            title: r.title,
            category: r.category,
            level: r.warningLevel,
            provider: r.provider,
            updatedAt: r.updatedAt,
        })),
        fireDanger: records
            .filter((r) => r.kind === "rating" && r.category === "fire_danger")
            .map((r) => ({
                district: r.title,
                today: r.attributes.today ?? "No rating",
                tomorrow: r.attributes.tomorrow ?? "No rating",
                banToday: r.attributes.banToday === "yes",
                banTomorrow: r.attributes.banTomorrow === "yes",
                updatedAt: r.updatedAt,
            })),
    };
}
