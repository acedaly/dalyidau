// Home: the day at a glance. The countdown, a quick way to add a task, RSVPs, what's due, the budget
// and who needs a nudge, all from the portal's dashboard numbers (/api/portal/dashboard).
import { useState } from "react";
import { CheckCircle, Plus } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { daysUntil, formatDate, formatMoney, formatRelative, percent, pluralise, todayIso } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";
import type { BudgetItem, DashboardStats } from "@/shared/portal/types";
import { EmptyRow, LoadError, LoadingRows, PageTitle, Row, RowList, Section, SectionLink, StatGrid, StatTile } from "../components";
import { BUDGET, DASHBOARD, TASKS, change, useApi } from "../data";
import { useNavigation } from "../navigation";
import { budgetTotals } from "./budget-view";

const greeting = (timeZone: string) => {
    const hour = Number(new Intl.DateTimeFormat("en-AU", { hour: "numeric", hourCycle: "h23", timeZone }).format(new Date()));
    return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
};

/** "158 days to go", "Tomorrow!", "Today!" or nothing while the date is undecided. */
const countdown = (date: string, timeZone: string) => {
    if (!date) return null;
    const days = daysUntil(date, timeZone);
    return days > 1 ? `${pluralise(days, "day")} to go` : days === 1 ? "Tomorrow!" : days === 0 ? "Today!" : "Married";
};

