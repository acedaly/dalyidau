// Plan My Day: the planner's proposed sessions for a day, shown before anything changes. Each one can
// be accepted, rejected or adjusted (start and length), and only the accepted ones are created when
// the person approves the plan. Meetings, other sessions and task dates are never moved. Used on its
// own (the Plan My Day dialog) and inside Morning planning.
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, Stars02 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { clientId } from "@/portal/calendar/api";
import { durationLabel } from "@/portal/calendar/planner-api";
import { DURATIONS } from "@/portal/calendar/planner-ui";
import { PortalDialog } from "@/portal/components/dialog";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import { longDateLabel, timeLabel } from "@/shared/calendar/time";
import type { PlanProposal } from "@/shared/today/types";
import { todayApi } from "./today-api";

interface Draft {
    id: string;
    accepted: boolean;
    startTime: string;
    durationMinutes: number;
}

/** Loads a proposal for a day (optionally for chosen tasks) and lets the person decide on each session. */
export function useProposal(date: string, taskIds?: string[]) {
    const [proposal, setProposal] = useState<PlanProposal | null>(null);
    const [drafts, setDrafts] = useState<Record<string, Draft>>({});
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const { proposal: p } = await todayApi.propose({ date, ...(taskIds?.length ? { taskIds } : {}) });
            setProposal(p);
            setDrafts(
                Object.fromEntries(p.suggestions.map((s) => [s.id, { id: s.id, accepted: true, startTime: s.startTime, durationMinutes: s.durationMinutes }])),
            );
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setLoading(false);
        }
    };
    const accepted = proposal?.suggestions.filter((s) => drafts[s.id]?.accepted) ?? [];
    return { proposal, drafts, setDrafts, error, loading, load, accepted };
}

export type Proposal = ReturnType<typeof useProposal>;

/** Creates the accepted sessions. Each has its own client id, so trying again never doubles one up. */
export async function applyProposal(p: Proposal, date: string) {
    const items = p.accepted.map((s) => ({
        taskId: s.taskId,
        startDate: s.startDate,
        startTime: p.drafts[s.id].startTime,
        durationMinutes: p.drafts[s.id].durationMinutes,
        occurrenceDate: s.occurrenceDate,
        clientId: clientId(),
    }));
    return todayApi.apply(date, items);
}

