// A full-year planner: twelve months of days, each marked with NSW public holidays, school holidays,
// leave (approved, planned, a scenario, and anyone who shares theirs) and how busy it is. Used by
// the Year page and the Leave Planner. Colour is never the only signal: every day's label says
// what it is, and the legend matches the patterns.
import { eachDate, isoWeekday, longDateLabel, monthLabel, startOfWeek } from "@/shared/calendar/time";
import type { LeaveStatus, Overlays } from "@/shared/calendar/types";
import { cx } from "@/utils/cx";

export interface YearPlannerProps {
    year: number;
    today: string;
    overlays: Overlays;
    busy?: Record<string, number>;
    /** Dates of a what-if scenario, drawn hatched. */
    scenario?: ReadonlySet<string>;
    /** Where a day links to; none for a plain grid. */
    hrefFor?: (date: string) => string;
    weekStart?: 0 | 1;
}

type DayInfo = { holiday?: string; school?: string; leave?: LeaveStatus; shared?: string; scenario?: boolean; busy: number };

export const YearPlanner = ({ year, today, overlays, busy = {}, scenario, hrefFor, weekStart = 1 }: YearPlannerProps) => {
    const info = new Map<string, DayInfo>();
    const at = (d: string) => info.get(d) ?? (info.set(d, { busy: busy[d] ?? 0 }), info.get(d)!);
    for (const h of overlays.holidays) if (h.kind !== "bank") at(h.date).holiday = h.name;
    for (const s of overlays.school) if (s.kind === "holidays") for (const d of eachDate(s.start, s.end, 60)) at(d).school = s.name;
    for (const l of overlays.leave)
        for (const d of eachDate(l.start, l.end, 400)) {
            if (l.owner) at(d).shared = l.owner.name ?? l.owner.email;
            else if (!at(d).leave || l.status === "approved" || l.status === "taken") at(d).leave = l.status;
        }
    if (scenario) for (const d of scenario) at(d).scenario = true;

    return (
        <div className="flex flex-col gap-4">
            <div className="@container">
                <div className="grid grid-cols-1 gap-4 @md:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-4">
                    {Array.from({ length: 12 }, (_, m) => {
                        const first = `${year}-${String(m + 1).padStart(2, "0")}-01`;
                        const last = `${year}-${String(m + 1).padStart(2, "0")}-${String(new Date(Date.UTC(year, m + 1, 0)).getUTCDate()).padStart(2, "0")}`;
                        const lead = eachDate(startOfWeek(first, weekStart), first).length - 1;
                        const days = eachDate(first, last, 31);
                        return (
                            <section key={m} aria-label={monthLabel(first)} className="rounded-xl bg-primary p-3 shadow-xs ring-1 ring-secondary ring-inset">
                                <h3 className="mb-2 text-sm font-semibold text-primary">{monthLabel(first)}</h3>
                                <div className="grid grid-cols-7 gap-0.5 text-center" aria-hidden="true">
                                    {Array.from({ length: 7 }, (_, i) => (
                                        <span key={i} className="text-[11px] font-medium text-quaternary">
                                            {"MTWTFSS"[(i + (weekStart === 1 ? 0 : 6)) % 7]}
                                        </span>
                                    ))}
                                </div>
                                <div className="grid grid-cols-7 gap-0.5">
                                    {Array.from({ length: lead }, (_, i) => (
                                        <span key={`lead${i}`} />
                                    ))}
                                    {days.map((d) => {
                                        const x = info.get(d) ?? { busy: busy[d] ?? 0 };
                                        const weekend = isoWeekday(d) >= 6;
                                        const label = [
                                            longDateLabel(d),
                                            x.holiday && `public holiday: ${x.holiday}`,
                                            x.school,
                                            x.leave && `your leave (${x.leave})`,
                                            x.scenario && "in the scenario",
                                            x.shared && `${x.shared} on leave`,
                                            x.busy ? `${x.busy} event${x.busy === 1 ? "" : "s"}` : null,
                                        ]
                                            .filter(Boolean)
                                            .join(", ");
                                        const className = cx(
                                            "relative flex aspect-square min-h-7 items-center justify-center rounded-md text-xs tabular-nums",
                                            weekend && !x.holiday && !x.leave && "bg-secondary_subtle text-tertiary",
                                            !weekend && !x.holiday && !x.leave && "text-secondary",
                                            x.holiday && "bg-utility-orange-100 font-semibold text-utility-orange-700",
                                            (x.leave === "approved" || x.leave === "taken") && "bg-utility-blue-600 font-semibold text-white",
                                            (x.leave === "requested" || x.leave === "proposed" || x.leave === "draft") &&
                                                "bg-utility-blue-100 font-semibold text-utility-blue-700 ring-1 ring-utility-blue-300 ring-inset",
                                            x.scenario &&
                                                !x.leave &&
                                                "bg-[repeating-linear-gradient(45deg,var(--color-utility-purple-100)_0,var(--color-utility-purple-100)_3px,transparent_3px,transparent_6px)] font-semibold text-utility-purple-700 ring-1 ring-utility-purple-300 ring-inset",
                                            d === today && "outline-2 outline-offset-1 outline-brand",
                                        );
                                        const marks = (
                                            <>
                                                {Number(d.slice(8))}
                                                {x.school && <span className="absolute inset-x-1 bottom-0.5 h-0.5 rounded-full bg-utility-green-500" />}
                                                {x.shared && <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-utility-neutral-500" />}
                                                {x.busy > 0 && !x.leave && (
                                                    <span className="absolute top-0.5 left-0.5 size-1 rounded-full bg-fg-brand-secondary" />
                                                )}
                                            </>
                                        );
                                        return hrefFor ? (
                                            <a
                                                key={d}
                                                href={hrefFor(d)}
                                                aria-label={label}
                                                title={label}
                                                className={cx(className, "outline-focus-ring hover:ring-1 hover:ring-primary focus-visible:outline-2")}
                                            >
                                                {marks}
                                            </a>
                                        ) : (
                                            <span key={d} role="img" aria-label={label} title={label} className={className}>
                                                {marks}
                                            </span>
                                        );
                                    })}
                                </div>
                            </section>
                        );
                    })}
                </div>
            </div>
            <ul aria-label="Legend" className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-tertiary">
                <li className="flex items-center gap-1.5">
                    <span className="size-3 rounded bg-utility-orange-100 ring-1 ring-utility-orange-300 ring-inset" /> NSW public holiday
                </li>
                <li className="flex items-center gap-1.5">
                    <span className="h-0.5 w-3 rounded bg-utility-green-500" /> School holidays
                </li>
                <li className="flex items-center gap-1.5">
                    <span className="size-3 rounded bg-utility-blue-600" /> Leave approved or taken
                </li>
                <li className="flex items-center gap-1.5">
                    <span className="size-3 rounded bg-utility-blue-100 ring-1 ring-utility-blue-300 ring-inset" /> Leave requested or proposed
                </li>
                {scenario && (
                    <li className="flex items-center gap-1.5">
                        <span className="size-3 rounded bg-[repeating-linear-gradient(45deg,var(--color-utility-purple-100)_0,var(--color-utility-purple-100)_3px,transparent_3px,transparent_6px)] ring-1 ring-utility-purple-300 ring-inset" />{" "}
                        Scenario
                    </li>
                )}
                <li className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-utility-neutral-500" /> Someone who shares their leave is away
                </li>
                <li className="flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full bg-fg-brand-secondary" /> Has events
                </li>
            </ul>
        </div>
    );
};
