// Chief of Staff briefings: a daily briefing and a weekly review, built from what Daly Tasks and
// Daly Knowledge record for one person, in their time zone, through their own memberships.
//
// Facts and recommendations are kept apart. Facts are records (each with its id and link), the
// same numbers the person's own dashboards show. Recommendations are optional model suggestions,
// only ever about those facts: every reference a model returns must be one of the briefing's own
// ids, or it's dropped. A briefing says what it read and what it never did (email, calendars,
// banking: there are no such integrations), so it can't imply it checked them.
//
// Cost: facts cost a handful of D1 reads and no inference. Recommendations are generated only when
// asked for (a button, or the person's scheduled preparation) and then reused while the facts'
// fingerprint is unchanged, so opening the page again, or a cron run with nothing new, costs nothing.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { BRIEFING_SECTION_LABELS, type BriefingSection, type IntelligenceConfig, type IntelligencePreferences } from "../../src/shared/intelligence/config";
import type { BriefingFactSection, BriefingItem, BriefingView, Recommendation } from "../../src/shared/intelligence/types";
import { spaceToday } from "../knowledge/daily";
import type { PortalUser } from "../../src/shared/portal/types";
import { addDays, localDate } from "../../src/shared/tasks/dates";
import { EMPTY_FILTER } from "../../src/shared/tasks/filters";
import type { TaskSummary } from "../../src/shared/tasks/types";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { newId, nowIso, parseJson, placeholders } from "../portal/db";
import { preferences as taskPreferences, todayFor } from "../tasks/access";
import { householdDashboard, personalDashboard } from "../tasks/dashboard";
import { measureProjects } from "../tasks/health";
import { listProjects } from "../tasks/projects";
import { completedBetween, filterTasks, listDeadlines, listOverdue, listUpcoming } from "../tasks/views";
import { type JobContext, type StepResult, enqueue } from "./jobs";
import { BRIEFING_SYSTEM, fence } from "./prompts";
import { AiError, generateJson } from "./provider";
import { availability, loadConfig, loadPreferences } from "./settings";
import { sha256 } from "./semantic";
import { BudgetExceeded } from "./usage";

export const NOT_CHECKED = ["email", "calendar", "bank accounts and finances", "any external service"];
const SHOWN = 8;

const taskItem = (site: string, t: TaskSummary, detail?: string): BriefingItem => ({ id: t.id, title: t.title, url: `${site}/portal/tasks/t/${t.id}`, kind: "task", ...(detail ? { detail } : {}) });

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const dueDetail = (t: TaskSummary, today: string) => {
    const date = t.dueDate && (!t.deadline || t.dueDate <= t.deadline) ? t.dueDate : t.deadline;
    if (!date) return undefined;
    const n = days(today, date);
    const what = t.deadline === date && t.dueDate !== date ? "Deadline" : "Due";
    return n === 0 ? `${what} today` : n < 0 ? `${-n} day${n === -1 ? "" : "s"} overdue` : n === 1 ? `${what} tomorrow` : `${what} ${date}`;
};

const section = (key: BriefingFactSection["key"], title: string, items: BriefingItem[], count = items.length): BriefingFactSection => ({ key, title, count, items: items.slice(0, SHOWN) });

