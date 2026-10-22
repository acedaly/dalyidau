// MCP tools for Today (docs/DAILY_PLANNER.md#today): the day's summary, capacity and the Chief of
// Staff briefing. All read-only: they need Calendar, read through the same functions as the portal
// page, and never write. To add an appointment an assistant uses calendar_create_event, with its own
// checks, ledger and audit.
import { z } from "zod";
import { timeLabel } from "../../src/shared/calendar/time";
import type { BriefingRef, TimelineItem } from "../../src/shared/today/types";
import { todayDashboard } from "../today/dashboard";
import { type ToolContext, type ToolDef, calendarDate, portalUrl, tool } from "./shared";

const dayInput = z.object({ date: calendarDate.optional() }).strict();
const clock = (t: string) => timeLabel(t === "24:00" ? "23:59" : t);
const refOut = (ctx: ToolContext, r: BriefingRef) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    ...(r.detail ? { detail: r.detail } : {}),
    url: portalUrl(ctx, r.url),
});

const itemOut = (ctx: ToolContext, i: TimelineItem) => ({
    kind: i.kind,
    title: i.title,
    when: `${clock(i.startTime)} – ${clock(i.endTime)}`,
    minutes: i.minutes,
    readOnly: i.readOnly,
    countsAsBusy: i.busy,
    shared: i.shared,
    conflict: i.conflict,
    ...(i.url && i.kind !== "free" ? { url: portalUrl(ctx, i.url) } : {}),
});

const getSummary = tool({
    name: "today_get_summary",
    write: false,
    permission: "calendar.use",
    input: dayInput,
    run: async (ctx, input) => {
        const d = await todayDashboard(ctx.db, ctx.user, { date: input.date, parts: ["plan", "notifications"], audience: "assistant" });
        return {
            data: {
                date: d.date,
                today: d.today,
                timeZone: d.timeZone,
                capacity: { status: d.capacity!.status, availableMinutes: d.capacity!.availableMinutes, freeMinutes: d.capacity!.freeMinutes },
                timeline: d
                    .timeline!.items.filter((i) => i.kind !== "free")
                    .slice(0, 40)
                    .map((i) => itemOut(ctx, i)),
                allDay: d.timeline!.allDay.map((a) => ({ title: a.title, kind: a.kind })),
                notifications: d.notifications!.slice(0, 10).map((n) => ({ source: n.source, title: n.title, at: n.at })),
                url: portalUrl(ctx, `/portal/today?date=${d.date}`),
            },
        };
    },
});

const getCapacity = tool({
    name: "today_get_capacity",
    write: false,
    permission: "calendar.use",
    input: dayInput,
    run: async (ctx, input) => {
        const d = await todayDashboard(ctx.db, ctx.user, { date: input.date, parts: ["plan"], audience: "assistant" });
        const c = d.capacity!;
        return {
            data: {
                timeZone: d.timeZone,
                ...c,
                overbooked: c.overbooked.map((o) => ({
                    when: `${clock(o.startTime)} – ${clock(o.endTime)}`,
                    minutes: o.minutes,
                    with: o.with.map((w) => ({ title: w.title })),
                })),
                note: "Worked out by the portal from working hours, breaks, leave, holidays and calendar events, with overlaps counted once. Report it as given.",
            },
        };
    },
});

const getBriefing = tool({
    name: "today_get_briefing",
    write: false,
    permission: "calendar.use",
    input: dayInput,
    run: async (ctx, input) => {
        const d = await todayDashboard(ctx.db, ctx.user, { date: input.date, parts: ["briefing"], audience: "assistant" });
        const b = d.briefing!;
        const refs = (list: BriefingRef[]) => list.map((r) => refOut(ctx, r));
        return {
            data: {
                date: b.date,
                commitments: refs(b.commitments),
                conflicts: refs(b.conflicts),
                capacity: b.capacity,
                familyCommitments: refs(b.family),
                recommendedNextActions: b.nextActions.map((a) => ({ text: a.text, refs: refs(a.refs) })),
                notChecked: b.notChecked,
                note: "Facts from the person's Portal records, each with a link. Explain or summarise them, but never add meetings or availability that aren't here.",
                url: portalUrl(ctx, `/portal/today?date=${b.date}`),
            },
        };
    },
});

export const TODAY_TOOLS: ToolDef[] = [getSummary, getCapacity, getBriefing];
