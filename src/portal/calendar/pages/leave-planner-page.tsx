// Plan time off: questions answered from real calendar days. Weekends, NSW public holidays, your
// non-working days and leave already booked are free; everything else costs that day's hours. The
// answers come from the same planner the MCP tools and Chief of Staff use, never from a model.
import { type ReactNode, useState } from "react";
import { Flag01, GraduationHat01, Plus, Sun, Users01, Zap } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { DateField } from "@/portal/components/date-field";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { schoolHolidaysBetween } from "@/shared/calendar/holidays";
import { addDays, rangeLabel } from "@/shared/calendar/time";
import type { LeaveData } from "@/shared/calendar/types";
import { calendarApi } from "../api";
import { BookingDialog, type BookingDraft, LeaveSetup, h, newBooking } from "../leave-ui";
import { CalendarHeader, Card } from "../shared";

interface BreakOut {
    start: string;
    end: string;
    daysOff: number;
    leaveDays: number;
    leaveHours: number;
    leaveDates: string[];
    publicHolidays: { date: string; name: string }[];
    daysOffPerLeaveDay: number;
}
interface BalanceOut {
    leaveType: { id: string; name: string };
    balanceBefore: number;
    balanceAfter: number;
    negative: boolean;
}

const BreakResult = ({
    b,
    balance,
    onSave,
    year,
    extra,
}: {
    b: BreakOut;
    balance?: BalanceOut | null;
    onSave: (b: BreakOut) => void;
    year: string;
    extra?: ReactNode;
}) => (
    <div className="bg-secondary_subtle flex flex-col gap-3 rounded-lg p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-semibold text-primary">
                {b.daysOff} days off · {rangeLabel(b.start, b.end, year)}
            </p>
            <p className="text-sm text-tertiary">
                {b.leaveDays ? `${b.leaveDays} day${b.leaveDays === 1 ? "" : "s"} of leave (${h(b.leaveHours)})` : "No leave needed"}
                {b.publicHolidays.length ? ` · includes ${b.publicHolidays.map((p) => p.name).join(", ")}` : ""}
                {b.leaveDays ? ` · ${b.daysOffPerLeaveDay} days off per day of leave` : ""}
            </p>
            {balance && (
                <p className={balance.negative ? "text-sm text-error-primary" : "text-sm text-tertiary"}>
                    {balance.leaveType.name}: {h(balance.balanceBefore)} → {h(balance.balanceAfter)} afterwards{balance.negative ? " (goes below zero)" : ""}
                </p>
            )}
            {extra}
        </div>
        {b.leaveDays > 0 && (
            <Button size="sm" color="secondary" iconLeading={Plus} onClick={() => onSave(b)} className="shrink-0">
                Save as proposal
            </Button>
        )}
    </div>
);

const Question = ({ icon: Icon, title, description, children }: { icon: typeof Sun; title: string; description: string; children: ReactNode }) => (
    <Card title={title} description={description} actions={<Icon aria-hidden="true" className="size-5 text-fg-quaternary" />}>
        {children}
    </Card>
);