/** Knowledge the person can read, in the spaces their preferences include, updated in a window. */
async function knowledgeIn(db: D1Database, user: PortalUser, prefs: IntelligencePreferences, site: string, from: string, to: string | null, typeSlug?: string) {
    const spaces = await db
        .prepare(`SELECT s.id, s.kind FROM knowledge_spaces s JOIN knowledge_memberships m ON m.space_id = s.id AND m.email = ?`)
        .bind(user.email)
        .all<{ id: string; kind: string }>();
    const ids = spaces.results.filter((s) => (prefs.scope === "all" || s.kind === "personal") && !prefs.excludedSpaceIds.includes(s.id)).map((s) => s.id);
    if (!ids.length) return { count: 0, items: [] as BriefingItem[] };
    const where = [`o.space_id IN (${placeholders(ids.length)})`, "o.status = 'active'", "o.updated_at >= ?"];
    const binds: unknown[] = [...ids, from];
    if (to) (where.push("o.updated_at < date(?, '+1 day')"), binds.push(to));
    if (typeSlug) (where.push("t.slug = ?"), binds.push(typeSlug));
    const rows = await db
        .prepare(
            `SELECT o.id, o.title, o.updated_at, t.name AS type, COUNT(*) OVER () AS total FROM knowledge_objects o JOIN knowledge_object_types t ON t.id = o.type_id
             WHERE ${where.join(" AND ")} ORDER BY o.updated_at DESC LIMIT ${SHOWN}`,
        )
        .bind(...binds)
        .all<{ id: string; title: string; updated_at: string; type: string; total: number }>();
    return {
        count: rows.results[0]?.total ?? 0,
        items: rows.results.map((r): BriefingItem => ({ id: r.id, title: r.title || "Untitled", url: `${site}/portal/knowledge/o/${r.id}`, kind: "knowledge", detail: r.type })),
    };
}

