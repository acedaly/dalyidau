// Reports (/portal/tasks/reports): what was done over a period, and where things stand now.
//
// Built only from recorded history: task_completions (every completion and skip, with the date of
// the occurrence that was done). Projected repeats are never counted, undone completions never
// count, and "late" means completed after that occurrence's due date. Periods are the person's own
// weeks (Monday to Sunday) or months, in their time zone.
//
// Personal reports count the caller's own completions, on tasks they can still see. Shared reports
// count completions in shared projects the caller is a member of, by anyone in them. Nothing from
// anyone's personal projects is ever part of a shared report. Reads are bounded: a range is at most
// a year and at most REPORT_ROW_LIMIT completions are read (the report says if it was cut short).
// Counts aren't ranked by person: the shared report shows how open work is spread, not who did most.
import type { D1Database } from "@cloudflare/workers-types";
import { csvCell } from "../../src/shared/portal/csv";
import type { PortalUser } from "../../src/shared/portal/types";
import { addDays, localDate, zonedInstant } from "../../src/shared/tasks/dates";
import { REPORT_RANGES, REPORT_ROW_LIMIT, type ReportBucket, type ReportRange, type TasksReport, bucketStart } from "../../src/shared/tasks/productivity";
import { addMonths } from "../../src/shared/tasks/recurrence";
import type { Priority, TaskColor } from "../../src/shared/tasks/types";
import { preferences, todayFor } from "./access";
import { listGoals } from "./goals";
import { MINE, MY_DATED, NOT_PAUSED } from "./views";

const SHARED_OPEN = `p.kind = 'shared' AND p.status = 'active' AND t.status = 'open' AND ${NOT_PAUSED}`;

interface CompletionRow {
    kind: "completed" | "skipped";
    at: string;
    occurrence_date: string | null;
    task_id: string;
    title: string;
    project_id: string;
    project_name: string;
    project_color: TaskColor;
    repeating: number;
    is_routine: number;
}

