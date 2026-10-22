// Today's sections: capacity, the timeline, commitments, notifications and the Chief of Staff
// briefing. Each shows what the Worker worked out from the
// person's records; nothing here calculates availability or invents an item. Untitled UI parts
// throughout (Badge, Button, Notice), in the Calendar's Card frame.
import { useState } from "react";
import { AlertTriangle, Bell01, Calendar, Clock, Lock01, Stars02, Sunrise, Users01, X } from "@untitledui/icons";
import { Badge, BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Card } from "@/portal/calendar/shared";
import { Notice } from "@/portal/components/notice";
import { intelligenceApi } from "@/portal/intelligence/api";
import { errorMessage } from "@/portal/lib/api";
import { dayLabel, timeLabel } from "@/shared/calendar/time";
import type { BriefingView } from "@/shared/intelligence/types";
import { hoursLabel as durationLabel } from "@/shared/today/engine";
import type {
    BriefingRef,
    CommitmentItem,
    DayTimeline,
    TimelineItem,
    TodayBriefing,
    TodayCapacity,
    TodayNotification,
    TodayPreferences,
} from "@/shared/today/types";
import { cx } from "@/utils/cx";

export const STATUS: Record<TodayCapacity["status"], { label: string; color: "gray" | "success" | "brand" | "warning" | "error" }> = {
    off: { label: "Day off", color: "gray" },
    light: { label: "Light day", color: "success" },
    balanced: { label: "Balanced", color: "brand" },
    full: { label: "Full", color: "warning" },
    over: { label: "Overbooked", color: "error" },
};

const clock = (t: string) => timeLabel(t === "24:00" ? "23:59" : t);

// --- Capacity ------------------------------------------------------------------------------------