/** Adds a task by its title (Enter or the button). The full task form stays in the Tasks tab. */
export const QuickAddTask = ({ placeholder = "Add a task…" }: { placeholder?: string }) => {
    const toast = useToast();
    const [title, setTitle] = useState("");
    const [busy, setBusy] = useState(false);
    const add = async () => {
        const value = title.trim();
        if (!value || busy) return;
        setBusy(true);
        try {
            await change("POST", TASKS, { title: value }, [TASKS]);
            setTitle("");
            toast.success("Task added");
        } catch (e) {
            toast.error("Couldn't add the task", errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <form
            className="flex items-center gap-2 rounded-2xl bg-primary p-2 shadow-xs ring-1 ring-secondary ring-inset"
            onSubmit={(event) => {
                event.preventDefault();
                void add();
            }}
        >
            <Input aria-label="New task" placeholder={placeholder} value={title} onChange={setTitle} wrapperClassName="flex-1" isDisabled={busy} />
            <Button type="submit" size="md" iconLeading={Plus} isDisabled={!title.trim()} isLoading={busy}>
                Add
            </Button>
        </form>
    );
};

const TaskDueRow = ({ task, today }: { task: NonNullable<DashboardStats["tasks"]>["dueSoon"][number]; today: string }) => {
    const toast = useToast();
    const { can } = usePortal();
    const [done, setDone] = useState(false);
    const overdue = !!task.dueDate && task.dueDate < today;
    const complete = async (selected: boolean) => {
        setDone(selected);
        try {
            await change("PATCH", `${TASKS}/${task.id}`, { status: selected ? "done" : "todo" }, [TASKS]);
            if (selected) toast.success("Done", task.title);
        } catch (e) {
            setDone(!selected);
            toast.error("Couldn't update the task", errorMessage(e));
        }
    };
    return (
        <Row
            leading={
                <Checkbox
                    aria-label={`Mark "${task.title}" done`}
                    isSelected={done}
                    onChange={(selected) => void complete(selected)}
                    isDisabled={!can("wedding.planning.edit")}
                />
            }
            title={task.title}
            detail={
                task.dueDate ? (
                    <span className={overdue ? "text-error-primary" : undefined}>
                        {overdue ? "Overdue · " : "Due "}
                        {formatDate(task.dueDate)}
                    </span>
                ) : (
                    "No due date"
                )
            }
        />
    );
};

/** The same figures as the Budget tab (budgetTotals), so the two never disagree. */
const BudgetSnapshot = ({ budget, today }: { budget: NonNullable<DashboardStats["budget"]>; today: string }) => {
    const { go } = useNavigation();
    const { data } = useApi<{ items: BudgetItem[] }>(BUDGET);
    const totals = data ? budgetTotals(data.items, today) : null;
    const money = (cents: number) => formatMoney(cents, budget.currency, { whole: true });
    return (
        <Section label="Budget" action={<SectionLink onClick={() => go("budget")}>Details</SectionLink>}>
            <StatGrid>
                <StatTile label="Budget" value={money(budget.totalCents)} />
                <StatTile label="Committed" value={totals ? money(totals.committed) : "…"} />
                <StatTile label="Paid" value={totals ? money(totals.paid) : "…"} tone="success" />
                <StatTile label="Due in 30 days" value={money(budget.dueSoonCents)} tone={budget.dueSoonCents ? "warning" : "default"} />
            </StatGrid>
        </Section>
    );
};

export const HomeView = () => {
    const { user, wedding, can, isOn } = usePortal();
    const { go } = useNavigation();
    const { data, error, loading, reload } = useApi<{ stats: DashboardStats }>(DASHBOARD);
    const stats = data?.stats;
    const name = (user.name ?? user.email.split("@")[0]).split(" ")[0];
    const when = wedding.date ? formatDate(wedding.date, { weekday: "short", day: "numeric", month: "long", year: "numeric" }) : "Date to be decided";
    const left = countdown(wedding.date, wedding.timeZone);
    const today = todayIso(wedding.timeZone);

    const invited = stats ? stats.rsvp.attending + stats.rsvp.declined + stats.rsvp.pending : 0;

    return (
        <>
            <PageTitle title={`${greeting(wedding.timeZone)}, ${name}`} subtitle={left ? `${when} · ${left}` : when} />

            {isOn("module.planning") && can("wedding.planning.edit") && <QuickAddTask />}

            {error && !stats ? (
                <Section>
                    <LoadError error={error} onRetry={reload} />
                </Section>
            ) : !stats ? (
                <Section>{loading && <LoadingRows rows={3} />}</Section>
            ) : (
                <>
                    <Section label="RSVPs" action={<SectionLink onClick={() => go("guests")}>Guests</SectionLink>}>
                        <StatGrid>
                            <StatTile label="Coming" value={stats.rsvp.attending} tone="success" />
                            <StatTile label="Awaiting" value={stats.rsvp.pending} tone={stats.rsvp.pending ? "warning" : "default"} />
                            <StatTile label="Declined" value={stats.rsvp.declined} />
                            <StatTile label="Replied" value={`${percent(stats.rsvp.attending + stats.rsvp.declined, invited)}%`} />
                        </StatGrid>
                        {stats.events.length > 0 && (
                            <ul className="mt-4 flex flex-col gap-3" aria-label="By event">
                                {stats.events.map((event) => (
                                    <li key={event.id} className="flex flex-col gap-1.5">
                                        <div className="flex items-baseline justify-between gap-3 text-sm">
                                            <span className="truncate font-medium text-secondary">{event.name}</span>
                                            <span className="shrink-0 text-tertiary tabular-nums">
                                                {event.attending} coming · {event.pending} awaiting
                                            </span>
                                        </div>
                                        <ProgressBar value={percent(event.attending + event.declined, event.invited)} aria-label={`${event.name}: replies`} />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Section>

                    {stats.tasks && (
                        <Section
                            label="Up next"
                            flush
                            action={
                                <SectionLink onClick={() => go("tasks")}>{stats.tasks.overdue ? `${stats.tasks.overdue} overdue` : "All tasks"}</SectionLink>
                            }
                        >
                            {stats.tasks.dueSoon.length === 0 ? (
                                <EmptyRow icon={CheckCircle}>Nothing due in the next month.</EmptyRow>
                            ) : (
                                <RowList label="Tasks due soon">
                                    {stats.tasks.dueSoon.map((task) => (
                                        <TaskDueRow key={task.id} task={task} today={today} />
                                    ))}
                                </RowList>
                            )}
                        </Section>
                    )}

                    {stats.budget && <BudgetSnapshot budget={stats.budget} today={today} />}

                    {(stats.followUp.notStarted > 0 || stats.followUp.partial > 0 || stats.followUp.travel > 0) && (
                        <Section label="Follow up" flush>
                            <RowList>
                                {stats.followUp.notStarted > 0 && (
                                    <Row title={pluralise(stats.followUp.notStarted, "household")} detail="Haven't replied yet" onPress={() => go("guests")} />
                                )}
                                {stats.followUp.partial > 0 && (
                                    <Row
                                        title={pluralise(stats.followUp.partial, "household")}
                                        detail="Replied for only some of their guests"
                                        onPress={() => go("guests")}
                                    />
                                )}
                                {stats.followUp.travel > 0 && (
                                    <Row title={pluralise(stats.followUp.travel, "household")} detail="Transport or accommodation to check" />
                                )}
                            </RowList>
                        </Section>
                    )}

                    {stats.recentResponses.length > 0 && (
                        <Section label="Recent replies" flush>
                            <RowList>
                                {stats.recentResponses.slice(0, 5).map((response) => (
                                    <Row
                                        key={`${response.householdName}-${response.submittedAt}`}
                                        title={response.householdName}
                                        detail={`${response.attending} coming · ${response.declined} declined · ${formatRelative(response.submittedAt)}`}
                                    />
                                ))}
                            </RowList>
                        </Section>
                    )}

                    {stats.seating && stats.seating.attending > 0 && (
                        <Section label="Seating" action={<SectionLink onClick={() => go("seating")}>Tables</SectionLink>}>
                            <ProgressBar
                                value={percent(stats.seating.seated, stats.seating.attending)}
                                labelPosition="bottom"
                                aria-label="Guests seated"
                                valueFormatter={() => `${stats.seating!.seated} of ${stats.seating!.attending} seated`}
                            />
                        </Section>
                    )}
                </>
            )}
        </>
    );
};