export async function tasksReport(db: D1Database, user: PortalUser, scope: "personal" | "shared", range: ReportRange): Promise<TasksReport> {
    const email = user.email;
    const prefs = await preferences(db, email);
    const today = await todayFor(db, email);
    const days = REPORT_RANGES[range];
    const from = addDays(today, 1 - days);
    const grouping = days <= 84 ? "week" : "month";
    const fromInstant = zonedInstant(from, "00:00", prefs.timeZone);
    const toInstant = zonedInstant(addDays(today, 1), "00:00", prefs.timeZone);
    // Whose completions: the caller's own, or anyone's in the caller's shared projects.
    const who = scope === "personal" ? "c.by = ?1" : "p.kind = 'shared'";
    const rows = await db
        .prepare(
            `SELECT c.kind, c.at, c.occurrence_date, c.task_id, t.title, t.project_id, p.name AS project_name, p.color AS project_color,
                    t.recurrence_json IS NOT NULL AS repeating, EXISTS (SELECT 1 FROM task_routines r WHERE r.task_id = t.id) AS is_routine
             FROM task_completions c JOIN task_items t ON t.id = c.task_id
             JOIN task_project_members m ON m.project_id = t.project_id AND m.email = ?1 JOIN task_projects p ON p.id = t.project_id
             WHERE c.undone_at IS NULL AND c.at >= ?2 AND c.at < ?3 AND ${who} ORDER BY c.at LIMIT ${REPORT_ROW_LIMIT + 1}`,
        )
        .bind(email, fromInstant, toInstant)
        .all<CompletionRow>();
    const completions = rows.results.slice(0, REPORT_ROW_LIMIT);

    // Every period in the range, including empty ones, so a chart shows the gaps.
    const buckets = new Map<string, ReportBucket>();
    for (let start = bucketStart(from, grouping); start <= today; start = grouping === "week" ? addDays(start, 7) : addMonths(start, 1))
        buckets.set(start, { start, completed: 0, late: 0, skipped: 0 });
    const projects = new Map<string, { projectId: string; name: string; color: TaskColor; completed: number }>();
    const recurring = new Map<string, { taskId: string; title: string; completed: number; skipped: number; isRoutine: boolean }>();
    const totals = { completed: 0, late: 0, skipped: 0 };
    for (const c of completions) {
        const day = localDate(new Date(c.at), prefs.timeZone);
        const bucket = buckets.get(bucketStart(day, grouping));
        if (!bucket) continue;
        if (c.kind === "skipped") (bucket.skipped++, totals.skipped++);
        else {
            bucket.completed++;
            totals.completed++;
            if (c.occurrence_date && c.occurrence_date < day) (bucket.late++, totals.late++);
            const project = projects.get(c.project_id) ?? { projectId: c.project_id, name: c.project_name, color: c.project_color, completed: 0 };
            project.completed++;
            projects.set(c.project_id, project);
        }
        if (c.repeating) {
            const entry = recurring.get(c.task_id) ?? { taskId: c.task_id, title: c.title, completed: 0, skipped: 0, isRoutine: !!c.is_routine };
            if (c.kind === "skipped") entry.skipped++;
            else entry.completed++;
            recurring.set(c.task_id, entry);
        }
    }

    // Where things stand now, with the same scope as the lists.
    const open = scope === "personal" ? MY_DATED : SHARED_OPEN;
    const [priorities, overdue, assigned, goals] = await Promise.all([
        db.prepare(`SELECT t.priority, COUNT(*) AS n ${MINE} WHERE ${open} GROUP BY t.priority`).bind(email).all<{ priority: Priority; n: number }>(),
        db.prepare(`SELECT COUNT(*) AS n ${MINE} WHERE ${open} AND (t.due_date < ?2 OR t.deadline < ?2)`).bind(email, today).first<{ n: number }>(),
        scope === "shared"
            ? db
                  .prepare(
                      `SELECT t.assignee_email AS email, u.name, COUNT(*) AS open ${MINE} LEFT JOIN portal_users u ON u.email = t.assignee_email
                       WHERE ${SHARED_OPEN} GROUP BY t.assignee_email ORDER BY t.assignee_email IS NULL, t.assignee_email`,
                  )
                  .bind(email)
                  .all<{ email: string | null; name: string | null; open: number }>()
            : Promise.resolve({ results: [] as { email: string | null; name: string | null; open: number }[] }),
        listGoals(db, email, today, { kind: scope }),
    ]);
    const openByPriority: Record<Priority, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const r of priorities.results) openByPriority[r.priority] = r.n;

    return {
        scope,
        range,
        from,
        to: today,
        grouping,
        buckets: [...buckets.values()],
        totals: { ...totals, open: Object.values(openByPriority).reduce((a, b) => a + b, 0), overdue: overdue?.n ?? 0 },
        byProject: [...projects.values()].sort((a, b) => b.completed - a.completed).slice(0, 12),
        openByPriority,
        recurring: [...recurring.values()].sort((a, b) => b.completed + b.skipped - (a.completed + a.skipped)).slice(0, 20),
        assigned: assigned.results,
        goals,
        truncated: rows.results.length > REPORT_ROW_LIMIT,
    };
}

/**
 * The report as CSV: one row per figure, with a section column (period, project, priority, repeat,
 * person, goal). Formula-like cells are neutralised, like every portal export.
 */
export function reportCsv(report: TasksReport): string {
    const rows: (string | number | null)[][] = [["section", "key", "label", "completed", "late", "skipped", "open", "progress_percent"]];
    for (const b of report.buckets) rows.push(["period", b.start, `${report.grouping} from ${b.start}`, b.completed, b.late, b.skipped, null, null]);
    for (const p of report.byProject) rows.push(["project", p.projectId, p.name, p.completed, null, null, null, null]);
    for (const [priority, n] of Object.entries(report.openByPriority))
        rows.push(["priority", `P${priority}`, `Priority P${priority}`, null, null, null, n, null]);
    for (const r of report.recurring) rows.push(["repeat", r.taskId, r.title, r.completed, null, r.skipped, null, null]);
    for (const a of report.assigned) rows.push(["person", a.email ?? "", a.name ?? a.email ?? "Unassigned", null, null, null, a.open, null]);
    for (const g of report.goals) rows.push(["goal", g.id, g.title, null, null, null, null, g.progress.percent]);
    return "﻿" + rows.map((r) => r.map((cell) => csvCell(cell)).join(",")).join("\r\n") + "\r\n";
}
