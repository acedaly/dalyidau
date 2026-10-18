// Which holidays and non-working days apply to one person, from the official NSW data, their leave
// settings and their custom dates. Shared, so the browser's scenario planner and the Worker's
// forecasts (and the MCP tools) agree to the hour.
import type { LeaveContext, LeaveSettings, WorkPattern } from "./leave";
import { NSW_PUBLIC_HOLIDAYS, NSW_SCHOOL_PERIODS, type SchoolDivision, type SchoolPeriod, appliesTo } from "./nsw";
import { eachDate } from "./time";
import type { CustomDate, HolidayOverlay, SchoolOverlay } from "./types";

const sameRegion = (a: string | null, b: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** A custom regional holiday applies when it's your own, or a household one for your region (or for no region in particular). */
const regionalApplies = (d: CustomDate, settings: Pick<LeaveSettings, "region">) => d.mine || d.region === null || sameRegion(d.region, settings.region);

export function applicableHolidays(settings: Pick<LeaveSettings, "includeBankHoliday" | "region">, customDates: readonly CustomDate[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const h of NSW_PUBLIC_HOLIDAYS) if (h.kind !== "bank" || settings.includeBankHoliday) map.set(h.date, h.name);
    for (const d of customDates) {
        if (d.kind !== "regional_holiday" || !regionalApplies(d, settings)) continue;
        for (const date of eachDate(d.start, d.end, 60)) if (!map.has(date)) map.set(date, d.name);
    }
    return map;
}

export function leaveContext(
    pattern: WorkPattern,
    settings: Pick<LeaveSettings, "includeBankHoliday" | "region">,
    customDates: readonly CustomDate[],
): LeaveContext {
    const nonWorking = new Set<string>();
    for (const d of customDates) if (d.kind === "non_working" && d.mine) for (const date of eachDate(d.start, d.end, 400)) nonWorking.add(date);
    return { pattern, holidays: applicableHolidays(settings, customDates), nonWorking };
}

/** Public holidays to draw between two dates, with regional ones from custom dates. */
export function holidayOverlays(
    from: string,
    to: string,
    settings: Pick<LeaveSettings, "includeBankHoliday" | "region">,
    customDates: readonly CustomDate[],
): HolidayOverlay[] {
    const out: HolidayOverlay[] = NSW_PUBLIC_HOLIDAYS.filter((h) => h.date >= from && h.date <= to).map((h) => ({
        date: h.date,
        name: h.kind === "bank" && !settings.includeBankHoliday ? `${h.name} (not a public holiday)` : h.name,
        kind: h.kind,
        provisional: !!h.provisional,
    }));
    for (const d of customDates) {
        if (d.kind !== "regional_holiday" || !regionalApplies(d, settings)) continue;
        for (const date of eachDate(d.start, d.end, 60)) if (date >= from && date <= to) out.push({ date, name: d.name, kind: "regional", provisional: false });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * School terms, holidays and development days for one division, with your school's own dates.
 * A custom school holiday or development day is shown alongside the official dates, never instead
 * of them, so nothing official is silently hidden.
 */
export function schoolOverlays(from: string, to: string, division: SchoolDivision | "none", customDates: readonly CustomDate[]): SchoolOverlay[] {
    const official: SchoolOverlay[] =
        division === "none"
            ? []
            : NSW_SCHOOL_PERIODS.filter((s) => s.end >= from && s.start <= to && appliesTo(s, division)).map((s) => ({
                  id: s.id,
                  name: s.name,
                  kind: s.kind,
                  start: s.start,
                  end: s.end,
                  custom: false,
                  provisional: !!s.provisional,
                  school: null,
              }));
    const custom: SchoolOverlay[] = customDates
        .filter((d) => (d.kind === "school_holiday" || d.kind === "development_day" || d.kind === "school_event") && d.end >= from && d.start <= to)
        .map((d) => ({
            id: d.id,
            name: d.school ? `${d.name} (${d.school})` : d.name,
            kind: d.kind === "school_holiday" ? "holidays" : (d.kind as "development_day" | "school_event"),
            start: d.start,
            end: d.end,
            custom: true,
            provisional: false,
            school: d.school,
        }));
    return [...official, ...custom].sort((a, b) => a.start.localeCompare(b.start));
}

/** Official school holiday periods for a division overlapping two dates. */
export const schoolHolidaysBetween = (from: string, to: string, division: SchoolDivision): SchoolPeriod[] =>
    NSW_SCHOOL_PERIODS.filter((s) => s.kind === "holidays" && s.end >= from && s.start <= to && appliesTo(s, division));
