// Morning planning and the evening review: two optional routines the person starts themselves.
//
// Morning: review the day, choose the top three, confirm the capacity, look at proposed sessions,
// approve the plan. Evening: review what got done, decide what happens to each unfinished session
// (reschedule it, return the task to the unscheduled list, or leave it), preview tomorrow, and note
// anything worth keeping plus follow-up tasks. Nothing moves unless the person chooses it: every
// change goes through the Daily Planner or Tasks with their own permissions and history, and only
// the person's choices (ids and counts, and their note) are recorded for the day.
import { useEffect, useMemo, useState } from "react";
import { CheckCircle, Moon01, Plus, Sunrise, Trash01 } from "@untitledui/icons";
import { Progress } from "@/components/application/progress-steps/progress-steps";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { RadioButton, RadioGroup } from "@/components/base/radio-buttons/radio-buttons";
import { TextArea } from "@/components/base/textarea/textarea";
import { clientId } from "@/portal/calendar/api";
import { durationLabel, plannerApi } from "@/portal/calendar/planner-api";
import { DateField } from "@/portal/components/date-field";
import { PortalDialog } from "@/portal/components/dialog";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { tasksApi } from "@/portal/tasks/api";
import { addDays, dayLabel, longDateLabel, timeLabel } from "@/shared/calendar/time";
import type { PlannerTask, TimeBlockInfo } from "@/shared/planner/types";
import type { DailyReview, TodayCapacity, TodayDashboard } from "@/shared/today/types";
import { ProposalEditor, applyProposal, useProposal } from "./plan-my-day";
import { STATUS } from "./sections";
import { todayApi } from "./today-api";

type Status = "incomplete" | "current" | "complete";
const steps = (titles: [string, string][], current: number) =>
    titles.map(([title, description], i): { title: string; description: string; status: Status } => ({
        title,
        description,
        status: i < current ? "complete" : i === current ? "current" : "incomplete",
    }));

const Steps = ({ titles, current }: { titles: [string, string][]; current: number }) => (
    <nav aria-label="Steps" className="max-sm:hidden">
        <Progress.TextWithLine items={steps(titles, current)} size="sm" />
    </nav>
);

const StepHeading = ({ n, total, children }: { n: number; total: number; children: string }) => (
    <h3 className="text-md font-semibold text-primary" aria-live="polite">
        <span className="sr-only">
            Step {n + 1} of {total}:{" "}
        </span>
        {children}
    </h3>
);

const CapacityLine = ({ c }: { c: TodayCapacity }) => (
    <p className="flex flex-wrap items-center gap-2 text-sm text-secondary">
        <BadgeWithDot size="sm" type="modern" color={STATUS[c.status].color}>
            {STATUS[c.status].label}
        </BadgeWithDot>
        {c.availableMinutes
            ? `${durationLabel(c.availableMinutes)} available · ${durationLabel(c.appointmentMinutes)} appointments · ${durationLabel(c.taskMinutes)} task time · ${durationLabel(c.freeMinutes)} free`
            : (c.offReason ?? "No planning hours")}
    </p>
);

// --- Morning ---------------------------------------------------------------------------------------

const MORNING: [string, string][] = [
    ["Review", "Your day"],
    ["Priorities", "Top three"],
    ["Capacity", "Confirm"],
    ["Sessions", "Suggested"],
    ["Approve", "The plan"],
];

