// Chief of Staff briefings: a daily briefing and a weekly review, built from what Daly Calendar
// records for one person (their events, overlaps, important dates, leave, school holidays and failing
// subscriptions), in their time zone, through their own memberships.
//
// Facts and recommendations are kept apart. Facts are records (each with its id and link), the
// same ones the person's own Calendar shows. Recommendations are optional model suggestions, only
// ever about those facts: every reference a model returns must be one of the briefing's own ids, or
// it's dropped. A briefing says what it read and what it never did (email, banking: there are no
// such integrations), so it can't imply it checked them.
//
// Cost: facts cost a handful of D1 reads and no inference. Recommendations are generated only when
// asked for (a button, or the person's scheduled preparation) and then reused while the facts'
// fingerprint is unchanged, so opening the page again, or a cron run with nothing new, costs nothing.
import { z } from "zod";
import { localDate } from "../../src/shared/calendar/time";
import { BRIEFING_SECTION_LABELS, type IntelligenceConfig, type IntelligencePreferences } from "../../src/shared/intelligence/config";
import type { BriefingFactSection, BriefingItem, BriefingView, Recommendation } from "../../src/shared/intelligence/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { preferences as calendarPreferences, todayFor } from "../calendar/access";
import { calendarFacts } from "../calendar/chief";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { newId, nowIso, parseJson } from "../portal/db";
import { type JobContext, type StepResult, enqueue } from "./jobs";
import { BRIEFING_SYSTEM, fence } from "./prompts";
import { AiError, generateJson } from "./provider";
import { availability, loadConfig, loadPreferences } from "./settings";
import { BudgetExceeded } from "./usage";

export const NOT_CHECKED = ["email", "calendar", "bank accounts and finances", "any external service"];

const sha256 = async (text: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The facts for one briefing. No model, no writes. */
export async function briefingFacts(
    env: Env,
    user: PortalUser,
    kind: "daily" | "weekly",
    prefs: IntelligencePreferences,
    site: string,
    periodOverride?: string,
) {
    const db = env.DB;
    const sections: BriefingFactSection[] = [];
    const calendar = can(user, "calendar.use") && prefs.sections.includes("calendar");
    const today = can(user, "calendar.use") ? await todayFor(db, user.email) : new Date().toISOString().slice(0, 10);
    const period = periodOverride ?? today;
    // Calendar and leave (facts from worker/calendar/chief.ts: private events are "Busy", sensitive ones "Private event").
    if (calendar) {
        const facts = await calendarFacts(db, user, site, kind === "daily" ? 1 : 7);
        const items: BriefingItem[] = [
            ...facts.events.items.map((e) => ({ id: e.id, title: e.title, url: e.url, kind: "event" as const, detail: e.when })),
            ...facts.overlapping.map((o) => ({
                id: `${o.first.id}+${o.second.id}`,
                title: `Overlap: ${o.first.title} and ${o.second.title}`,
                url: o.first.url,
                kind: "event" as const,
                detail: o.first.when,
            })),
            ...facts.importantDates.map((e) => ({ id: `date:${e.id}`, title: e.title, url: e.url, kind: "event" as const, detail: e.when })),
            ...facts.plannedLeave.slice(0, 3).map((l) => ({ id: l.id, title: l.title, url: l.url, kind: "leave" as const, detail: `${l.when} (${l.status})` })),
            ...facts.schoolHolidays.periods
                .filter((p) => !p.leavePlanned)
                .map((p) => ({ id: p.id, title: `${p.title}: no leave planned`, url: p.url, kind: "leave" as const, detail: p.when })),
            ...facts.failingSubscriptions.map((s) => ({
                id: s.id,
                title: `Subscription failing: ${s.title}`,
                url: s.url,
                kind: "event" as const,
                detail: s.error ?? undefined,
            })),
        ];
        sections.push({ key: "calendar", title: BRIEFING_SECTION_LABELS.calendar, count: items.length, items: items.slice(0, 8) });
    }
    return { period, today, sections, checked: { calendar } };
}

// --- Recommendations -------------------------------------------------------------------------------

const recommendationSchema = z.object({
    recommendations: z.array(z.object({ text: z.string().min(1).max(400), refs: z.array(z.string().max(80)).max(6).default([]) })).max(10),
});

/** Model suggestions about the facts. Any reference that isn't one of the facts is dropped. */
export async function recommend(
    env: Env,
    config: IntelligenceConfig,
    user: PortalUser,
    prefs: IntelligencePreferences,
    sections: BriefingFactSection[],
): Promise<{ items: Recommendation[]; model: string }> {
    const facts = sections.flatMap((s) => s.items.map((i) => ({ ...i, section: s.title })));
    const byId = new Map(facts.map((f) => [f.id, f]));
    const lines = facts.map((f) => `[${f.id}] ${f.section}: ${f.title}${f.detail ? ` (${f.detail})` : ""}`).join("\n");
    const { value, model } = await generateJson(
        { env, config, email: user.email, feature: "briefings" },
        {
            role: prefs.mode === "detailed" ? "synthesis" : "summarise",
            system: BRIEFING_SYSTEM(prefs.mode),
            prompt: fence("facts", lines || "(no facts)", 8_000),
            maxTokens: 600,
            schema: recommendationSchema,
        },
    );
    const items = value.recommendations
        .map((r) => ({
            text: r.text.trim(),
            refs: [...new Set(r.refs)].filter((id) => byId.has(id)).map((id) => ({ id, title: byId.get(id)!.title, url: byId.get(id)!.url })),
        }))
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
    const stored = await db
        .prepare("SELECT * FROM ai_briefings WHERE email = ? AND kind = ? AND period = ?")
        .bind(user.email, kind, facts.period)
        .first<BriefingRow>();
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
        changes = {
            previousPeriod: previous.period,
            added: [...now].filter((id) => !before.has(id)).length,
            resolved: [...before].filter((id) => !now.has(id)).length,
        };
    }
    return {
        kind,
        period: facts.period,
        generatedAt: nowIso(),
        checked: facts.checked,
        notChecked: facts.checked.calendar ? NOT_CHECKED.filter((s) => s !== "calendar") : NOT_CHECKED,
        sections: facts.sections,
        recommendations,
        changesSincePrevious: changes,
    };
}

