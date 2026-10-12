// Dashboard widget registry. A widget is a title, a default size, an availability rule and a render
// function over the shared DashboardStats. To add one: add its type to WIDGET_TYPES in
// src/shared/portal/types.ts, add any data it needs to computeStats, and register it here.
import type { FC, ReactNode } from "react";
import { ArrowRight } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { AttendanceBars, TrendChart } from "@/portal/components/charts";
import { PriorityBadge } from "@/portal/components/status";
import { Timestamp } from "@/portal/components/timestamp";
import { daysUntil, formatDate, formatMoney, formatNumber, percent, pluralise } from "@/portal/lib/format";
import type { Flags } from "@/shared/portal/flags";
import type { Permission } from "@/shared/portal/permissions";
import type { DashboardStats, WeddingDetails, WidgetSize, WidgetType } from "@/shared/portal/types";

export interface WidgetContext {
    stats: DashboardStats;
    wedding: WeddingDetails;
    flags: Flags;
    can: (permission: Permission) => boolean;
    sideLabel: (side: "partner_one" | "partner_two" | "shared") => string;
}

export interface WidgetDefinition {
    title: string;
    description: string;
    defaultSize: WidgetSize;
    available: (ctx: WidgetContext) => boolean;
    render: FC<WidgetContext>;
    link?: { href: string; label: string };
}