export const LeavePlannerPage = ({ data }: { data: PageData<"calendar-leave-planner"> }) => {
    const toast = useToast();
    const [leave, setLeave] = useState<LeaveData>(data.leave);
    const [dialog, setDialog] = useState<BookingDraft | null>(null);
    const [answers, setAnswers] = useState<Record<string, Record<string, unknown> | null>>({});
    const [busy, setBusy] = useState<string | null>(null);
    const today = data.today;
    const year = today.slice(0, 4);
    const division = data.preferences.schoolDivision === "western" ? "western" : "eastern";
    const periods = schoolHolidaysBetween(today, addDays(today, 540), division);
    const [period, setPeriod] = useState(
        new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("school") ?? periods[0]?.id ?? "",
    );
    const [budget, setBudget] = useState("35");
    const [phBudget, setPhBudget] = useState("38");
    const [cover, setCover] = useState<{ start: string | null; end: string | null }>({ start: null, end: null });
    const [partner, setPartner] = useState(leave.sharedWithMe[0]?.owner.email ?? "");
    const [jointBudget, setJointBudget] = useState("38");

    if (!leave.types.length)
        return (
            <>
                <CalendarHeader shell={data} title="Plan time off" crumb={{ label: "Plan time off" }} />
                <LeaveSetup today={today} onDone={setLeave} />
            </>
        );

    const ask = async (key: string, question: Record<string, unknown>) => {
        setBusy(key);
        try {
            const { answer } = await calendarApi.plan(question);
            setAnswers((a) => ({ ...a, [key]: answer }));
        } catch (error) {
            toast.error("Couldn't work that out", errorMessage(error));
        } finally {
            setBusy(null);
        }
    };
    const save = (b: BreakOut) => {
        const first = b.leaveDates[0] ?? b.start;
        const last = b.leaveDates.at(-1) ?? b.end;
        setDialog({ ...newBooking(leave, first, last), title: "Planned break" });
    };
    const a = answers as Record<string, Record<string, unknown> | undefined>;

    return (
        <>
            <CalendarHeader
                shell={data}
                title="Plan time off"
                description="Find the best times to take leave. Weekends, NSW public holidays and leave you've already booked cost nothing; each working day costs its hours from your pattern."
                crumb={{ label: "Plan time off" }}
            />
            {!leave.profile.configured && (
                <Notice color="warning" title="Using a standard 38-hour week">
                    Set your own work pattern in Leave settings for accurate answers.
                </Notice>
            )}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <Question
                    icon={GraduationHat01}
                    title="Leave for the school holidays"
                    description="How much leave to be off for a whole school holiday period, and your balance afterwards."
                >
                    {periods.length ? (
                        <>
                            <div className="flex flex-wrap items-end gap-3">
                                <Select
                                    label="School holidays"
                                    className="min-w-64 flex-1"
                                    value={period}
                                    onChange={(k) => k && setPeriod(String(k))}
                                    items={periods.map((p) => ({
                                        id: p.id,
                                        label: `${p.name} ${rangeLabel(p.start, p.end, year)}${p.provisional ? " (provisional)" : ""}`,
                                    }))}
                                >
                                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                </Select>
                                <Button
                                    size="md"
                                    isLoading={busy === "school"}
                                    onClick={() => {
                                        const p = periods.find((x) => x.id === period);
                                        if (p) void ask("school", { question: "cover_period", start: p.start, end: p.end });
                                    }}
                                >
                                    Work it out
                                </Button>
                            </div>
                            {a.school?.withWeekendsAround ? (
                                <BreakResult
                                    b={a.school.withWeekendsAround as BreakOut}
                                    balance={a.school.balance as BalanceOut | null}
                                    year={year}
                                    onSave={save}
                                    extra={
                                        <p className="text-sm text-tertiary">
                                            {h(a.school.leaveHours as number)} of leave for the holiday weekdays themselves.
                                        </p>
                                    }
                                />
                            ) : null}
                        </>
                    ) : (
                        <p className="text-sm text-tertiary">No upcoming school holidays in the official dates.</p>
                    )}
                </Question>

                <Question
                    icon={Sun}
                    title="The longest break for your hours"
                    description="The longest run of days off a number of leave hours can make in the next year."
                >
                    <div className="flex flex-wrap items-end gap-3">
                        <Input label="Hours of leave" type="number" className="w-40" value={budget} onChange={setBudget} />
                        <Button
                            size="md"
                            isLoading={busy === "longest"}
                            onClick={() => void ask("longest", { question: "longest_break", budgetHours: Number(budget) || 0 })}
                        >
                            Find it
                        </Button>
                    </div>
                    {a.longest &&
                        (a.longest.best ? (
                            <BreakResult b={a.longest.best as BreakOut} balance={a.longest.balance as BalanceOut | null} year={year} onSave={save} />
                        ) : (
                            <p className="text-sm text-tertiary">No break found.</p>
                        ))}
                </Question>

                <Question
                    icon={Flag01}
                    title="Best public holiday opportunities"
                    description="Breaks that bridge weekends and NSW public holidays for the least leave, best first."
                >
                    <div className="flex flex-wrap items-end gap-3">
                        <Input label="At most (hours)" type="number" className="w-40" value={phBudget} onChange={setPhBudget} />
                        <Button
                            size="md"
                            isLoading={busy === "ph"}
                            onClick={() => void ask("ph", { question: "public_holidays", budgetHours: Number(phBudget) || 0 })}
                        >
                            Show opportunities
                        </Button>
                    </div>
                    {a.ph && (
                        <div className="flex flex-col gap-2">
                            {((a.ph.opportunities as (BreakOut & { balance: BalanceOut | null })[]) ?? []).map((o) => (
                                <BreakResult key={o.start} b={o} balance={o.balance} year={year} onSave={save} />
                            ))}
                            {!(a.ph.opportunities as unknown[])?.length && <p className="text-sm text-tertiary">Nothing within that many hours.</p>}
                            {a.ph.coverage ? <p className="text-xs text-quaternary">{String(a.ph.coverage)}</p> : null}
                        </div>
                    )}
                </Question>

                <Question
                    icon={Zap}
                    title="What would a break cost?"
                    description="The leave hours for any dates and your balance afterwards, e.g. two weeks in October."
                >
                    <div className="flex flex-wrap items-end gap-3">
                        <DateField
                            label="First day off"
                            value={cover.start}
                            onChange={(start) => setCover({ start, end: cover.end && start && cover.end < start ? start : cover.end })}
                        />
                        <DateField label="Last day off" value={cover.end} onChange={(end) => setCover({ ...cover, end })} />
                        <Button
                            size="md"
                            isDisabled={!cover.start || !cover.end}
                            isLoading={busy === "cover"}
                            onClick={() => void ask("cover", { question: "cover_period", start: cover.start, end: cover.end })}
                        >
                            Work it out
                        </Button>
                    </div>
                    {a.cover?.withWeekendsAround ? (
                        <BreakResult
                            b={{ ...(a.cover.withWeekendsAround as BreakOut), leaveHours: a.cover.leaveHours as number }}
                            balance={a.cover.balance as BalanceOut | null}
                            year={year}
                            onSave={() => setDialog({ ...newBooking(leave, cover.start!, cover.end!), title: "Planned break" })}
                            extra={
                                <p className="text-sm text-tertiary">
                                    {a.cover.workingDays as number} working days in the dates you chose. {a.cover.coverage ? String(a.cover.coverage) : ""}
                                </p>
                            }
                        />
                    ) : null}
                </Question>

                <Question
                    icon={GraduationHat01}
                    title="School holidays without leave"
                    description="Upcoming school holidays and whether you've planned any leave in them."
                >
                    <Button
                        size="md"
                        color="secondary"
                        className="self-start"
                        isLoading={busy === "uncovered"}
                        onClick={() => void ask("uncovered", { question: "school_holidays" })}
                    >
                        Check
                    </Button>
                    {a.uncovered && (
                        <ul className="flex flex-col divide-y divide-secondary">
                            {(
                                (a.uncovered.periods as {
                                    id: string;
                                    name: string;
                                    start: string;
                                    end: string;
                                    leavePlanned: boolean;
                                    toCoverAll: BreakOut | null;
                                    provisional: boolean;
                                }[]) ?? []
                            ).map((p) => (
                                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                                    <span className="flex flex-col">
                                        <span className="text-sm font-medium text-primary">
                                            {p.name} {p.provisional ? "(provisional)" : ""}
                                        </span>
                                        <span className="text-sm text-tertiary">
                                            {rangeLabel(p.start, p.end, year)}
                                            {p.toCoverAll ? ` · ${h(p.toCoverAll.leaveHours)} to cover it all` : ""}
                                        </span>
                                    </span>
                                    <Badge size="sm" color={p.leavePlanned ? "success" : "warning"}>
                                        {p.leavePlanned ? "Leave planned" : "No leave planned"}
                                    </Badge>
                                </li>
                            ))}
                        </ul>
                    )}
                </Question>

                <Question
                    icon={Users01}
                    title="Time off together"
                    description="Breaks you and someone who shares their leave with you can both take. Each of you is costed on your own hours."
                >
                    {leave.sharedWithMe.length ? (
                        <>
                            <div className="flex flex-wrap items-end gap-3">
                                <Select
                                    label="With"
                                    className="min-w-48 flex-1"
                                    value={partner}
                                    onChange={(k) => k && setPartner(String(k))}
                                    items={leave.sharedWithMe.map((s) => ({ id: s.owner.email, label: s.owner.name ?? s.owner.email }))}
                                >
                                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                </Select>
                                <Input label="Hours each" type="number" className="w-32" value={jointBudget} onChange={setJointBudget} />
                                <Button
                                    size="md"
                                    isLoading={busy === "joint"}
                                    onClick={() => void ask("joint", { question: "joint", with: partner, budgetHours: Number(jointBudget) || 0 })}
                                >
                                    Find times
                                </Button>
                            </div>
                            {a.joint &&
                                (a.joint.available === false ? (
                                    <p className="text-sm text-tertiary">{String(a.joint.note)}</p>
                                ) : (
                                    <ul className="flex flex-col gap-2">
                                        {(
                                            (a.joint.breaks as {
                                                start: string;
                                                end: string;
                                                daysOffTogether: number;
                                                yours: { leaveDays: number; leaveHours: number };
                                                theirs: { leaveDays: number; leaveHours: number };
                                            }[]) ?? []
                                        ).map((b) => (
                                            <li key={b.start} className="bg-secondary_subtle rounded-lg p-3 text-sm">
                                                <p className="font-semibold text-primary">
                                                    {b.daysOffTogether} days together · {rangeLabel(b.start, b.end, year)}
                                                </p>
                                                <p className="text-tertiary">
                                                    You: {b.yours.leaveDays} days ({h(b.yours.leaveHours)}) · Them: {b.theirs.leaveDays} days (
                                                    {h(b.theirs.leaveHours)})
                                                </p>
                                            </li>
                                        ))}
                                    </ul>
                                ))}
                        </>
                    ) : (
                        <p className="text-sm text-tertiary">
                            Nobody shares their leave with you yet. Each person can share theirs in Leave settings → Sharing; balances are never shared.
                        </p>
                    )}
                </Question>
            </div>
            {dialog && <BookingDialog leave={leave} initial={dialog} onClose={() => setDialog(null)} onSaved={setLeave} />}
        </>
    );
};