export const ProposalEditor = ({ p }: { p: Proposal }) => {
    if (p.error)
        return (
            <Notice color="warning" title="Couldn't propose a plan">
                {p.error}
            </Notice>
        );
    if (!p.proposal) return <p className="text-sm text-tertiary">{p.loading ? "Working out a plan…" : "No plan yet."}</p>;
    const { proposal, drafts, setDrafts } = p;
    const set = (id: string, change: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...change } }));
    const total = p.accepted.reduce((s, x) => s + drafts[x.id].durationMinutes, 0);
    return (
        <div className="flex flex-col gap-4">
            <p className="text-sm text-secondary">
                {durationLabel(proposal.capacityBefore.freeMinutes)} free before this plan.{" "}
                {proposal.suggestions.length ? `${p.accepted.length} of ${proposal.suggestions.length} sessions accepted (${durationLabel(total)}).` : ""}
            </p>
            {proposal.suggestions.length ? (
                <ul aria-label="Proposed sessions" className="flex flex-col gap-2">
                    {proposal.suggestions.map((s) => {
                        const d = drafts[s.id];
                        return (
                            <li
                                key={s.id}
                                data-proposal={s.taskId}
                                className="flex flex-col gap-3 rounded-lg p-3 ring-1 ring-secondary ring-inset data-[rejected=true]:opacity-60"
                                data-rejected={!d.accepted}
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <Checkbox
                                        isSelected={d.accepted}
                                        onChange={(v) => set(s.id, { accepted: v })}
                                        label={s.title}
                                        hint={`${timeLabel(s.startTime)} – ${timeLabel(s.endTime)} proposed · ${s.reason}${s.sessions > 1 ? ` · session ${s.session} of ${s.sessions}` : ""}`}
                                    />
                                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                                        {s.inFocus && (
                                            <Badge size="sm" color="brand">
                                                Focus period
                                            </Badge>
                                        )}
                                        {s.late && (
                                            <Badge size="sm" color="warning">
                                                After it's due
                                            </Badge>
                                        )}
                                    </div>
                                </div>
                                {d.accepted && (
                                    <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
                                        <Input size="sm" type="time" label="Start" value={d.startTime} onChange={(v) => v && set(s.id, { startTime: v })} />
                                        <Select
                                            size="sm"
                                            label="Length"
                                            value={String(d.durationMinutes)}
                                            onChange={(k) => k && set(s.id, { durationMinutes: Number(k) })}
                                            items={[...new Set([...DURATIONS, s.durationMinutes, d.durationMinutes])]
                                                .sort((a, b) => a - b)
                                                .map((m) => ({ id: String(m), label: durationLabel(m) }))}
                                        >
                                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                        </Select>
                                    </div>
                                )}
                                {s.conflicts.length > 0 && (
                                    <p className="flex items-center gap-1 text-xs text-warning-primary">
                                        <AlertTriangle aria-hidden="true" className="size-3" />
                                        {s.conflicts.map((c) => c.message).join("; ")}
                                    </p>
                                )}
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <p className="text-sm text-tertiary">Nothing to propose: everything due is planned, or there's no free time left.</p>
            )}
            {proposal.unplaced.length > 0 && (
                <Notice title="Didn't fit">
                    {proposal.unplaced.map((u) => `${u.title} (${durationLabel(u.remainingMinutes)} more)`).join(", ")}. Postpone something, or plan it on
                    another day.
                </Notice>
            )}
            <p className="text-xs text-tertiary">{proposal.note} Changed times are checked again for conflicts when they're created.</p>
        </div>
    );
};

export const PlanMyDayDialog = ({
    date,
    isOpen,
    onOpenChange,
    onApplied,
}: {
    date: string;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onApplied: () => void;
}) => {
    const toast = useToast();
    const p = useProposal(date);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (isOpen) void p.load();
        // Load a fresh proposal each time it opens.
    }, [isOpen]);
    const approve = async () => {
        setBusy(true);
        try {
            const result = await applyProposal(p, date);
            const conflicts = result.created.reduce((n, c) => n + c.conflicts.length, 0);
            if (result.failed.length)
                toast.show({
                    title: `Planned ${result.created.length}, ${result.failed.length} couldn't be`,
                    description: result.failed.map((f) => f.message).join("; "),
                    color: "warning",
                });
            else
                toast.success(
                    `Planned ${result.created.length} ${result.created.length === 1 ? "session" : "sessions"}`,
                    conflicts ? `${conflicts} with conflicts to look at` : undefined,
                );
            onOpenChange(false);
            onApplied();
        } catch (error) {
            toast.error("Couldn't apply the plan", errorMessage(error));
        } finally {
            setBusy(false);
        }
    };
    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title="Plan my day"
            description={`Proposed sessions for ${longDateLabel(date)}, from due dates, priorities, estimates, free time and your focus periods. Nothing changes until you approve.`}
            icon={Stars02}
            size="xl"
            footer={
                <>
                    <Button color="secondary" size="lg" onClick={() => onOpenChange(false)} isDisabled={busy}>
                        Cancel
                    </Button>
                    <Button
                        size="lg"
                        iconLeading={CheckCircle}
                        onClick={() => void approve()}
                        isLoading={busy}
                        showTextWhileLoading
                        isDisabled={!p.accepted.length}
                    >
                        {p.accepted.length ? `Approve ${p.accepted.length} ${p.accepted.length === 1 ? "session" : "sessions"}` : "Approve"}
                    </Button>
                </>
            }
        >
            <ProposalEditor p={p} />
        </PortalDialog>
    );
};