/** The facts for one briefing. No model, no writes. */
export async function briefingFacts(env: Env, user: PortalUser, kind: "daily" | "weekly", prefs: IntelligencePreferences, site: string, periodOverride?: string) {
    const db = env.DB;
    const want = new Set<BriefingSection>(prefs.sections);
    const sections: BriefingFactSection[] = [];
    const tasks = can(user, "tasks.use");
    const knowledge = can(user, "knowledge.use");
    let today = new Date().toISOString().slice(0, 10);
    if (tasks) today = await todayFor(db, user.email);
    else if (knowledge) today = spaceToday({ time_zone: "Australia/Sydney" });
    const period = periodOverride ?? today;

    let kinds = new Map<string, "personal" | "shared">();
    const inScope = (t: TaskSummary) => prefs.scope === "all" || kinds.get(t.projectId) !== "shared";

    if (tasks) {
        const timeZone = (await taskPreferences(db, user.email)).timeZone;
        kinds = new Map((await listProjects(db, user.email, today)).map((p) => [p.id, p.kind]));
        const waiting = async () =>
            (await filterTasks(db, user.email, { ...EMPTY_FILTER, labels: ["waiting"], status: "open" }, today, { limit: 50, offset: 0 })).tasks.filter(inScope);
        const followUps = async () =>
            (await filterTasks(db, user.email, { ...EMPTY_FILTER, labels: ["follow-up", "follow up", "followup"], labelMode: "any", status: "open" }, today, { limit: 50, offset: 0 })).tasks.filter(inScope);

        if (kind === "daily") {
            const mine = await personalDashboard(db, user);
            if (want.has("today")) {
                const list = mine.dueToday.tasks.filter(inScope);
                sections.push(section("today", BRIEFING_SECTION_LABELS.today, list.map((t) => taskItem(site, t, dueDetail(t, today))), mine.dueToday.count));
            }
            if (want.has("overdue")) {
                const list = mine.overdue.tasks.filter(inScope);
                sections.push(section("overdue", BRIEFING_SECTION_LABELS.overdue, list.map((t) => taskItem(site, t, dueDetail(t, today))), mine.overdue.count));
            }
            if (want.has("deadlines")) {
                const list = (await listDeadlines(db, user.email, addDays(today, 1), addDays(today, 14))).filter(inScope);
                sections.push(section("deadlines", BRIEFING_SECTION_LABELS.deadlines, list.map((t) => taskItem(site, t, dueDetail(t, today)))));
            }
            if (want.has("projects")) {
                const list = mine.projects.filter((p) => p.health.status !== "on_track" && (prefs.scope === "all" || p.kind === "personal"));
                sections.push(
                    section(
                        "projects",
                        BRIEFING_SECTION_LABELS.projects,
                        list.map((p) => ({ id: p.id, title: p.name, url: `${site}/portal/tasks/p/${p.id}`, kind: "project", detail: p.health.reasons[0]?.text ?? p.health.status.replace("_", " ") })),
                    ),
                );
            }
            if (want.has("follow_ups")) sections.push(section("follow_ups", BRIEFING_SECTION_LABELS.follow_ups, (await followUps()).map((t) => taskItem(site, t, dueDetail(t, today)))));
            if (want.has("waiting")) sections.push(section("waiting", BRIEFING_SECTION_LABELS.waiting, (await waiting()).map((t) => taskItem(site, t, dueDetail(t, today)))));
            if (want.has("household") && prefs.scope === "all") {
                const household = await householdDashboard(db, user, "all");
                if (household.projectCount > 0)
                    sections.push(section("household", BRIEFING_SECTION_LABELS.household, household.attention.tasks.map((t) => taskItem(site, t, dueDetail(t, today))), household.attention.count));
            }
        } else {
            const start = addDays(period, -6);
            const [completed, overdue, upcoming, measured] = await Promise.all([
                completedBetween(db, user.email, start, period),
                listOverdue(db, user.email, today),
                listUpcoming(db, user.email, addDays(today, 1), addDays(today, 14), today),
                measureProjects(db, user.email, today, timeZone),
            ]);
            const active = measured.filter((p) => p.status === "active" && (prefs.scope === "all" || p.kind === "personal"));
            sections.push(section("completed", "Completed this week", completed.filter(inScope).map((t) => taskItem(site, t))));
            sections.push(
                section(
                    "at_risk",
                    "Projects at risk",
                    active
                        .filter((p) => p.health.status === "at_risk")
                        .map((p) => ({ id: p.id, title: p.name, url: `${site}/portal/tasks/p/${p.id}`, kind: "project", detail: p.health.reasons[0]?.text })),
                ),
            );
            const quiet = addDays(today, -14);
            sections.push(
                section(
                    "stale",
                    "Projects without recent activity",
                    active
                        .filter((p) => !p.metrics.lastActivityAt || p.metrics.lastActivityAt.slice(0, 10) < quiet)
                        .map((p) => ({ id: p.id, title: p.name, url: `${site}/portal/tasks/p/${p.id}`, kind: "project", detail: p.metrics.lastActivityAt ? `Last activity ${p.metrics.lastActivityAt.slice(0, 10)}` : "No activity yet" })),
                ),
            );
            if (want.has("overdue")) sections.push(section("overdue", BRIEFING_SECTION_LABELS.overdue, overdue.filter(inScope).map((t) => taskItem(site, t, dueDetail(t, today)))));
            sections.push(section("milestones", "Upcoming milestones", upcoming.filter((t) => t.isMilestone && inScope(t)).map((t) => taskItem(site, t, dueDetail(t, today)))));
            if (want.has("waiting")) sections.push(section("waiting", BRIEFING_SECTION_LABELS.waiting, (await waiting()).map((t) => taskItem(site, t, dueDetail(t, today)))));
            const mine = await personalDashboard(db, user);
            const housekeeping: BriefingItem[] = [
                ...(mine.inbox.count ? [{ id: "housekeeping:inbox", title: `${mine.inbox.count} unsorted in your Tasks Inbox`, url: `${site}/portal/tasks/inbox`, kind: "task" as const }] : []),
                ...mine.reviewsDue.map((r) => ({ id: r.projectId, title: `Review due: ${r.name}`, url: `${site}/portal/tasks/p/${r.projectId}`, kind: "project" as const, detail: r.due })),
            ];
            sections.push(section("housekeeping", "Housekeeping", housekeeping));
        }
    }
    if (knowledge) {
        if (kind === "daily") {
            if (want.has("decisions")) {
                const found = await knowledgeIn(db, user, prefs, site, addDays(today, -14), null, "decision");
                sections.push(section("decisions", BRIEFING_SECTION_LABELS.decisions, found.items, found.count));
            }
            if (want.has("knowledge")) {
                const found = await knowledgeIn(db, user, prefs, site, addDays(today, -1), null);
                sections.push(section("knowledge", BRIEFING_SECTION_LABELS.knowledge, found.items, found.count));
            }
        } else {
            const start = addDays(period, -6);
            const updated = await knowledgeIn(db, user, prefs, site, start, period);
            const meetings = await knowledgeIn(db, user, prefs, site, start, period, "meeting");
            const decisions = await knowledgeIn(db, user, prefs, site, start, period, "decision");
            sections.push(section("knowledge", "Knowledge updated this week", updated.items, updated.count));
            sections.push(section("decisions", "Meetings and decisions", [...meetings.items, ...decisions.items], meetings.count + decisions.count));
        }
    }
    return { period, today, sections, checked: { tasks, knowledge } };
}

