// Custom dates (a school's own development days, regional holidays, non-working days) and the
// overlays drawn on every view: public holidays, school terms, task due dates and leave.
//
// Task overlays come straight from Daly Tasks' own views every time, so a moved due date shows up
// here without anyone touching the calendar, and only the caller's own tasks (as Tasks decides) are
// ever shown.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { holidayOverlays, schoolOverlays } from "../../src/shared/calendar/holidays";
import { addDays, daysBetween } from "../../src/shared/calendar/time";
import { CUSTOM_DATE_KINDS, type CalendarPreferences, type CustomDate, type LeaveData, type Overlays, type TaskOverlay } from "../../src/shared/calendar/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { projectNames } from "../mcp/shared";
import { can } from "../portal/auth";
import { newId, nowIso } from "../portal/db";
import { ValidationError } from "../portal/entities";
import { HttpError } from "../portal/http";
import { listDeadlines, listUpcoming } from "../tasks/views";
import { activity } from "./access";

interface CustomRow {
    id: string;
    owner_email: string;
    kind: CustomDate["kind"];
    name: string;
    start_date: string;
    end_date: string;
    region: string | null;
    school: string | null;
    scope: "personal" | "household";
}

/** The caller's own custom dates and everyone's household ones. */
export async function listCustomDates(db: D1Database, user: PortalUser): Promise<CustomDate[]> {
    const rows = await db
        .prepare(
            "SELECT id, owner_email, kind, name, start_date, end_date, region, school, scope FROM calendar_custom_dates WHERE owner_email = ? OR scope = 'household' ORDER BY start_date LIMIT 2000",
        )
        .bind(user.email)
        .all<CustomRow>();
    return rows.results.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        start: r.start_date,
        end: r.end_date,
        region: r.region,
        school: r.school,
        scope: r.scope,
        mine: r.owner_email === user.email,
    }));
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-18");
const customInput = z
    .object({
        kind: z.enum(CUSTOM_DATE_KINDS),
        name: z.string().trim().min(1).max(120),
        start: date,
        end: date,
        region: z.string().trim().max(80).nullish(),
        school: z.string().trim().max(120).nullish(),
        scope: z.enum(["personal", "household"]).default("personal"),
    })
    .strict();

export async function createCustomDate(db: D1Database, user: PortalUser, input: unknown) {
    const body = customInput.parse(input);
    if (body.end < body.start) throw new ValidationError("It ends before it starts", "end");
    if (daysBetween(body.start, body.end) > 366) throw new ValidationError("A custom date can cover at most a year", "end");
    const id = newId("ccd");
    const now = nowIso();
    await db.batch([
        db
            .prepare(
                "INSERT INTO calendar_custom_dates (id, owner_email, kind, name, start_date, end_date, region, school, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(id, user.email, body.kind, body.name, body.start, body.end, body.region ?? null, body.school ?? null, body.scope, now, now),
        activity(db, { actor: user.email, action: "custom_date.create", entityType: "custom_date", entityId: id }),
    ]);
    return listCustomDates(db, user);
}

export async function deleteCustomDate(db: D1Database, user: PortalUser, id: string) {
    const result = await db.batch([
        db.prepare("DELETE FROM calendar_custom_dates WHERE id = ? AND owner_email = ?").bind(id, user.email),
        activity(db, { actor: user.email, action: "custom_date.delete", entityType: "custom_date", entityId: id }),
    ]);
    if (!result[0].meta.changes) throw new HttpError(404, "not_found", "Not found");
    return listCustomDates(db, user);
}

/** Open tasks due (or with a deadline, or milestones) in a window, as Tasks shows them to the caller. */
export async function taskOverlays(db: D1Database, user: PortalUser, from: string, to: string, today: string): Promise<TaskOverlay[]> {
    if (!can(user, "tasks.use")) return [];
    const [due, deadlines] = await Promise.all([listUpcoming(db, user.email, from, to, today), listDeadlines(db, user.email, from, to)]);
    const names = await projectNames({ db, user } as Parameters<typeof projectNames>[0], [...due, ...deadlines]);
    const out: TaskOverlay[] = [];
    for (const t of due)
        if (t.dueDate)
            out.push({
                id: t.id,
                title: t.title,
                date: t.dueDate,
                time: t.dueTime,
                kind: t.isMilestone ? "milestone" : "due",
                projectName: names.get(t.projectId) ?? "",
                priority: t.priority,
            });
    for (const t of deadlines)
        if (t.deadline)
            out.push({
                id: t.id,
                title: t.title,
                date: t.deadline,
                time: null,
                kind: "deadline",
                projectName: names.get(t.projectId) ?? "",
                priority: t.priority,
            });
    return out.slice(0, 500);
}

/** Leave (the caller's, and what others share) overlapping a window. Scenario and cancelled leave never show. */
export function leaveOverlays(leave: LeaveData, from: string, to: string, includeShared: boolean): Overlays["leave"] {
    const types = new Map(leave.types.map((t) => [t.id, t]));
    const mine = leave.bookings
        .filter((b) => !b.scenarioId && b.status !== "cancelled" && b.status !== "draft" && b.endDate >= from && b.startDate <= to)
        .map((b) => ({
            id: b.id,
            start: b.startDate,
            end: b.endDate,
            status: b.status,
            typeName: b.title || types.get(b.leaveTypeId)?.name || "Leave",
            color: types.get(b.leaveTypeId)?.color ?? "blue",
            owner: null,
        }));
    const shared = includeShared
        ? leave.sharedWithMe.flatMap((s) =>
              s.bookings
                  .filter((b) => b.endDate >= from && b.startDate <= to)
                  .map((b) => ({ id: b.id, start: b.startDate, end: b.endDate, status: b.status, typeName: "Leave", color: "gray" as const, owner: s.owner })),
          )
        : [];
    return [...mine, ...shared];
}

/** Every overlay for a window, according to the person's overlay choices. */
export async function overlaysFor(
    db: D1Database,
    user: PortalUser,
    prefs: CalendarPreferences,
    leave: LeaveData,
    from: string,
    to: string,
    today: string,
): Promise<Overlays> {
    const o = prefs.overlays;
    return {
        holidays: o.holidays ? holidayOverlays(from, to, leave.profile.settings, leave.customDates) : [],
        school: o.school ? schoolOverlays(from, to, prefs.schoolDivision, leave.customDates) : [],
        tasks: o.tasks ? await taskOverlays(db, user, from, addDays(to, 0), today) : [],
        leave: o.leave ? leaveOverlays(leave, from, to, o.sharedLeave) : [],
        nonWorking: leave.customDates
            .filter((d) => d.kind === "non_working" && d.mine && d.end >= from && d.start <= to)
            .map((d) => ({ id: d.id, kind: d.kind, name: d.name, start: d.start, end: d.end })),
    };
}
