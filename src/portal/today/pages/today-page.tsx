// Today (/portal/today): one place to see the day. A greeting and the date (today, tomorrow or any
// day), the Chief of Staff briefing, capacity, a timeline of commitments, breaks, leave and free
// time, commitments and notifications, in the order the person chose. An appointment can be added
// from the header.
//
// Today owns no records: events are Calendar's, changed through Calendar's own API. After a change
// only the affected parts are fetched again, never the whole page.
import { useCallback, useState } from "react";
import { type CalendarDate, parseDate } from "@internationalized/date";
import { ArrowLeft, ArrowRight, Calendar, Settings01 } from "@untitledui/icons";
import { DatePicker } from "@/components/application/date-picker/date-picker";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { calendarApi } from "@/portal/calendar/api";
import { Card } from "@/portal/calendar/shared";
import { TimeGrid } from "@/portal/calendar/views";
import { PageHeader } from "@/portal/components/page-header";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { AssetsTodaySection } from "@/portal/today/assets-section";
import { CentreTodaySection } from "@/portal/today/centre-section";
import { addDays, dayLabel, longDateLabel, zoneAbbreviation } from "@/shared/calendar/time";
import type { TodayDashboard, TodaySection } from "@/shared/today/types";
import { cx } from "@/utils/cx";
import { AddAppointment } from "../add-appointment";
import { PlanningHoursDialog } from "../planning-hours-dialog";
import { BriefingSection, CapacitySection, CommitmentsSection, NotificationsSection, STATUS, TimelineList } from "../sections";
import { TodaySettingsDialog } from "../settings-dialog";
import { type TodayPart, todayApi } from "../today-api";

const AFTER_CHANGE: TodayPart[] = ["plan", "briefing"];

/** Any other day: Untitled UI's date picker, applied with its own Apply button. */
const GoToDate = ({ date, onGo }: { date: string; onGo: (date: string) => void }) => {
    const [draft, setDraft] = useState<CalendarDate | null>(parseDate(date));
    return (
        <DatePicker
            aria-label="Go to a date"
            value={draft}
            onChange={(next) => setDraft(next as CalendarDate | null)}
            onApply={() => draft && draft.toString() !== date && onGo(draft.toString())}
            onCancel={() => setDraft(parseDate(date))}
        />
    );
};

