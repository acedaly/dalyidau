// Daily notes: one ordinary object per calendar date per space, made when someone first writes in
// it (never in advance), with its date fixed at creation. Everything else (the editor, autosave,
// conflicts, revisions, search, links) is the object engine's, unchanged.
//
// A unique index on (space_id, daily_date) means two tabs, a double click or simultaneous captures
// always end up with the same note: whoever loses the race gets the winner's note back.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { CONTENT_FORMAT, type DocNode, paragraphsFromText } from "../../src/shared/knowledge/content";
import { addDays, formatDailyTitle, isCalendarDate, localDate } from "../../src/shared/knowledge/dates";
import type { DailyNoteDay, KnowledgeObjectDetail } from "../../src/shared/knowledge/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { type SpaceRow, requireSpace } from "./access";
import { knowledgeAudit } from "./audit";
import { seedTypeStatement } from "./default-types";
import { KnowledgeConflict, objectDetail, revisionInsert, updateObject } from "./objects";
import { indexStatements } from "./search";

export const DAILY_TYPE_SLUG = "daily_note";

/** Today in the space's time zone. */
export const spaceToday = (space: Pick<SpaceRow, "time_zone">, now = new Date()) => localDate(now, space.time_zone);

/** A date from a URL or request: "today" or a real YYYY-MM-DD. */
export const parseDailyDate = (value: string | null | undefined, space: Pick<SpaceRow, "time_zone">) => {
    if (!value || value === "today") return spaceToday(space);
    if (!isCalendarDate(value)) throw new HttpError(404, "not_found", "Not found");
    return value;
};

/** The daily note for a date, or null if nobody has written one. Membership must already be checked. */
export async function dailyNote(db: D1Database, spaceId: string, date: string): Promise<KnowledgeObjectDetail | null> {
    const row = await db.prepare("SELECT id FROM knowledge_objects WHERE space_id = ? AND daily_date = ?").bind(spaceId, date).first<{ id: string }>();
    return row ? objectDetail(db, row.id) : null;
}

/** The space's "Daily note" type, created the first time a daily note is. */
async function dailyTypeId(db: D1Database, spaceId: string, actor: string): Promise<string> {
    const find = () =>
        db.prepare("SELECT id FROM knowledge_object_types WHERE space_id = ? AND slug = ?").bind(spaceId, DAILY_TYPE_SLUG).first<{ id: string }>();
    const existing = await find();
    if (existing) return existing.id;
    // UNIQUE (space_id, slug): if two requests race, one insert is ignored and both read the winner.
    await seedTypeStatement(db, spaceId, actor, nowIso(), {
        slug: DAILY_TYPE_SLUG,
        name: "Daily note",
        icon: "clock",
        description: "One note per day: a journal, a log, a place to put things down.",
        properties: () => [],
    }).run();
    return (await find())!.id;
}

/** The daily note for a date, creating an empty one if there isn't one yet. Editors only. */
export async function ensureDailyNote(db: D1Database, user: PortalUser, spaceId: string, date: string): Promise<KnowledgeObjectDetail> {
    await requireSpace(db, user, spaceId, "editor");
    if (!isCalendarDate(date)) throw new HttpError(422, "validation", "Choose a real date");
    const existing = await dailyNote(db, spaceId, date);
    if (existing) return existing;

    const typeId = await dailyTypeId(db, spaceId, user.email);
    const title = formatDailyTitle(date);
    const empty = JSON.stringify({ type: "doc", content: [] });
    const ifCreated = "WHERE EXISTS (SELECT 1 FROM knowledge_objects WHERE id = ?)";
    // DO NOTHING also absorbs a clash on search_rowid with an object created at the same instant;
    // then neither note exists yet, so try again.
    for (let attempt = 0; attempt < 3; attempt++) {
        const id = newId("kob");
        const now = nowIso();
        await db.batch([
            db
                .prepare(
                    `INSERT INTO knowledge_objects (id, space_id, type_id, title, content_json, content_format, body_text, properties_json, daily_date, search_rowid,
                        created_by, updated_by, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, '', '{}', ?, (SELECT COALESCE(MAX(search_rowid), 0) + 1 FROM knowledge_objects), ?, ?, ?, ?)
                     ON CONFLICT DO NOTHING`,
                )
                .bind(id, spaceId, typeId, title, empty, CONTENT_FORMAT, date, user.email, user.email, now, now),
            revisionInsert(db, { id, space_id: spaceId }, 1, "create", { typeId, title, contentJson: empty, propertiesJson: "{}" }, user.email, now, ifCreated, [
                id,
            ]),
            ...indexStatements(db, id),
            knowledgeAudit(
                db,
                { spaceId, actor: user.email, action: "object.create", entityType: "object", entityId: id, summary: "Started a daily note" },
                ifCreated,
                [id],
            ),
        ]);
        const note = await dailyNote(db, spaceId, date);
        if (note) return note;
    }
    throw new HttpError(503, "busy", "Couldn't start the daily note. Try again.");
}