// --- Recommendations -------------------------------------------------------------------------------

const recommendationSchema = z.object({
    recommendations: z.array(z.object({ text: z.string().min(1).max(400), refs: z.array(z.string().max(80)).max(6).default([]) })).max(10),
});

/** Model suggestions about the facts. Any reference that isn't one of the facts is dropped. */
export async function recommend(env: Env, config: IntelligenceConfig, user: PortalUser, prefs: IntelligencePreferences, sections: BriefingFactSection[]): Promise<{ items: Recommendation[]; model: string }> {
    const facts = sections.flatMap((s) => s.items.map((i) => ({ ...i, section: s.title })));
    const byId = new Map(facts.map((f) => [f.id, f]));
    const lines = facts.map((f) => `[${f.id}] ${f.section}: ${f.title}${f.detail ? ` (${f.detail})` : ""}`).join("\n");
    const { value, model } = await generateJson(
        { env, config, email: user.email, feature: "briefings" },
        { role: prefs.mode === "detailed" ? "synthesis" : "summarise", system: BRIEFING_SYSTEM(prefs.mode), prompt: fence("facts", lines || "(no facts)", 8_000), maxTokens: 600, schema: recommendationSchema },
    );
    const items = value.recommendations
        .map((r) => ({ text: r.text.trim(), refs: [...new Set(r.refs)].filter((id) => byId.has(id)).map((id) => ({ id, title: byId.get(id)!.title, url: byId.get(id)!.url })) }))
        .filter((r) => r.text && r.refs.length > 0)
        .slice(0, prefs.mode === "concise" ? 3 : 6);
    return { items, model };
}

// --- Stored briefings ------------------------------------------------------------------------------

interface BriefingRow {
    id: string;
    period: string;
    facts: string;
    fingerprint: string;
    recommendations: string | null;
    model: string | null;
    status: string;
    generated_at: string;
}

const itemIds = (sections: BriefingFactSection[]) => new Set(sections.flatMap((s) => s.items.map((i) => i.id)));

