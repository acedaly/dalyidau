// Chief of Staff context for AI clients: bounded, permission-scoped snapshots of what is recorded in
// Daly Tasks, Daly Knowledge and Daly Calendar. They are facts only. Nothing here is inferred, summarised by a
// model or made up: every item carries its id and a link to the record, a source that wasn't
// checked is listed as not checked, and a module the caller can't use is simply absent. The AI
// client does the reasoning.
//
// Everything reuses the portal's own dashboards and lists (worker/tasks/dashboard.ts and friends),
// so counts here match what each person sees on their own dashboard, in their own time zone.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import type { DocNode } from "../../src/shared/knowledge/content";
import { documentToMarkdown } from "../../src/shared/knowledge/markdown";
import type { KnowledgeObjectSummary } from "../../src/shared/knowledge/types";
import { addDays } from "../../src/shared/tasks/dates";
import type { Bucket, ProjectCard, TaskGoal, TaskRoutine } from "../../src/shared/tasks/productivity";
import { calendarFacts } from "../calendar/chief";
import { dailyNote, spaceToday } from "../knowledge/daily";
import { listObjects } from "../knowledge/objects";
import { can } from "../portal/auth";
import { preferences, todayFor } from "../tasks/access";
import { householdDashboard, personalDashboard } from "../tasks/dashboard";
import { listGoals } from "../tasks/goals";
import { measureProjects } from "../tasks/health";
import { listRoutines } from "../tasks/routines";
import { completedBetween, listDeadlines, listOverdue, listUpcoming } from "../tasks/views";
import { summaryOut, typeNames } from "./knowledge";
import { type ToolContext, type ToolDef, calendarDate, portalUrl, projectNames, taskList, taskOut, tool } from "./shared";

/** Items shown per list; every list also says how many there are in total. */
const SHOWN = 10;
/** Sources these tools never look at, named so a briefing can't imply they were checked. */
const NOT_CHECKED = ["email", "external calendars not subscribed in Daly Calendar", "DalyHub (retired: never read, and not available through this connector)"];

const bucketOut = async (ctx: ToolContext, bucket: Bucket) => {
    const names = await projectNames(ctx, bucket.tasks);
    return { count: bucket.count, tasks: bucket.tasks.slice(0, SHOWN).map((t) => taskOut(ctx, t, names)) };
};

const projectCardOut = (ctx: ToolContext, p: ProjectCard) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    open: p.open,
    overdue: p.overdue,
    targetDate: p.targetDate,
    health: p.health.status,
    reasons: p.health.reasons.map((r) => r.text),
    url: portalUrl(ctx, `/portal/tasks/p/${p.id}`),
});

const goalOut = (ctx: ToolContext, g: TaskGoal) => ({
    id: g.id,
    title: g.title,
    kind: g.kind,
    status: g.status,
    targetDate: g.targetDate,
    progress: g.progress,
    attention: g.attention,
    url: portalUrl(ctx, `/portal/tasks/goals/${g.id}`),
});

const routineOut = async (ctx: ToolContext, routines: TaskRoutine[]) => {
    const names = await projectNames(
        ctx,
        routines.map((r) => r.task),
    );
    return routines.slice(0, SHOWN).map((r) => ({ id: r.id, task: taskOut(ctx, r.task, names), responsible: r.responsible, nextUp: r.nextUp }));
};