const appendInput = z.object({
    text: z.string().trim().min(1, "Write something to capture").max(20_000),
    date: z.string().max(10).optional(),
});

/** "14:32" in the space's time zone, for timestamping captured lines. */
const localTime = (timeZone: string, now = new Date()) =>
    new Intl.DateTimeFormat("en-AU", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);

/**
 * Adds captured text to the end of a daily note (today's unless a date is given), creating the note
 * if needed. Goes through the ordinary update path, so it's versioned like any edit; if someone saves
 * the note at the same moment, it re-reads and tries again rather than overwriting them.
 */
export async function appendToDailyNote(db: D1Database, user: PortalUser, spaceId: string, input: unknown): Promise<KnowledgeObjectDetail> {
    const space = await requireSpace(db, user, spaceId, "editor");
    const body = appendInput.parse(input);
    const date = parseDailyDate(body.date, space);
    const added = paragraphsFromText(body.text);
    // The first line is stamped with the time, so the note reads as a running log.
    const first = added[0];
    if (first?.content?.length) first.content.unshift({ type: "text", text: `${localTime(space.time_zone)} `, marks: [{ type: "bold" }] });
    for (let attempt = 0; ; attempt++) {
        const note = await ensureDailyNote(db, user, spaceId, date);
        const doc = note.object.content as DocNode;
        try {
            return await updateObject(db, user, note.object.id, {
                version: note.object.version,
                content: { type: "doc", content: [...(doc.content ?? []), ...added] },
            });
        } catch (error) {
            if (!(error instanceof KnowledgeConflict) || attempt >= 2) throw error;
        }
    }
}

/** Daily notes near a date (not in the trash), newest first, for the recent list. */
export async function recentDailyNotes(db: D1Database, spaceId: string, limit = 7): Promise<DailyNoteDay[]> {
    const rows = await db
        .prepare(
            `SELECT id, daily_date, title, substr(body_text, 1, 160) AS excerpt FROM knowledge_objects
             WHERE space_id = ? AND daily_date IS NOT NULL AND status <> 'trashed' ORDER BY daily_date DESC LIMIT ?`,
        )
        .bind(spaceId, limit)
        .all<{ id: string; daily_date: string; title: string; excerpt: string }>();
    return rows.results.map((r) => ({ date: r.daily_date, id: r.id, title: r.title, excerpt: r.excerpt.replace(/\s+/g, " ").trim() }));
}

/** Dates with a daily note between two dates (inclusive), for marking the calendar. */
export async function dailyNoteDates(db: D1Database, spaceId: string, from: string, to: string): Promise<string[]> {
    const rows = await db
        .prepare(
            "SELECT daily_date FROM knowledge_objects WHERE space_id = ? AND daily_date BETWEEN ? AND ? AND status <> 'trashed' AND body_text <> '' ORDER BY daily_date",
        )
        .bind(spaceId, from, to)
        .all<{ daily_date: string }>();
    return rows.results.map((r) => r.daily_date);
}

/** The window of dates the daily page marks: six weeks either side of the date shown. */
export const calendarWindow = (date: string) => ({ from: addDays(date, -45), to: addDays(date, 45) });