export const MorningPlanning = ({
    data,
    isOpen,
    onOpenChange,
    onDone,
}: {
    data: TodayDashboard;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onDone: () => void;
}) => {
    const toast = useToast();
    const [step, setStep] = useState(0);
    const [busy, setBusy] = useState(false);
    const existing = data.reviews.morning;
    const byId = useMemo(() => new Map(data.lists.tasks.map((t) => [t.id, t])), [data.lists.tasks]);
    const candidates = useMemo(() => {
        const ids = [...new Set([...data.lists.buckets.overdue, ...data.lists.buckets.today, ...data.lists.buckets.priority, ...data.lists.buckets.upcoming])];
        return ids
            .map((id) => byId.get(id))
            .filter((t): t is PlannerTask => !!t)
            .slice(0, 25);
    }, [data.lists, byId]);
    const initial = existing?.priorities.length ? existing.priorities : data.briefing.priorities.map((p) => p.id);
    const [priorities, setPriorities] = useState<string[]>(initial.filter((id) => byId.has(id)).slice(0, 3));
    const [confirmed, setConfirmed] = useState(existing?.summary.capacityConfirmed ?? false);
    const planFor = [...new Set([...priorities, ...data.lists.buckets.today, ...data.lists.buckets.overdue])].slice(0, 50);
    const p = useProposal(data.date, planFor);

    useEffect(() => {
        if (isOpen) setStep(0);
    }, [isOpen]);
    useEffect(() => {
        if (isOpen && step === 3) void p.load();
        // A fresh proposal for the chosen priorities each time the step opens.
    }, [isOpen, step]);

    const toggle = (id: string, on: boolean) => setPriorities((list) => (on ? (list.length < 3 ? [...list, id] : list) : list.filter((x) => x !== id)));

    const finish = async () => {
        setBusy(true);
        try {
            const result = p.accepted.length ? await applyProposal(p, data.date) : { created: [], failed: [] };
            await todayApi.saveReview(data.date, "morning", {
                priorities,
                summary: { planned: result.created.length, capacityConfirmed: confirmed },
                version: existing?.version ?? 0,
            });
            toast.success(
                "Morning planning done",
                `${result.created.length} ${result.created.length === 1 ? "session" : "sessions"} planned${result.failed.length ? `, ${result.failed.length} couldn't be` : ""}`,
            );
            onOpenChange(false);
            onDone();
        } catch (error) {
            toast.error("Couldn't finish morning planning", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const last = MORNING.length - 1;
    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title="Morning planning"
            description={longDateLabel(data.date)}
            icon={Sunrise}
            size="xl"
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={() => (step ? setStep(step - 1) : onOpenChange(false))} isDisabled={busy}>
                        {step ? "Back" : "Cancel"}
                    </Button>
                    {step < last ? (
                        <Button size="lg" onClick={() => setStep(step + 1)}>
                            Next
                        </Button>
                    ) : (
                        <Button size="lg" iconLeading={CheckCircle} onClick={() => void finish()} isLoading={busy} showTextWhileLoading>
                            Approve the plan
                        </Button>
                    )}
                </>
            }
        >
            <Steps titles={MORNING} current={step} />
            {step === 0 && (
                <div className="flex flex-col gap-3">
                    <StepHeading n={0} total={MORNING.length}>
                        Review the day
                    </StepHeading>
                    <CapacityLine c={data.capacity} />
                    {data.briefing.commitments.length ? (
                        <ul className="flex flex-col gap-1 text-sm">
                            {data.briefing.commitments.map((c) => (
                                <li key={c.id}>
                                    <span className="text-tertiary">{c.detail}</span> · <span className="text-primary">{c.title}</span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">Nothing in the calendar yet.</p>
                    )}
                    {(data.briefing.overdue.length > 0 || data.briefing.unfinishedYesterday.length > 0) && (
                        <Notice title="Carried over">
                            {[
                                data.briefing.overdue.length && `${data.briefing.overdue.length} overdue`,
                                data.briefing.unfinishedYesterday.length && `${data.briefing.unfinishedYesterday.length} unfinished from yesterday`,
                            ]
                                .filter(Boolean)
                                .join(", ")}
                            .
                        </Notice>
                    )}
                </div>
            )}
            {step === 1 && (
                <fieldset className="flex flex-col gap-3">
                    <legend className="sr-only">Step 2 of 5: top three priorities</legend>
                    <StepHeading n={1} total={MORNING.length}>
                        Choose today's top three
                    </StepHeading>
                    <p className="text-sm text-tertiary">{priorities.length} of 3 chosen. Suggested from overdue work, due dates and priority.</p>
                    {candidates.length ? (
                        <ul className="flex flex-col gap-2">
                            {candidates.map((t) => (
                                <li key={t.id}>
                                    <Checkbox
                                        isSelected={priorities.includes(t.id)}
                                        isDisabled={!priorities.includes(t.id) && priorities.length >= 3}
                                        onChange={(on) => toggle(t.id, on)}
                                        label={t.title}
                                        hint={[`P${t.priority}`, t.dueDate ? dayLabel(t.dueDate) : null, t.projectName].filter(Boolean).join(" · ")}
                                    />
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">Nothing due or high priority. Add tasks with Quick capture.</p>
                    )}
                </fieldset>
            )}
            {step === 2 && (
                <div className="flex flex-col gap-3">
                    <StepHeading n={2} total={MORNING.length}>
                        Confirm your capacity
                    </StepHeading>
                    <CapacityLine c={data.capacity} />
                    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-tertiary">
                        {data.capacity.explanation.map((l) => (
                            <li key={l}>{l}</li>
                        ))}
                    </ul>
                    <Checkbox
                        isSelected={confirmed}
                        onChange={setConfirmed}
                        label="This is right for today"
                        hint="To change your hours, breaks or focus periods, use Customise on Today."
                    />
                </div>
            )}
            {step === 3 && (
                <div className="flex flex-col gap-3">
                    <StepHeading n={3} total={MORNING.length}>
                        Suggested sessions
                    </StepHeading>
                    <ProposalEditor p={p} />
                </div>
            )}
            {step === 4 && (
                <div className="flex flex-col gap-3">
                    <StepHeading n={4} total={MORNING.length}>
                        Approve the plan
                    </StepHeading>
                    <p className="text-sm text-secondary">
                        Top three: {priorities.length ? priorities.map((id) => byId.get(id)?.title ?? "a task").join(", ") : "none chosen"}.
                    </p>
                    <p className="text-sm text-secondary">
                        {p.accepted.length
                            ? `${p.accepted.length} ${p.accepted.length === 1 ? "session" : "sessions"} will be planned: ${p.accepted.map((s) => `${s.title} at ${timeLabel(p.drafts[s.id].startTime)}`).join(", ")}.`
                            : "No sessions will be planned."}
                    </p>
                    <p className="text-xs text-tertiary">Nothing already in your calendar moves, and no task's dates change.</p>
                </div>
            )}
        </PortalDialog>
    );
};

// --- Evening ---------------------------------------------------------------------------------------

const EVENING: [string, string][] = [
    ["Done", "Completed work"],
    ["Unfinished", "Decide"],
    ["Tomorrow", "Preview"],
    ["Notes", "Follow-ups"],
];

type Decision = { action: "keep" } | { action: "reschedule"; date: string; time: string } | { action: "return" };

export const EveningReview = ({
    data,
    isOpen,
    onOpenChange,
    onDone,
}: {
    data: TodayDashboard;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onDone: () => void;
}) => {
    const toast = useToast();
    const tomorrow = addDays(data.date, 1);
    const existing: DailyReview | null = data.reviews.evening;
    const [step, setStep] = useState(0);
    const [busy, setBusy] = useState(false);
    const [decisions, setDecisions] = useState<Record<string, Decision>>({});
    const [preview, setPreview] = useState<Pick<TodayDashboard, "capacity" | "timeline"> | null>(null);
    const [note, setNote] = useState(existing?.note ?? "");
    const [followUps, setFollowUps] = useState<string[]>([]);
    const [draft, setDraft] = useState("");
    const [dueTomorrow, setDueTomorrow] = useState(true);

    // Sessions planned on this day for tasks that are still open.
    const unfinished = useMemo(
        () => data.blocks.filter((b) => b.startDate === data.date && b.status === "scheduled" && b.taskStatus === "open" && !b.earlierOccurrence && b.canEdit),
        [data.blocks, data.date],
    );
    const doneBlocks = data.blocks.filter((b) => b.startDate === data.date && (b.taskStatus === "completed" || b.earlierOccurrence));

    useEffect(() => {
        if (!isOpen) return;
        setStep(0);
        setDecisions(Object.fromEntries(unfinished.map((b) => [b.id, { action: "keep" } as Decision])));
    }, [isOpen]);
    useEffect(() => {
        if (!isOpen || step !== 2 || preview) return;
        todayApi
            .get(tomorrow, ["plan"])
            .then((r) => r.today.capacity && r.today.timeline && setPreview({ capacity: r.today.capacity, timeline: r.today.timeline }))
            .catch(() => undefined);
    }, [isOpen, step]);

    const decide = (b: TimeBlockInfo, d: Decision) => setDecisions((all) => ({ ...all, [b.id]: d }));
    const suggestFor = async (b: TimeBlockInfo) => {
        try {
            const { plan } = await plannerApi.suggest({ from: tomorrow, days: 3, taskIds: [b.taskId] });
            const s = plan.suggestions[0];
            if (s) decide(b, { action: "reschedule", date: s.startDate, time: s.startTime });
            else toast.show({ title: "No free time in the next three days", description: b.title, color: "warning" });
        } catch (error) {
            toast.error("Couldn't suggest a time", errorMessage(error));
        }
    };

    const finish = async () => {
        setBusy(true);
        const counts = { rescheduled: 0, returned: 0, kept: 0, followUps: 0 };
        const problems: string[] = [];
        try {
            for (const b of unfinished) {
                const d = decisions[b.id] ?? { action: "keep" };
                try {
                    if (d.action === "reschedule") {
                        await plannerApi.update(b.id, { version: b.version, startDate: d.date, startTime: d.time });
                        counts.rescheduled++;
                    } else if (d.action === "return") {
                        // Cancelling the session frees the time; the task goes back to the unscheduled list, unchanged.
                        await plannerApi.update(b.id, { version: b.version, status: "cancelled" });
                        counts.returned++;
                    } else counts.kept++;
                } catch (error) {
                    problems.push(`${b.title}: ${errorMessage(error)}`);
                }
            }
            for (const title of followUps) {
                try {
                    await tasksApi.create({ title, ...(dueTomorrow ? { dueDate: tomorrow } : {}), clientId: clientId() });
                    counts.followUps++;
                } catch (error) {
                    problems.push(`${title}: ${errorMessage(error)}`);
                }
            }
            await todayApi.saveReview(data.date, "evening", {
                summary: { ...counts, completed: data.completed?.length ?? 0 },
                note: note.trim() || null,
                version: existing?.version ?? 0,
            });
            if (problems.length) toast.show({ title: "Evening review saved, with problems", description: problems.join("; "), color: "warning" });
            else
                toast.success(
                    "Evening review done",
                    `${counts.rescheduled} rescheduled, ${counts.returned} returned to the list, ${counts.followUps} follow-ups`,
                );
            onOpenChange(false);
            onDone();
        } catch (error) {
            toast.error("Couldn't save the review", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };

    const last = EVENING.length - 1;
    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title="Evening review"
            description={longDateLabel(data.date)}
            icon={Moon01}
            size="xl"
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={() => (step ? setStep(step - 1) : onOpenChange(false))} isDisabled={busy}>
                        {step ? "Back" : "Cancel"}
                    </Button>
                    {step < last ? (
                        <Button size="lg" onClick={() => setStep(step + 1)}>
                            Next
                        </Button>
                    ) : (
                        <Button size="lg" iconLeading={CheckCircle} onClick={() => void finish()} isLoading={busy} showTextWhileLoading>
                            Finish the day
                        </Button>
                    )}
                </>
            }
        >
            <Steps titles={EVENING} current={step} />
            {step === 0 && (
                <div className="flex flex-col gap-3">
                    <StepHeading n={0} total={EVENING.length}>
                        What got done
                    </StepHeading>
                    {(data.completed?.length ?? 0) > 0 ? (
                        <ul className="flex flex-col gap-1 text-sm">
                            {data.completed!.map((t) => (
                                <li key={t.id} className="flex items-center gap-2">
                                    <CheckCircle aria-hidden="true" className="size-4 text-fg-success-primary" />
                                    <a href={`/portal/tasks/t/${t.id}`} className="text-primary hover:underline">
                                        {t.title}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">
                            No tasks completed on this day{data.preferences.showCompleted ? "" : " (completed tasks are hidden in your Today settings)"}.
                        </p>
                    )}
                    {doneBlocks.length > 0 && (
                        <p className="text-sm text-tertiary">
                            {doneBlocks.length} planned {doneBlocks.length === 1 ? "session was" : "sessions were"} for tasks now done.
                        </p>
                    )}
                </div>
            )}
            {step === 1 && (
                <div className="flex flex-col gap-4">
                    <StepHeading n={1} total={EVENING.length}>
                        Unfinished sessions
                    </StepHeading>
                    {unfinished.length ? (
                        <ul className="flex flex-col gap-3">
                            {unfinished.map((b) => {
                                const d = decisions[b.id] ?? { action: "keep" };
                                return (
                                    <li key={b.id} data-unfinished={b.id} className="flex flex-col gap-3 rounded-lg p-3 ring-1 ring-secondary ring-inset">
                                        <p className="text-sm font-medium text-primary">
                                            {b.title}{" "}
                                            <span className="font-normal text-tertiary">
                                                · {timeLabel(b.startTime)} ({durationLabel(b.durationMinutes)})
                                            </span>
                                        </p>
                                        <RadioGroup
                                            aria-label={`What to do with ${b.title}`}
                                            value={d.action}
                                            onChange={(v) =>
                                                decide(
                                                    b,
                                                    v === "reschedule"
                                                        ? { action: "reschedule", date: tomorrow, time: b.startTime }
                                                        : ({ action: v } as Decision),
                                                )
                                            }
                                            className="gap-2"
                                        >
                                            <RadioButton value="keep" label="Leave it as it is" />
                                            <RadioButton value="reschedule" label="Reschedule it" />
                                            <RadioButton
                                                value="return"
                                                label="Return the task to the unscheduled list"
                                                hint="Cancels this session; the task doesn't change."
                                            />
                                        </RadioGroup>
                                        {d.action === "reschedule" && (
                                            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
                                                <DateField label="Date" value={d.date} onChange={(v) => v && decide(b, { ...d, date: v })} />
                                                <Input label="Start" type="time" value={d.time} onChange={(v) => v && decide(b, { ...d, time: v })} />
                                                <Button size="md" color="secondary" onClick={() => void suggestFor(b)}>
                                                    Suggest a time
                                                </Button>
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">No unfinished sessions on this day.</p>
                    )}
                    <p className="text-xs text-tertiary">Nothing moves unless you choose it here.</p>
                </div>
            )}
            {step === 2 && (
                <div className="flex flex-col gap-3">
                    <StepHeading n={2} total={EVENING.length}>
                        {`Tomorrow, ${dayLabel(tomorrow)}`}
                    </StepHeading>
                    {preview ? (
                        <>
                            <CapacityLine c={preview.capacity} />
                            {preview.timeline.items.filter((i) => i.kind === "event" || i.kind === "block").length ? (
                                <ul className="flex flex-col gap-1 text-sm">
                                    {preview.timeline.items
                                        .filter((i) => i.kind === "event" || i.kind === "block")
                                        .map((i) => (
                                            <li key={i.id}>
                                                <span className="text-tertiary">{timeLabel(i.startTime)}</span> ·{" "}
                                                <span className="text-primary">{i.title}</span>
                                                {i.kind === "block" && <span className="text-tertiary"> (task time)</span>}
                                            </li>
                                        ))}
                                </ul>
                            ) : (
                                <p className="text-sm text-tertiary">Nothing planned yet.</p>
                            )}
                        </>
                    ) : (
                        <p className="text-sm text-tertiary">Loading tomorrow…</p>
                    )}
                </div>
            )}
            {step === 3 && (
                <div className="flex flex-col gap-4">
                    <StepHeading n={3} total={EVENING.length}>
                        Notes and follow-ups
                    </StepHeading>
                    <TextArea
                        label="Notes on the day"
                        hint="Kept with today's review, private to you."
                        value={note}
                        onChange={setNote}
                        rows={4}
                        maxLength={4000}
                    />
                    <div className="flex flex-col gap-2">
                        <form
                            className="flex items-end gap-2"
                            onSubmit={(e) => {
                                e.preventDefault();
                                const title = draft.trim();
                                if (title && followUps.length < 10) setFollowUps([...followUps, title.slice(0, 300)]);
                                setDraft("");
                            }}
                        >
                            <Input label="Follow-up action" placeholder="Call the plumber" value={draft} onChange={setDraft} className="flex-1" />
                            <Button type="submit" size="md" color="secondary" iconLeading={Plus} isDisabled={!draft.trim() || followUps.length >= 10}>
                                Add
                            </Button>
                        </form>
                        {followUps.length > 0 && (
                            <ul aria-label="Follow-ups" className="flex flex-col gap-1">
                                {followUps.map((f, i) => (
                                    <li key={`${f}:${i}`} className="flex items-center justify-between gap-2 text-sm text-primary">
                                        {f}
                                        <ButtonUtility
                                            size="xs"
                                            color="tertiary"
                                            icon={Trash01}
                                            tooltip={`Remove ${f}`}
                                            onClick={() => setFollowUps(followUps.filter((_, j) => j !== i))}
                                        />
                                    </li>
                                ))}
                            </ul>
                        )}
                        <Checkbox
                            isSelected={dueTomorrow}
                            onChange={setDueTomorrow}
                            label="Make follow-ups due tomorrow"
                            hint="They're added to your Tasks Inbox."
                        />
                    </div>
                </div>
            )}
        </PortalDialog>
    );
};