/** Objects in the caller's spaces updated in a window (dates in each space's time zone), optionally of one type slug, newest first. */
async function recentObjects(ctx: ToolContext, db: D1Database, from: string, options: { to?: string; typeSlug?: string; max?: number } = {}) {
    const spaces = await db
        .prepare(
            "SELECT s.id, s.time_zone FROM knowledge_spaces s JOIN knowledge_memberships m ON m.space_id = s.id AND m.email = ? ORDER BY s.kind = 'personal' DESC LIMIT 10",
        )
        .bind(ctx.user.email)
        .all<{ id: string; time_zone: string }>();
    const found: KnowledgeObjectSummary[] = [];
    let total = 0;
    for (const space of spaces.results) {
        let typeId: string | null = null;
        if (options.typeSlug) {
            const type = await db
                .prepare("SELECT id FROM knowledge_object_types WHERE space_id = ? AND slug = ?")
                .bind(space.id, options.typeSlug)
                .first<{ id: string }>();
            if (!type) continue;
            typeId = type.id;
        }
        const page = await listObjects(
            db,
            space.id,
            {
                view: "all",
                typeId,
                tag: null,
                sort: "updated",
                links: "any",
                createdFrom: null,
                createdTo: null,
                updatedFrom: from,
                updatedTo: options.to ?? null,
            },
            { limit: options.max ?? SHOWN, offset: 0 },
            space.time_zone,
        );
        found.push(...page.objects);
        total += page.total;
    }
    found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const shown = found.slice(0, options.max ?? SHOWN);
    const types = await typeNames(
        ctx,
        shown.map((o) => o.spaceId),
    );
    return { count: total, objects: shown.map((o) => summaryOut(ctx, o, types)) };
}

/** The caller's personal daily note for a date, as recorded (or that there isn't one). */
async function personalDailyNote(ctx: ToolContext, date: string | null) {
    const space = await ctx.db
        .prepare("SELECT id, time_zone FROM knowledge_spaces WHERE kind = 'personal' AND personal_owner = ?")
        .bind(ctx.user.email)
        .first<{ id: string; time_zone: string }>();
    if (!space) return { exists: false, reason: "No personal Knowledge space yet" };
    const day = date ?? spaceToday(space);
    const note = await dailyNote(ctx.db, space.id, day);
    if (!note) return { date: day, exists: false };
    const markdown = documentToMarkdown(note.object.content as DocNode);
    return {
        date: day,
        exists: true,
        objectId: note.object.id,
        content: markdown.slice(0, 4_000),
        contentTruncated: markdown.length > 4_000,
        url: portalUrl(ctx, `/portal/knowledge/o/${note.object.id}`),
    };
}

const sources = (ctx: ToolContext) => ({
    tasks: can(ctx.user, "tasks.use"),
    knowledge: can(ctx.user, "knowledge.use"),
    calendar: can(ctx.user, "calendar.use"),
});

const chiefDaily = tool({
    name: "chief_of_staff_daily_context",
    write: false,
    permission: "any_productivity",
    input: z.object({}).strict(),
    run: async (ctx) => {
        const checked = sources(ctx);
        const data: Record<string, unknown> = { generatedAt: new Date().toISOString(), checked, notChecked: NOT_CHECKED };

        if (checked.tasks) {
            const prefs = await preferences(ctx.db, ctx.user.email);
            const today = await todayFor(ctx.db, ctx.user.email);
            const [mine, household] = await Promise.all([personalDashboard(ctx.db, ctx.user), householdDashboard(ctx.db, ctx.user, "all")]);
            data.tasks = {
                today,
                timeZone: prefs.timeZone,
                dueToday: await bucketOut(ctx, mine.dueToday),
                overdue: await bucketOut(ctx, mine.overdue),
                next7Days: await bucketOut(ctx, mine.next7),
                highPriority: await bucketOut(ctx, mine.highPriority),
                unsortedInbox: await bucketOut(ctx, mine.inbox),
                milestonesNext30Days: (await taskList(ctx, mine.milestones, SHOWN)).tasks,
                routinesDueThisWeek: await routineOut(ctx, mine.routines),
                reviewsDue: mine.reviewsDue.map((r) => ({ ...r, url: portalUrl(ctx, `/portal/tasks/p/${r.projectId}`) })),
                projectsNeedingAttention: mine.projects.filter((p) => p.health.status !== "on_track").map((p) => projectCardOut(ctx, p)),
                goals: mine.goals.map((g) => goalOut(ctx, g)),
                // Shared projects the caller is a member of. Nothing outside them is counted.
                household:
                    household.projectCount > 0
                        ? {
                              sharedProjects: household.projectCount,
                              needsAttention: await bucketOut(ctx, household.attention),
                              next14Days: await bucketOut(ctx, household.upcoming),
                              commitments: await bucketOut(ctx, household.commitments),
                              openByAssignee: household.byAssignee,
                              routines: await routineOut(ctx, household.routines),
                          }
                        : null,
            };
        }
        if (checked.knowledge) {
            const yesterday = addDays(new Date().toISOString().slice(0, 10), -1);
            data.knowledge = {
                dailyNote: await personalDailyNote(ctx, null),
                updatedSinceYesterday: await recentObjects(ctx, ctx.db, yesterday),
                decisionsLast14Days: await recentObjects(ctx, ctx.db, addDays(yesterday, -13), { typeSlug: "decision", max: 5 }),
            };
        }
        // Calendar and leave: what's on in the next week, clashes, important dates, leave and school holidays.
        if (checked.calendar) data.calendar = await calendarFacts(ctx.db, ctx.user, ctx.site, 7);
        return { data };
    },
});

