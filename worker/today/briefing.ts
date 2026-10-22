// Today's Chief of Staff briefing: facts from the person's own Portal records, through each
// application's access rules, with a link to every one. Nothing is inferred or invented. There's no
// model here: the recommended next actions come from fixed rules over the facts (src/shared/today/
// engine.ts), and each names the records it's about. Daly Intelligence can explain the day on top of
// this (its daily briefing, where every reference a model returns must be one of the facts), but it
// never supplies meetings or availability.
//
// Event titles follow Calendar's rules for anything an assistant can read: others' private events
// are "Busy" and sensitive ones "Private event".
import { dayLabel, timeLabel, zonedInstant } from "../../src/shared/calendar/time";
import { nextActions } from "../../src/shared/today/engine";
import type { BriefingRef, CommitmentItem, TodayBriefing } from "../../src/shared/today/types";
import type { planPart } from "./dashboard";
import { eventTitle } from "./window";

export const TODAY_NOT_CHECKED = ["email", "messages", "bank accounts and finances", "any service outside the Daly Portal"];

export function todayBriefing(input: {
    date: string;
    today: string;
    now: number;
    plan: Awaited<ReturnType<typeof planPart>>;
    family: CommitmentItem[];
}): TodayBriefing {
    const { date, today, plan } = input;
    const { w } = plan;

    const commitments: (BriefingRef & { start: string })[] = w.occurrences
        .filter((o) => o.status !== "cancelled")
        .map((o) => ({
            id: o.id,
            title: eventTitle(o),
            url: `/portal/calendar?view=day&date=${o.startDate}&event=${o.eventId}`,
            kind: "event" as const,
            detail: o.allDay ? "All day" : `${timeLabel(o.startTime ?? "00:00")} – ${timeLabel(o.endTime ?? "23:59")}`,
            start: o.allDay ? zonedInstant(date, "00:00", w.timeZone) : o.start,
        }))
        .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));

    const conflicts: BriefingRef[] = plan.capacity.overbooked.map((o) => ({
        id: `overbooked:${o.start}`,
        title: `Overbooked ${timeLabel(o.startTime)}–${timeLabel(o.endTime)}: ${o.with.map((x) => x.title).join(", ")}`,
        url: `/portal/today?date=${date}#timeline`,
        kind: "conflict" as const,
    }));

    const next = commitments.find((c) => Date.parse(c.start) >= input.now) ?? null;
    const actions = nextActions({
        isToday: date === today,
        now: input.now,
        conflicts,
        freeMinutes: plan.capacity.freeMinutes,
        availableMinutes: plan.capacity.availableMinutes,
        nextCommitment: next,
    });

    return {
        date,
        generatedAt: new Date(input.now).toISOString(),
        commitments: commitments.map(({ start: _start, ...c }) => c).slice(0, 15),
        conflicts: conflicts.slice(0, 10),
        capacity: {
            availableMinutes: plan.capacity.availableMinutes,
            committedMinutes: plan.capacity.appointmentMinutes,
            freeMinutes: plan.capacity.freeMinutes,
            status: plan.capacity.status,
        },
        family: input.family.slice(0, 8).map((f) => ({
            id: f.id,
            title: f.title,
            url: f.url,
            kind: "event" as const,
            detail: `${f.date === date ? "Today" : dayLabel(f.date)}, ${f.when} · ${f.calendarName}`,
        })),
        nextActions: actions,
        notChecked: TODAY_NOT_CHECKED,
    };
}