export const TodayPage = ({ data: page }: { data: PageData<"today"> }) => {
    const toast = useToast();
    const { user } = usePortal();
    const [data, setData] = useState<TodayDashboard>(page.dashboard);
    const [hours, setHours] = useState(page.planningHours);
    const [dialog, setDialog] = useState<"settings" | "hours" | null>(null);
    const [timelineView, setTimelineView] = useState(data.preferences.timelineView);
    const { date, today } = data;

    const refresh = useCallback(
        async (parts: TodayPart[] = AFTER_CHANGE) => {
            const { today: next } = await todayApi.get(date, parts);
            setData((d) => ({ ...d, ...next }));
        },
        [date],
    );
    const hrefFor = (d: string) => (d === today ? "/portal/today" : `/portal/today?date=${d}`);
    const go = (d: string) => (window.location.href = hrefFor(d));
    const firstName = (user.name ?? user.email.split("@")[0]).split(/\s+/)[0];

    const sections: Record<TodaySection, () => React.ReactNode> = {
        briefing: () => <BriefingSection briefing={data.briefing} preferences={data.preferences.briefing} canUseIntelligence={data.canUseIntelligence} />,
        capacity: () => <CapacitySection capacity={data.capacity} />,
        timeline: () => (
            <div id="timeline" className="scroll-mt-4">
                <Card
                    title="Timeline"
                    description="Commitments, breaks, leave and free time. Events from subscribed calendars are never changed here."
                    actions={
                        <ButtonGroup
                            size="sm"
                            selectedKeys={[timelineView]}
                            onSelectionChange={(keys) => {
                                const [k] = [...keys];
                                if (k === "list" || k === "grid") setTimelineView(k);
                            }}
                            aria-label="Timeline view"
                            className="max-md:hidden"
                        >
                            <ButtonGroupItem id="list">List</ButtonGroupItem>
                            <ButtonGroupItem id="grid">Grid</ButtonGroupItem>
                        </ButtonGroup>
                    }
                >
                    {timelineView === "grid" && (
                        <div className="max-md:hidden">
                            <TimeGrid
                                from={date}
                                to={date}
                                today={today}
                                timeZone={data.timeZone}
                                occurrences={page.occurrences}
                                overlays={page.overlays}
                                onOpen={(o) => (window.location.href = `/portal/calendar?view=day&date=${o.startDate}&event=${o.eventId}`)}
                                onCreate={() => undefined}
                                startHour={Number(page.workingHoursStart.slice(0, 2))}
                            />
                        </div>
                    )}
                    <div className={cx(timelineView === "grid" && "md:hidden")}>
                        <TimelineList timeline={data.timeline} />
                    </div>
                </Card>
            </div>
        ),
        commitments: () => <CommitmentsSection commitments={data.commitments} date={date} lookahead={data.preferences.briefing.lookaheadDays} />,
        notifications: () => (
            <NotificationsSection
                notifications={data.notifications}
                onDismiss={(n) =>
                    void calendarApi
                        .dismiss(n.id)
                        .then(() => refresh(["notifications"]))
                        .catch((error: unknown) => toast.error("Couldn't dismiss it", errorMessage(error)))
                }
            />
        ),
    };
    const order =
        data.preferences.startView === "timeline"
            ? ["timeline" as const, ...data.preferences.sections.filter((s) => s !== "timeline")]
            : data.preferences.sections;
    const status = STATUS[data.capacity.status];

    return (
        <>
            <PageHeader
                title={`${data.greeting}, ${firstName}`}
                description={
                    <>
                        {longDateLabel(date)}
                        {date !== today && ` · Today is ${dayLabel(today)}`} · {data.timeZone.replace(/_/g, " ")} ({zoneAbbreviation(data.timeZone)})
                    </>
                }
                breadcrumbs={[{ label: "Today" }]}
                actions={
                    <>
                        <AddAppointment data={data} onChanged={() => window.location.reload()} />
                        <ButtonUtility size="sm" color="secondary" icon={Settings01} tooltip="Customise Today" onClick={() => setDialog("settings")} />
                    </>
                }
            />

            <div className="flex flex-col gap-3 rounded-xl bg-primary p-3 shadow-xs ring-1 ring-secondary ring-inset md:flex-row md:items-center md:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                    {/* Plain links: moving between days loads that day's page. */}
                    <nav aria-label="Choose a day" className="flex flex-wrap items-center gap-1">
                        <ButtonUtility size="sm" color="secondary" icon={ArrowLeft} tooltip="Previous day" href={hrefFor(addDays(date, -1))} />
                        <Button
                            size="sm"
                            color={date === today ? "primary" : "secondary"}
                            href={hrefFor(today)}
                            aria-current={date === today ? "date" : undefined}
                        >
                            Today
                        </Button>
                        <Button
                            size="sm"
                            color={date === addDays(today, 1) ? "primary" : "secondary"}
                            href={hrefFor(addDays(today, 1))}
                            aria-current={date === addDays(today, 1) ? "date" : undefined}
                        >
                            Tomorrow
                        </Button>
                        <ButtonUtility size="sm" color="secondary" icon={ArrowRight} tooltip="Next day" href={hrefFor(addDays(date, 1))} />
                    </nav>
                    <GoToDate date={date} onGo={go} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-tertiary">
                        <span className="font-medium text-secondary">{status.label}</span>
                        {data.capacity.availableMinutes > 0 && ` · ${Math.round(data.capacity.freeMinutes / 6) / 10} h free`}
                    </span>
                    <Button size="sm" color="tertiary" iconLeading={Calendar} href={`/portal/calendar?view=${data.preferences.calendarView}&date=${date}`}>
                        Open in Calendar
                    </Button>
                </div>
            </div>

            {page.centre && <CentreTodaySection centre={page.centre} />}
            {page.assets && <AssetsTodaySection assets={page.assets} />}

            <div className="flex min-w-0 flex-col gap-6">
                {order.map((s) => (
                    <div key={s} data-section={s}>
                        {sections[s]()}
                    </div>
                ))}
                {!order.length && <p className="text-sm text-tertiary">Every section is hidden. Choose some with Customise Today.</p>}
            </div>

            {dialog === "settings" && (
                <TodaySettingsDialog
                    isOpen
                    onOpenChange={(o) => setDialog(o ? "settings" : null)}
                    data={data}
                    onOpenPlanning={() => setDialog("hours")}
                    onSaved={(preferences, version) => {
                        setData((d) => ({ ...d, preferences, preferencesVersion: version }));
                        setTimelineView(preferences.timelineView);
                        void refresh();
                    }}
                />
            )}
            <PlanningHoursDialog
                isOpen={dialog === "hours"}
                onOpenChange={(o) => setDialog(o ? "hours" : null)}
                initial={hours.preferences}
                version={hours.version}
                onSaved={(preferences, version) => {
                    setHours({ preferences, version });
                    void refresh();
                }}
            />
        </>
    );
};
