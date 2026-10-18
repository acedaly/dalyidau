// The Family Planner: shared household calendars in one place. What's coming up, birthdays and
// anniversaries, care arrangements and pickups (with who they're for and who's responsible), school
// holidays and who's on leave. Personal calendars stay private: only shared calendars, and your
// own family-purpose ones, appear here. Sensitive events show their details only to their creator.
import { useState } from "react";
import { Calendar, Gift01, GraduationHat01, Plane, Plus, Users01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Empty } from "@/portal/components/empty";
import type { PageData } from "@/portal/lib/page-types";
import { dayLabel, rangeLabel, timeLabel } from "@/shared/calendar/time";
import type { EventOccurrence } from "@/shared/calendar/types";
import { CATEGORY_LABELS } from "@/shared/calendar/types";
import { EventPanel, type PanelTarget } from "../event-panel";
import { CalendarHeader, Card, ColorDot } from "../shared";

const when = (o: EventOccurrence, year: string) =>
    o.allDay ? rangeLabel(o.startDate, o.endDate, year) : `${dayLabel(o.startDate, year)}, ${timeLabel(o.startTime!)}`;

const List = ({ items, year, onOpen, empty }: { items: EventOccurrence[]; year: string; onOpen: (o: EventOccurrence) => void; empty: string }) =>
    items.length ? (
        <ul className="flex flex-col divide-y divide-secondary">
            {items.map((o) => (
                <li key={o.id}>
                    <button
                        type="button"
                        onClick={() => onOpen(o)}
                        className="flex w-full cursor-pointer items-start gap-3 py-2.5 text-left outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
                    >
                        <ColorDot color={o.color} className="mt-1.5" />
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-sm font-medium text-primary">{o.title}</span>
                            <span className="text-sm text-tertiary">
                                {when(o, year)}
                                {o.people?.who.length ? ` · for ${o.people.who.join(", ")}` : ""}
                                {o.people?.responsible ? ` · ${o.people.responsible.split("@")[0]} responsible` : ""}
                            </span>
                        </span>
                        {o.category !== "general" && !o.busyOnly && (
                            <Badge size="sm" color="gray">
                                {CATEGORY_LABELS[o.category]}
                            </Badge>
                        )}
                    </button>
                </li>
            ))}
        </ul>
    ) : (
        <p className="text-sm text-tertiary">{empty}</p>
    );

export const CalendarFamilyPage = ({ data }: { data: PageData<"calendar-family"> }) => {
    const f = data.family;
    const year = data.today.slice(0, 4);
    const [target, setTarget] = useState<PanelTarget>(null);
    const open = (o: EventOccurrence) => setTarget({ kind: "open", eventId: o.eventId, occurrence: o });
    const canAdd = f.calendars.some((c) => c.source === "local" && (c.role === "owner" || c.role === "editor"));

    return (
        <>
            <CalendarHeader
                shell={data}
                title="Family planner"
                description="Shared household calendars: appointments, school, travel, birthdays, care arrangements and pickups."
                crumb={{ label: "Family planner" }}
                actions={
                    <>
                        <Button size="md" color="secondary" href="/portal/calendar/calendars" iconLeading={Users01}>
                            Shared calendars
                        </Button>
                        {canAdd && (
                            <Button size="md" iconLeading={Plus} onClick={() => setTarget({ kind: "new", date: data.today, time: null })}>
                                Add event
                            </Button>
                        )}
                    </>
                }
            />
            {!f.calendars.length ? (
                <div className="rounded-xl bg-primary px-6 py-12 shadow-xs ring-1 ring-secondary ring-inset">
                    <Empty
                        icon={Users01}
                        title="No shared calendars yet"
                        description="Create a shared calendar for the household (Family, School, Care…) and add the people who should see it. Your personal calendars stay private."
                        actions={
                            <Button size="md" href="/portal/calendar/calendars">
                                Create a shared calendar
                            </Button>
                        }
                    />
                </div>
            ) : (
                <>
                    <ul aria-label="Family calendars" className="flex flex-wrap gap-2">
                        {f.calendars.map((c) => (
                            <li key={c.id} className="flex items-center gap-2 rounded-full bg-secondary px-3 py-1.5 text-sm font-medium text-secondary">
                                <ColorDot color={c.color} />
                                {c.name}
                                <span className="text-xs text-tertiary">{c.kind === "shared" ? `${c.memberCount} people` : "personal"}</span>
                            </li>
                        ))}
                    </ul>
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <Card
                            title="Coming up"
                            description={`The next eight weeks, to ${dayLabel(f.to, year)}.`}
                            actions={<Calendar aria-hidden="true" className="size-5 text-fg-quaternary" />}
                        >
                            <List items={f.upcoming} year={year} onOpen={open} empty="Nothing in the shared calendars for the next eight weeks." />
                        </Card>
                        <Card
                            title="Care, pickups and drop-offs"
                            description="Who it's for and who's responsible. Sensitive arrangements show as Private to anyone but their creator."
                        >
                            <List
                                items={f.care}
                                year={year}
                                onOpen={open}
                                empty="No care arrangements or pickups in the next eight weeks. Add one with the category Care, Pickup or Drop-off."
                            />
                        </Card>
                        <Card
                            title="Birthdays and anniversaries"
                            description="The next year."
                            actions={<Gift01 aria-hidden="true" className="size-5 text-fg-quaternary" />}
                        >
                            <List
                                items={f.importantDates}
                                year={year}
                                onOpen={open}
                                empty="None yet. Add a yearly all-day event with the category Birthday or Anniversary."
                            />
                        </Card>
                        <Card
                            title="School holidays and leave"
                            description="The next six months."
                            actions={<GraduationHat01 aria-hidden="true" className="size-5 text-fg-quaternary" />}
                        >
                            <ul className="flex flex-col divide-y divide-secondary">
                                {[
                                    ...f.school.map((s) => ({
                                        key: s.id,
                                        start: s.start,
                                        text: s.name,
                                        sub: rangeLabel(s.start, s.end, year),
                                        icon: GraduationHat01,
                                    })),
                                    ...f.leave.map((l) => ({
                                        key: l.id,
                                        start: l.start,
                                        text: l.owner ? `${l.owner.name ?? l.owner.email} away` : `You: ${l.typeName}`,
                                        sub: `${rangeLabel(l.start, l.end, year)} · ${l.status}`,
                                        icon: Plane,
                                    })),
                                ]
                                    .sort((a, b) => a.start.localeCompare(b.start))
                                    .map((x) => (
                                        <li key={x.key} className="flex items-start gap-3 py-2.5">
                                            <x.icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-quaternary" />
                                            <span className="flex min-w-0 flex-col">
                                                <span className="text-sm font-medium text-primary">{x.text}</span>
                                                <span className="text-sm text-tertiary">{x.sub}</span>
                                            </span>
                                        </li>
                                    ))}
                            </ul>
                            {!f.school.length && !f.leave.length && (
                                <p className="text-sm text-tertiary">No school holidays or leave in the next six months.</p>
                            )}
                        </Card>
                    </div>
                </>
            )}
            <EventPanel
                target={target}
                onClose={() => setTarget(null)}
                onChanged={() => window.location.reload()}
                calendars={f.calendars.length ? f.calendars : data.calendars}
                timeZone={data.preferences.timeZone}
                defaultReminder={data.preferences.defaultReminderMinutes}
                canUseTasks={data.canUseTasks}
                canUseKnowledge={data.canUseKnowledge}
            />
        </>
    );
};