export const CapacitySection = ({ capacity }: { capacity: TodayCapacity }) => {
    const total = Math.max(1, capacity.availableMinutes);
    const pct = (m: number) => `${Math.min(100, (m / total) * 100)}%`;
    return (
        <Card
            title="Capacity"
            description={capacity.offReason ? `No planning hours: ${capacity.offReason}.` : "Your planning hours, what's committed and what's left."}
            actions={
                <BadgeWithDot size="sm" type="modern" color={STATUS[capacity.status].color}>
                    {STATUS[capacity.status].label}
                </BadgeWithDot>
            }
        >
            {/* One compact row of figures rather than a card each. */}
            <div className="@container">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 @xl:grid-cols-3">
                    {[
                        {
                            label: "Available",
                            icon: Clock,
                            value: capacity.availableMinutes,
                            detail: capacity.breakMinutes ? `After ${durationLabel(capacity.breakMinutes)} of breaks` : "After leave and holidays",
                        },
                        { label: "Appointments", icon: Calendar, value: capacity.appointmentMinutes, detail: "Overlaps counted once" },
                        {
                            label: "Free",
                            icon: Stars02,
                            value: capacity.freeMinutes,
                            detail: capacity.outsideMinutes
                                ? `${durationLabel(capacity.outsideMinutes)} booked outside your hours`
                                : "Inside your planning hours",
                        },
                    ].map((m) => (
                        <div key={m.label} className="flex min-w-0 flex-col gap-0.5">
                            <dt className="flex items-center gap-1.5 text-sm text-tertiary">
                                <m.icon aria-hidden="true" className="size-4 text-fg-quaternary" />
                                {m.label}
                            </dt>
                            <dd className="text-lg font-semibold text-primary">{durationLabel(m.value)}</dd>
                            <dd className="text-xs text-tertiary">{m.detail}</dd>
                        </div>
                    ))}
                </dl>
            </div>
            {capacity.availableMinutes > 0 && (
                <div
                    role="img"
                    aria-label={`${durationLabel(capacity.appointmentMinutes)} appointments, ${durationLabel(capacity.freeMinutes)} free`}
                    className="flex h-2.5 w-full overflow-hidden rounded-full bg-quaternary"
                >
                    <span className="h-full bg-fg-brand-primary" style={{ width: pct(capacity.appointmentMinutes) }} />
                </div>
            )}
            {capacity.availableMinutes > 0 && (
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-tertiary">
                    <span className="flex items-center gap-1.5">
                        <span aria-hidden="true" className="size-2 rounded-full bg-fg-brand-primary" /> Appointments
                    </span>
                    <span className="flex items-center gap-1.5">
                        <span aria-hidden="true" className="size-2 rounded-full bg-quaternary" /> Free
                    </span>
                </p>
            )}
            {capacity.overbooked.length > 0 && (
                <Notice color="warning" title="Overbooked">
                    {capacity.overbooked.map((o) => `${clock(o.startTime)}–${clock(o.endTime)}: ${o.with.map((w) => w.title).join(", ")}`).join("; ")}
                </Notice>
            )}
            <details className="group text-sm">
                <summary className="cursor-pointer rounded-sm font-medium text-brand-secondary outline-focus-ring focus-visible:outline-2">
                    How this was worked out
                </summary>
                <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-tertiary">
                    {capacity.explanation.map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
            </details>
        </Card>
    );
};

// --- Timeline ------------------------------------------------------------------------------------

const KIND: Record<TimelineItem["kind"], { label: string; bar: string }> = {
    event: { label: "Fixed", bar: "bg-fg-brand-primary" },
    break: { label: "Break", bar: "bg-fg-quaternary" },
    leave: { label: "Unavailable", bar: "bg-fg-warning-secondary" },
    free: { label: "Free", bar: "bg-quaternary" },
};

export const TimelineList = ({ timeline }: { timeline: DayTimeline }) => {
    if (!timeline.items.length && !timeline.allDay.length)
        return <p className="text-sm text-tertiary">{timeline.hours.length ? "Nothing planned yet." : "No planning hours and nothing on this day."}</p>;
    return (
        <div className="flex flex-col gap-3">
            {timeline.allDay.length > 0 && (
                <ul aria-label="All day" className="flex flex-wrap gap-2">
                    {timeline.allDay.map((a) => (
                        <li key={a.id}>
                            <Badge size="md" color={a.kind === "leave" ? "warning" : a.kind === "holiday" ? "gray" : "brand"}>
                                {a.url ? (
                                    <a href={a.url} className="rounded-sm outline-focus-ring hover:underline focus-visible:outline-2">
                                        {a.title}
                                    </a>
                                ) : (
                                    a.title
                                )}
                                <span className="sr-only">, all day</span>
                            </Badge>
                        </li>
                    ))}
                </ul>
            )}
            <ol aria-label="Timeline" className="flex flex-col gap-1.5">
                {timeline.items.map((item) => (
                    <li
                        key={item.id}
                        data-timeline={item.kind}
                        className={cx(
                            "flex items-stretch gap-3 rounded-lg px-3 py-2 ring-1 ring-inset",
                            item.kind === "free" ? "bg-secondary_subtle ring-secondary" : "bg-primary ring-secondary",
                            item.conflict && "ring-error_subtle",
                        )}
                    >
                        <span aria-hidden="true" className={cx("w-1 shrink-0 rounded-full", KIND[item.kind].bar)} />
                        <div className="w-24 shrink-0 text-xs text-tertiary tabular-nums sm:w-28">
                            <span className="block font-medium text-secondary">{clock(item.startTime)}</span>
                            <span>to {clock(item.endTime)}</span>
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                                {item.url && item.kind !== "free" ? (
                                    <a
                                        href={item.url}
                                        className="truncate text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2"
                                    >
                                        {item.title}
                                    </a>
                                ) : (
                                    <span className={cx("text-sm font-medium", item.kind === "free" ? "text-tertiary" : "text-primary")}>{item.title}</span>
                                )}
                                <Badge size="sm" color={item.kind === "event" ? "brand" : "gray"}>
                                    {KIND[item.kind].label}
                                </Badge>
                                {item.readOnly && item.kind === "event" && (
                                    <Badge size="sm" color="gray">
                                        <Lock01 aria-hidden="true" className="mr-1 size-3" />
                                        Read-only
                                    </Badge>
                                )}
                                {item.shared && (
                                    <Badge size="sm" color="gray">
                                        <Users01 aria-hidden="true" className="mr-1 size-3" />
                                        Shared
                                    </Badge>
                                )}
                                {item.conflict && (
                                    <Badge size="sm" color="error">
                                        <AlertTriangle aria-hidden="true" className="mr-1 size-3" />
                                        Overlaps
                                    </Badge>
                                )}
                            </div>
                            <span className="text-xs text-tertiary">
                                {durationLabel(item.minutes)}
                                {item.detail && ` · ${item.detail}`}
                            </span>
                        </div>
                    </li>
                ))}
            </ol>
        </div>
    );
};

// --- Commitments and notifications ---------------------------------------------------------------------

const CommitmentList = ({ items, empty, date }: { items: CommitmentItem[]; empty: string; date: string }) =>
    items.length ? (
        <ul className="flex flex-col divide-y divide-secondary">
            {items.map((c) => (
                <li key={c.id} className="flex flex-col py-2 text-sm first:pt-0 last:pb-0">
                    <a href={c.url} className="truncate font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2">
                        {c.title}
                    </a>
                    <span className="text-xs text-tertiary">
                        {c.date === date ? "Today" : dayLabel(c.date)}, {c.when}
                        {c.calendarName && ` · ${c.calendarName}`}
                    </span>
                </li>
            ))}
        </ul>
    ) : (
        <p className="text-sm text-tertiary">{empty}</p>
    );

export const CommitmentsSection = ({
    commitments,
    date,
    lookahead,
}: {
    commitments: { personal: CommitmentItem[]; shared: CommitmentItem[] };
    date: string;
    lookahead: number;
}) => (
    <Card title="Commitments" description="Your own events today, and shared household calendars for the days ahead.">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <section aria-labelledby="commitments-personal" className="flex min-w-0 flex-col gap-2">
                <h3 id="commitments-personal" className="text-sm font-semibold text-secondary">
                    Personal
                </h3>
                <CommitmentList items={commitments.personal} empty="Nothing in your own calendars." date={date} />
            </section>
            <section aria-labelledby="commitments-shared" className="flex min-w-0 flex-col gap-2">
                <h3 id="commitments-shared" className="text-sm font-semibold text-secondary">
                    Shared, next {lookahead} {lookahead === 1 ? "day" : "days"}
                </h3>
                <CommitmentList items={commitments.shared} empty="Nothing in shared calendars." date={date} />
            </section>
        </div>
    </Card>
);

export const NotificationsSection = ({ notifications, onDismiss }: { notifications: TodayNotification[]; onDismiss: (n: TodayNotification) => void }) => (
    <Card title="Notifications" description="Calendar notices and Intelligence Centre alerts for your watch areas.">
        {notifications.length ? (
            <ul className="flex flex-col divide-y divide-secondary">
                {notifications.map((n) => (
                    <li key={n.id} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
                        <Bell01 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-quaternary" />
                        <div className="flex min-w-0 flex-1 flex-col">
                            {n.url ? (
                                <a href={n.url} className="text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2">
                                    {n.title}
                                </a>
                            ) : (
                                <span className="text-sm font-medium text-primary">{n.title}</span>
                            )}
                            {n.detail && <span className="text-xs text-tertiary">{n.detail}</span>}
                        </div>
                        {n.dismissable && <ButtonUtility size="xs" color="tertiary" icon={X} tooltip={`Dismiss ${n.title}`} onClick={() => onDismiss(n)} />}
                    </li>
                ))}
            </ul>
        ) : (
            <p className="text-sm text-tertiary">No notifications.</p>
        )}
    </Card>
);

// --- Chief of Staff --------------------------------------------------------------------------------

const RefList = ({ title, refs, empty }: { title: string; refs: BriefingRef[]; empty?: string }) =>
    refs.length || empty ? (
        <section className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-sm font-semibold text-secondary">{title}</h3>
            {refs.length ? (
                <ul className="flex flex-col gap-1 text-sm">
                    {refs.map((r) => (
                        <li key={r.id} className="min-w-0">
                            <a href={r.url} className="font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2">
                                {r.title}
                            </a>
                            {r.detail && <span className="text-tertiary"> · {r.detail}</span>}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-sm text-tertiary">{empty}</p>
            )}
        </section>
    ) : null;

export const BriefingSection = ({
    briefing,
    preferences,
    canUseIntelligence,
}: {
    briefing: TodayBriefing;
    preferences: TodayPreferences["briefing"];
    canUseIntelligence: boolean;
}) => {
    const [ai, setAi] = useState<BriefingView | null>(null);
    const [aiError, setAiError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const explain = async () => {
        setBusy(true);
        setAiError(null);
        try {
            // Daly Intelligence's daily briefing: every reference a model returns must be one of its facts, or it's dropped.
            setAi((await intelligenceApi.recommend("daily")).briefing);
        } catch (error) {
            setAiError(errorMessage(error));
        } finally {
            setBusy(false);
        }
    };
    const c = briefing.capacity;
    const full = preferences.detail === "full";
    return (
        <Card
            title="Chief of Staff briefing"
            description="From your Calendar and leave records. Every item links to where it came from."
            actions={
                canUseIntelligence && preferences.ai ? (
                    <Button size="sm" color="secondary" iconLeading={Stars02} onClick={() => void explain()} isLoading={busy} showTextWhileLoading>
                        Explain my day
                    </Button>
                ) : undefined
            }
        >
            <section aria-labelledby="next-actions" className="flex flex-col gap-2 rounded-lg bg-secondary p-3">
                <h3 id="next-actions" className="flex items-center gap-2 text-sm font-semibold text-primary">
                    <Sunrise aria-hidden="true" className="size-4 text-fg-brand-primary" />
                    Recommended next actions
                </h3>
                <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-secondary">
                    {briefing.nextActions.map((a) => (
                        <li key={a.id}>
                            {a.text}
                            {a.refs.length > 0 && (
                                <span className="text-tertiary">
                                    {" "}
                                    (
                                    {a.refs.map((r, i) => (
                                        <span key={r.id}>
                                            {i > 0 && ", "}
                                            <a
                                                href={r.url}
                                                className="rounded-sm text-brand-secondary outline-focus-ring hover:underline focus-visible:outline-2"
                                            >
                                                {r.title}
                                            </a>
                                        </span>
                                    ))}
                                    )
                                </span>
                            )}
                        </li>
                    ))}
                </ol>
            </section>
            <p className="text-sm text-secondary">
                {c.status === "off"
                    ? "No planning hours today."
                    : `${durationLabel(c.availableMinutes)} available, ${durationLabel(c.committedMinutes)} committed, ${durationLabel(c.freeMinutes)} free.`}
            </p>
            {full && (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <RefList title="Today's commitments" refs={briefing.commitments} empty="Nothing in the calendar." />
                    <RefList title="Scheduling conflicts" refs={briefing.conflicts} />
                    <RefList title="Family and shared commitments" refs={briefing.family} />
                </div>
            )}
            {aiError && (
                <Notice color="warning" title="Daly Intelligence couldn't explain the day">
                    {aiError}
                </Notice>
            )}
            {ai && (
                <section aria-labelledby="ai-explanation" className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-secondary ring-inset">
                    <h3 id="ai-explanation" className="flex items-center gap-2 text-sm font-semibold text-primary">
                        <Stars02 aria-hidden="true" className="size-4 text-fg-brand-primary" />
                        Daly Intelligence
                    </h3>
                    {ai.recommendations.status === "ready" && ai.recommendations.items.length ? (
                        <ul className="flex flex-col gap-1.5 text-sm text-secondary">
                            {ai.recommendations.items.map((r) => (
                                <li key={r.text}>
                                    {r.text}{" "}
                                    <span className="text-tertiary">
                                        (
                                        {r.refs.map((ref, i) => (
                                            <span key={ref.id}>
                                                {i > 0 && ", "}
                                                <a href={ref.url} className="text-brand-secondary hover:underline">
                                                    {ref.title}
                                                </a>
                                            </span>
                                        ))}
                                        )
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">
                            {ai.recommendations.status === "off"
                                ? "AI explanations are switched off. The facts above are complete without them."
                                : ai.recommendations.status === "budget"
                                  ? "This month's AI budget is used up. The facts above are complete without it."
                                  : ai.recommendations.status === "unavailable"
                                    ? "The AI service isn't available right now. The facts above are complete without it."
                                    : "Nothing to add."}
                        </p>
                    )}
                    <p className="text-xs text-tertiary">AI explains these records only. It never adds meetings or availability.</p>
                </section>
            )}
            <p className="text-xs text-tertiary">Not checked: {briefing.notChecked.join(", ")}.</p>
        </Card>
    );
};
