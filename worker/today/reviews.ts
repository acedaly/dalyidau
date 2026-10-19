// Morning planning and the evening review (migration 0024): one record of each per person per day,
// private to them. The routines themselves change nothing here: sessions are planned, moved or
// cancelled through the Daily Planner, and tasks completed or created through Tasks, each with its
// own permissions and history. This only records what the person chose (their top three, by id) and
// counts, plus the evening's note in their own words. History holds ids only.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import { type DailyReview, reviewSummary } from "../../src/shared/today/types";
import { activity } from "../calendar/access";
import { nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import { requireTask } from "../tasks/access";

interface ReviewRow {
    date: string;
    kind: "morning" | "evening";
    priorities: string;
    summary: string;
    note: string | null;
    version: number;
    updated_at: string;
}

const toReview = (r: ReviewRow): DailyReview => {
    const summary = reviewSummary.safeParse(parseJson(r.summary, {}));
    return {
        date: r.date,
        kind: r.kind,
        priorities: parseJson<string[]>(r.priorities, []),
        summary: summary.success ? summary.data : reviewSummary.parse({}),
        note: r.note,
        version: r.version,
        updatedAt: r.updated_at,
    };
};

export async function loadReviews(db: D1Database, user: PortalUser, date: string): Promise<{ morning: DailyReview | null; evening: DailyReview | null }> {
    const rows = await db
        .prepare("SELECT date, kind, priorities, summary, note, version, updated_at FROM daily_reviews WHERE email = ? AND date = ?")
        .bind(user.email, date)
        .all<ReviewRow>();
    const by = new Map(rows.results.map((r) => [r.kind, toReview(r)]));
    return { morning: by.get("morning") ?? null, evening: by.get("evening") ?? null };
}

const saveInput = z
    .object({
        priorities: z
            .array(z.string().regex(/^tsk_[a-z0-9]{14}$/))
            .max(3, "Choose up to three priorities")
            .refine((p) => new Set(p).size === p.length, "Each task once")
            .default([]),
        summary: reviewSummary.default(() => reviewSummary.parse({})),
        note: z.string().trim().max(4000).nullable().default(null),
        /** The version read, or 0 for the first save that day. */
        version: z.number().int().min(0),
    })
    .strict();

export async function saveReview(db: D1Database, user: PortalUser, date: string, kind: string, input: unknown): Promise<DailyReview> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "bad_date", "Use a date like 2026-10-19");
    if (kind !== "morning" && kind !== "evening") throw new HttpError(404, "not_found", "Not found");
    const body = saveInput.parse(input);
    // Every priority is a task the person can see in Tasks; one they can't is a 404, as in Tasks.
    for (const id of body.priorities) await requireTask(db, user, id, "viewer");
    const now = nowIso();
    const values = [JSON.stringify(body.priorities), JSON.stringify(body.summary), body.note || null];
    const write =
        body.version === 0
            ? db
                  .prepare(
                      `INSERT INTO daily_reviews (email, date, kind, priorities, summary, note, version, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT DO NOTHING`,
                  )
                  .bind(user.email, date, kind, ...values, now, now)
            : db
                  .prepare(
                      `UPDATE daily_reviews SET priorities = ?, summary = ?, note = ?, version = version + 1, updated_at = ?
                       WHERE email = ? AND date = ? AND kind = ? AND version = ?`,
                  )
                  .bind(...values, now, user.email, date, kind, body.version);
    const result = await write.run();
    if (!result.meta.changes)
        throw new HttpError(409, "conflict", `Your ${kind} ${kind === "morning" ? "planning" : "review"} changed in another window. Reload to see it.`);
    await activity(db, { actor: user.email, action: `today.${kind}`, entityType: "daily_review", entityId: `${date}:${kind}` }).run();
    const reviews = await loadReviews(db, user, date);
    return reviews[kind]!;
}