const chiefWeekly = tool({
    name: "chief_of_staff_weekly_context",
    write: false,
    permission: "any_productivity",
    input: z.object({ weekEnding: calendarDate.optional() }).strict(),
    run: async (ctx, input) => {
        const checked = sources(ctx);
        const data: Record<string, unknown> = { generatedAt: new Date().toISOString(), checked, notChecked: NOT_CHECKED };
        let end = input.weekEnding ?? new Date().toISOString().slice(0, 10);

        if (checked.tasks) {
            const email = ctx.user.email;
            const prefs = await preferences(ctx.db, email);
            const today = await todayFor(ctx.db, email);
            end = input.weekEnding ?? today;
            const start = addDays(end, -6);
            const horizon = addDays(today, 14);
            const [completed, overdue, upcoming, deadlines, measured, goals, routines] = await Promise.all([
                completedBetween(ctx.db, email, start, end),
                listOverdue(ctx.db, email, today),
                listUpcoming(ctx.db, email, addDays(today, 1), horizon, today),
                listDeadlines(ctx.db, email, today, horizon),
                measureProjects(ctx.db, email, today, prefs.timeZone),
                listGoals(ctx.db, email, today, { activeOnly: true }),
                listRoutines(ctx.db, email, { dueBy: addDays(today, 7), includePaused: false, limit: 20 }),
            ]);
            const active = measured.filter((p) => p.status === "active");
            data.tasks = {
                today,
                timeZone: prefs.timeZone,
                period: { from: start, to: end },
                completed: await taskList(ctx, completed, 25),
                overdue: await taskList(ctx, overdue, 25),
                next14Days: await taskList(ctx, upcoming, 25),
                deadlinesNext14Days: await taskList(ctx, deadlines, 15),
                projects: active.slice(0, 30).map((p) => ({
                    id: p.id,
                    name: p.isInbox ? "Inbox" : p.name,
                    kind: p.kind,
                    health: p.health.status,
                    reasons: p.health.reasons.map((r) => r.text),
                    reviewDue: p.metrics.review.due,
                    url: portalUrl(ctx, `/portal/tasks/p/${p.id}`),
                })),
                goals: goals.slice(0, 20).map((g) => goalOut(ctx, g)),
                routinesDueNext7Days: await routineOut(ctx, routines),
            };
        }
        if (checked.knowledge) {
            const start = addDays(end, -6);
            data.knowledge = {
                period: { from: start, to: end },
                updatedInPeriod: await recentObjects(ctx, ctx.db, start, { to: end, max: 20 }),
                meetingsInPeriod: await recentObjects(ctx, ctx.db, start, { to: end, typeSlug: "meeting", max: 10 }),
                decisionsInPeriod: await recentObjects(ctx, ctx.db, start, { to: end, typeSlug: "decision", max: 10 }),
            };
        }
        if (checked.calendar) data.calendar = await calendarFacts(ctx.db, ctx.user, ctx.site, 14);
        // Possible follow-ups are for the AI client to propose from these facts, and to label as proposals.
        return { data };
    },
});

export const CHIEF_TOOLS: ToolDef[] = [chiefDaily, chiefWeekly];