export async function getBriefing(
    env: Env,
    user: PortalUser,
    kind: "daily" | "weekly",
    options: { site: string; recommend?: boolean; period?: string } = { site: "" },
): Promise<BriefingView> {
    const db = env.DB;
    const { config } = await loadConfig(db);
    const { preferences: prefs } = await loadPreferences(db, user.email);
    const facts = await briefingFacts(env, user, kind, prefs, options.site, options.period);
    const fingerprint = await sha256(JSON.stringify(facts.sections.map((s) => [s.key, s.count, s.items.map((i) => `${i.id}:${i.detail ?? ""}`)])));
    const stored = await db.prepare("SELECT * FROM ai_briefings WHERE email = ? AND kind = ? AND period = ?").bind(user.email, kind, facts.period).first<BriefingRow>();
    const previous = await db
        .prepare("SELECT period, facts FROM ai_briefings WHERE email = ? AND kind = ? AND period < ? ORDER BY period DESC LIMIT 1")
        .bind(user.email, kind, facts.period)
        .first<{ period: string; facts: string }>();

    const allowed = availability(env, config).recommendations && prefs.recommendations && prefs.sections.includes("suggestions");
    let recommendations: BriefingView["recommendations"] = { status: allowed ? "not_requested" : "off", items: [], model: null };
    let status = stored?.status ?? "facts_only";
    let saved = stored?.recommendations ?? null;
    let model = stored?.model ?? null;
    if (allowed && stored?.fingerprint === fingerprint && stored.recommendations) {
        recommendations = { status: "ready", items: parseJson<Recommendation[]>(stored.recommendations, []), model: stored.model };
    } else if (allowed && options.recommend) {
        try {
            const result = await recommend(env, config, user, prefs, facts.sections);
            recommendations = { status: "ready", items: result.items, model: result.model };
            saved = JSON.stringify(result.items);
            model = result.model;
            status = "ready";
        } catch (error) {
            if (!(error instanceof AiError || error instanceof BudgetExceeded)) throw error;
            recommendations = { status: error instanceof BudgetExceeded ? "budget" : "unavailable", items: [], model: null };
        }
    } else if (stored?.fingerprint !== fingerprint) {
        // The facts moved on: older recommendations no longer apply.
        saved = null;
        status = "facts_only";
    }

    await db
        .prepare(
            `INSERT INTO ai_briefings (id, email, kind, period, facts, fingerprint, recommendations, model, status, generated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(email, kind, period) DO UPDATE SET facts = ?5, fingerprint = ?6, recommendations = ?7, model = ?8, status = ?9, generated_at = ?10`,
        )
        .bind(newId("abr"), user.email, kind, facts.period, JSON.stringify(facts.sections), fingerprint, saved, model, status, nowIso())
        .run();

    let changes: BriefingView["changesSincePrevious"] = null;
    if (previous) {
        const before = itemIds(parseJson<BriefingFactSection[]>(previous.facts, []));
        const now = itemIds(facts.sections);
        changes = { previousPeriod: previous.period, added: [...now].filter((id) => !before.has(id)).length, resolved: [...before].filter((id) => !now.has(id)).length };
    }
    return {
        kind,
        period: facts.period,
        generatedAt: nowIso(),
        checked: facts.checked,
        notChecked: NOT_CHECKED,
        sections: facts.sections,
        recommendations,
        changesSincePrevious: changes,
    };
}

// --- Scheduled preparation -------------------------------------------------------------------------

/** "HH:MM" now in a time zone. */
const localClock = (timeZone: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
const localWeekday = (timeZone: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "short" }).format(new Date()));

/**
 * Queues briefings for people who opted in (saved preferences, not paused) once their preferred
 * time has passed today. The dedupe key makes it once per person, kind and day however often the
 * cron runs; nothing is queued while Intelligence or scheduled processing is off.
 */
export async function scheduleBriefings(env: Env, config: IntelligenceConfig): Promise<number> {
    if (!availability(env, config).scheduled) return 0;
    const people = await env.DB.prepare("SELECT email, value FROM ai_preferences LIMIT 50").all<{ email: string; value: string }>();
    let queued = 0;
    for (const person of people.results) {
        const { preferences: prefs } = await loadPreferences(env.DB, person.email);
        if (prefs.paused) continue;
        const timeZone = (await taskPreferences(env.DB, person.email)).timeZone;
        const today = localDate(new Date(), timeZone);
        const clock = localClock(timeZone);
        const due: ("daily" | "weekly")[] = [];
        if (clock >= prefs.dailyTime) due.push("daily");
        if (localWeekday(timeZone) === prefs.weeklyDay && clock >= prefs.weeklyTime) due.push("weekly");
        for (const kind of due) {
            const done = await env.DB.prepare("SELECT 1 FROM ai_briefings WHERE email = ? AND kind = ? AND period = ? AND notified_at IS NOT NULL").bind(person.email, kind, today).first();
            if (done) continue;
            const { existing } = await enqueue(env.DB, { email: person.email, kind: "briefing.prepare", subjectId: `${kind}:${today}`, dedupeKey: `briefing:${person.email}:${kind}:${today}`, maxAttempts: 2 });
            if (!existing) queued++;
        }
    }
    return queued;
}

export function briefingJob(site: string) {
    return async (ctx: JobContext): Promise<StepResult> => {
        const [kind, period] = ctx.job.subject_id.split(":") as ["daily" | "weekly", string];
        const view = await getBriefing(ctx.env, ctx.user, kind, { site, recommend: true, period });
        await ctx.env.DB.prepare("UPDATE ai_briefings SET notified_at = ? WHERE email = ? AND kind = ? AND period = ?").bind(nowIso(), ctx.user.email, kind, view.period).run();
        return { status: "done" };
    };
}