const Stat = ({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) => (
    <div className="flex flex-col gap-1">
        <p className="text-sm text-tertiary">{label}</p>
        <p className="text-display-xs font-semibold text-primary tabular-nums">{value}</p>
        {sub && <p className="text-xs text-tertiary">{sub}</p>}
    </div>
);

const Quiet = ({ children }: { children: ReactNode }) => <p className="text-sm text-tertiary">{children}</p>;

export const WIDGETS: Record<WidgetType, WidgetDefinition> = {
    countdown: {
        title: "Countdown",
        description: "Days until the wedding.",
        defaultSize: "sm",
        available: () => true,
        render: ({ wedding }) => {
            if (!wedding.date) {
                return (
                    <div className="flex flex-col gap-3">
                        <Quiet>Set the wedding date to start the countdown.</Quiet>
                        <Button href="/portal/settings" size="sm" color="secondary">
                            Add the date
                        </Button>
                    </div>
                );
            }
            const days = daysUntil(wedding.date, wedding.timeZone);
            return (
                <Stat
                    label={formatDate(wedding.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                    value={days > 0 ? pluralise(days, "day") : days === 0 ? "Today!" : "Married"}
                    sub={days > 0 ? `${Math.floor(days / 7)} weeks to go` : undefined}
                />
            );
        },
    },
    "rsvp-summary": {
        title: "RSVPs",
        description: "Who has replied across all events.",
        defaultSize: "md",
        available: () => true,
        link: { href: "/portal/wedding/rsvps", label: "View RSVPs" },
        render: ({ stats }) => {
            const invited = stats.rsvp.attending + stats.rsvp.declined + stats.rsvp.pending;
            if (invited === 0) return <Quiet>No one is invited to an event yet. Add events, then invite guests from the guest list.</Quiet>;
            const replied = stats.rsvp.attending + stats.rsvp.declined;
            return (
                <div className="flex flex-col gap-5">
                    <div className="grid grid-cols-3 gap-4">
                        <Stat label="Attending" value={formatNumber(stats.rsvp.attending)} />
                        <Stat label="Declined" value={formatNumber(stats.rsvp.declined)} />
                        <Stat label="Awaiting" value={formatNumber(stats.rsvp.pending)} />
                    </div>
                    <ProgressBar
                        labelPosition="bottom"
                        value={percent(replied, invited)}
                        valueFormatter={(v) => `${v}% of ${formatNumber(invited)} invited guests have replied`}
                    />
                </div>
            );
        },
    },
    "invitation-readiness": {
        title: "Invitation links",
        description: "Secure household RSVP links.",
        defaultSize: "sm",
        available: () => true,
        link: { href: "/portal/wedding/households", label: "Manage links" },
        render: ({ stats }) => (
            <div className="flex flex-col gap-4">
                <Stat label="Active links" value={formatNumber(stats.invitations.active)} sub={`${formatNumber(stats.invitations.revoked)} revoked`} />
                {stats.invitations.revoked > 0 && <p className="text-xs text-warning-primary">Revoked households need a restored link before native RSVP.</p>}
            </div>
        ),
    },
    "event-attendance": {
        title: "Attendance by event",
        description: "Replies for each event.",
        defaultSize: "lg",
        available: () => true,
        link: { href: "/portal/wedding/events", label: "Manage events" },
        render: ({ stats }) =>
            stats.events.length === 0 ? (
                <Quiet>No events yet. Add the ceremony and reception to start tracking attendance.</Quiet>
            ) : (
                <AttendanceBars
                    caption="Replies by event"
                    rows={stats.events.map((e) => ({ label: e.name, invited: e.invited, attending: e.attending, declined: e.declined }))}
                />
            ),
    },
    "response-trend": {
        title: "Replies over time",
        description: "Guests who have replied, cumulative.",
        defaultSize: "md",
        available: () => true,
        render: ({ stats }) =>
            stats.responseTrend.length < 2 ? (
                <Quiet>The trend appears once replies have come in on at least two different days.</Quiet>
            ) : (
                <TrendChart
                    label="Guests replied"
                    caption="Guests who have replied, by day"
                    points={stats.responseTrend.map((p) => ({ date: p.date, value: p.responded }))}
                />
            ),
    },
    "guest-breakdown": {
        title: "Guest list",
        description: "Guests by side and age.",
        defaultSize: "sm",
        available: () => true,
        link: { href: "/portal/wedding/guests", label: "View guests" },
        render: ({ stats, sideLabel }) =>
            stats.guests.total === 0 ? (
                <Quiet>No guests yet.</Quiet>
            ) : (
                <div className="flex flex-col gap-4">
                    <Stat
                        label="Guests"
                        value={formatNumber(stats.guests.total)}
                        sub={`${pluralise(stats.guests.households, "household")} · ${formatNumber(stats.guests.adults)} adults · ${formatNumber(stats.guests.children + stats.guests.infants)} children`}
                    />
                    <ul className="flex flex-col gap-2 text-sm">
                        {stats.bySide.map((s) => (
                            <li key={s.side} className="flex items-center justify-between gap-3">
                                <span className="text-secondary">{sideLabel(s.side)}</span>
                                <span className="font-medium text-primary tabular-nums">{formatNumber(s.count)}</span>
                            </li>
                        ))}
                    </ul>
                    {stats.guests.withoutEmail > 0 && (
                        <p className="text-xs text-warning-primary">{pluralise(stats.guests.withoutEmail, "guest")} without an email address</p>
                    )}
                </div>
            ),
    },
    dietary: {
        title: "Dietary needs",
        description: "Requirements of guests who are attending.",
        defaultSize: "sm",
        available: () => true,
        render: ({ stats }) =>
            stats.dietary.length === 0 ? (
                <Quiet>No dietary requirements from attending guests yet.</Quiet>
            ) : (
                <ul className="flex flex-col gap-2 text-sm">
                    {stats.dietary.map((d) => (
                        <li key={d.label} className="flex items-center justify-between gap-3">
                            <span className="truncate text-secondary">{d.label}</span>
                            <Badge size="sm" color="gray" type="modern">
                                {d.count}
                            </Badge>
                        </li>
                    ))}
                </ul>
            ),
    },
    "upcoming-tasks": {
        title: "Due soon",
        description: "Open tasks due in the next 30 days.",
        defaultSize: "md",
        available: ({ flags }) => flags["module.planning"],
        link: { href: "/portal/wedding/tasks", label: "All tasks" },
        render: ({ stats }) => {
            if (!stats.tasks) return null;
            return (
                <div className="flex flex-col gap-4">
                    <p className="text-sm text-tertiary">
                        {pluralise(stats.tasks.open, "open task")}
                        {stats.tasks.overdue > 0 && <span className="font-medium text-error-primary"> · {formatNumber(stats.tasks.overdue)} overdue</span>}
                    </p>
                    {stats.tasks.dueSoon.length === 0 ? (
                        <Quiet>Nothing due in the next 30 days.</Quiet>
                    ) : (
                        <ul className="flex flex-col divide-y divide-secondary">
                            {stats.tasks.dueSoon.map((task) => (
                                <li key={task.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium text-primary">{task.title}</p>
                                        <p className="text-xs text-tertiary">Due {formatDate(task.dueDate)}</p>
                                    </div>
                                    <PriorityBadge priority={task.priority} />
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            );
        },
    },
    "budget-summary": {
        title: "Budget",
        description: "Spend against the total budget.",
        defaultSize: "sm",
        available: ({ flags, can }) => flags["module.budget"] && can("wedding.budget.view"),
        link: { href: "/portal/wedding/budget", label: "Open budget" },
        render: ({ stats }) => {
            const b = stats.budget;
            if (!b) return null;
            const committed = Math.max(b.estimatedCents, b.actualCents);
            return (
                <div className="flex flex-col gap-4">
                    <Stat
                        label="Paid so far"
                        value={formatMoney(b.paidCents, b.currency, { whole: true })}
                        sub={b.totalCents ? `of ${formatMoney(b.totalCents, b.currency, { whole: true })} budget` : "No total budget set"}
                    />
                    {b.totalCents > 0 && (
                        <ProgressBar
                            labelPosition="bottom"
                            value={Math.min(percent(committed, b.totalCents), 100)}
                            valueFormatter={() => `${formatMoney(committed, b.currency, { whole: true })} committed (${percent(committed, b.totalCents)}%)`}
                        />
                    )}
                    {b.dueSoonCents > 0 && (
                        <p className="text-xs text-warning-primary">{formatMoney(b.dueSoonCents, b.currency, { whole: true })} due in the next 30 days</p>
                    )}
                </div>
            );
        },
    },
    "rsvp-responses": {
        title: "Latest online replies",
        description: "Responses through the native RSVP form.",
        defaultSize: "md",
        available: () => true,
        render: ({ stats, flags }) =>
            stats.recentResponses.length === 0 ? (
                <Quiet>
                    {flags["rsvp.native"]
                        ? "No online replies yet."
                        : "Native RSVPs are off, so replies are coming through Say I Do. Record them on the RSVPs page or import a Say I Do export."}
                </Quiet>
            ) : (
                <ul className="flex flex-col divide-y divide-secondary">
                    {stats.recentResponses.map((r) => (
                        <li key={`${r.householdName}-${r.submittedAt}`} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-primary">{r.householdName}</p>
                                <p className="text-xs text-tertiary">
                                    <Timestamp iso={r.submittedAt} relative />
                                </p>
                            </div>
                            <p className="shrink-0 text-xs text-tertiary">
                                {r.attending} yes · {r.declined} no
                            </p>
                        </li>
                    ))}
                </ul>
            ),
    },
    "recent-activity": {
        title: "Recent activity",
        description: "The latest changes in the portal.",
        defaultSize: "md",
        available: ({ can }) => can("portal.audit.view"),
        link: { href: "/portal/audit", label: "Audit log" },
        render: ({ stats }) =>
            !stats.recentActivity?.length ? (
                <Quiet>Nothing has changed yet.</Quiet>
            ) : (
                <ul className="flex flex-col divide-y divide-secondary">
                    {stats.recentActivity.map((a) => (
                        <li key={a.id} className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0">
                            <p className="text-sm text-secondary">{a.summary}</p>
                            <p className="text-xs text-tertiary">
                                {a.actor.startsWith("rsvp:") ? "Online RSVP" : a.actor} · <Timestamp iso={a.at} relative />
                            </p>
                        </li>
                    ))}
                </ul>
            ),
    },
    "seating-readiness": {
        title: "Seating readiness",
        description: "Attending guests flowing into the plan.",
        defaultSize: "sm",
        available: ({ flags }) => flags["module.planning"],
        link: { href: "/portal/wedding/seating", label: "Open seating" },
        render: ({ stats }) => {
            const seating = stats.seating;
            if (!seating || seating.attending === 0) return <Quiet>No attending guests need seats yet.</Quiet>;
            return (
                <div className="flex flex-col gap-4">
                    <ProgressBar
                        labelPosition="bottom"
                        value={percent(seating.seated, seating.attending)}
                        valueFormatter={() => `${seating.seated} of ${seating.attending} attending guests seated`}
                    />
                    <p className="text-xs text-tertiary">{seating.mealsUndecided} attending guests still need a meal decision.</p>
                </div>
            );
        },
    },
    "communications-status": {
        title: "Communications",
        description: "Prepared, scheduled and delivered messages.",
        defaultSize: "sm",
        available: ({ flags }) => flags["module.communications"],
        link: { href: "/portal/wedding/communications", label: "Open communications" },
        render: ({ stats }) => {
            const communications = stats.communications;
            if (!communications) return null;
            return (
                <div className="grid grid-cols-2 gap-4">
                    <Stat label="Drafts" value={communications.drafts} />
                    <Stat label="Scheduled" value={communications.queued} />
                    <Stat label="Sent" value={communications.sent} />
                    <Stat label="Failed" value={communications.failed} />
                </div>
            );
        },
    },
};

export const WidgetLink = ({ href, label }: { href: string; label: string }) => (
    <Button href={href} size="sm" color="link-color" iconTrailing={ArrowRight}>
        {label}
    </Button>
);