// --- Scheduled preparation -------------------------------------------------------------------------

/** "HH:MM" now in a time zone. */
const localClock = (timeZone: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
const localWeekday = (timeZone: string) =>
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "short" }).format(new Date()));

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
        const timeZone = (await calendarPreferences(env.DB, person.email)).timeZone;
        const today = localDate(new Date(), timeZone);
        const clock = localClock(timeZone);
        const due: ("daily" | "weekly")[] = [];
        if (clock >= prefs.dailyTime) due.push("daily");
        if (localWeekday(timeZone) === prefs.weeklyDay && clock >= prefs.weeklyTime) due.push("weekly");
        for (const kind of due) {
            const done = await env.DB.prepare("SELECT 1 FROM ai_briefings WHERE email = ? AND kind = ? AND period = ? AND notified_at IS NOT NULL")
                .bind(person.email, kind, today)
                .first();
            if (done) continue;
            const { existing } = await enqueue(env.DB, {
                email: person.email,
                kind: "briefing.prepare",
                subjectId: `${kind}:${today}`,
                dedupeKey: `briefing:${person.email}:${kind}:${today}`,
                maxAttempts: 2,
            });
            if (!existing) queued++;
        }
    }
    return queued;
}

export function briefingJob(site: string) {
    return async (ctx: JobContext): Promise<StepResult> => {
        const [kind, period] = ctx.job.subject_id.split(":") as ["daily" | "weekly", string];
        const view = await getBriefing(ctx.env, ctx.user, kind, { site, recommend: true, period });
        await ctx.env.DB.prepare("UPDATE ai_briefings SET notified_at = ? WHERE email = ? AND kind = ? AND period = ?")
            .bind(nowIso(), ctx.user.email, kind, view.period)
            .run();
        return { status: "done" };
    };
}
