// A project review: a few minutes, one screen. What's been done since last time, what's overdue,
// what's coming, what has nobody responsible or no date, then a short note, the health you record
// and the next actions you decide on. The draft lives on the server (one per project), so closing
// this and coming back, or both people opening it, carries on the same review. Next actions are
// ordinary tasks in the project, each added explicitly; nothing is taken from the note.
import { useEffect, useState } from "react";
import { ClipboardCheck, Plus } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { RadioButton, RadioGroup } from "@/components/base/radio-buttons/radio-buttons";
import { TextArea } from "@/components/base/textarea/textarea";
import { DateField } from "@/portal/components/date-field";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { Skeleton } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { formatRelative } from "@/portal/lib/format";
import { HEALTH_LABELS, HEALTH_STATUSES, type HealthStatus, type ReviewWorkspace } from "@/shared/tasks/productivity";
import { productivityApi } from "./productivity-api";
import { HealthBadge, HealthReasons, Quiet, TaskLines } from "./productivity-ui";
import { draftId } from "./quick-add-events";
import { useTasks } from "./tasks-context";

const issues = (e: unknown) => (e instanceof ApiError && e.issues.length ? e.issues.map((i) => i.message).join(" ") : errorMessage(e));

export const ProjectReviewDialog = ({
    projectId,
    projectName,
    onClose,
    onDone,
}: {
    projectId: string;
    projectName: string;
    onClose: () => void;
    onDone: () => void;
}) => {
    const toast = useToast();
    const { emit } = useTasks();
    const [ws, setWs] = useState<ReviewWorkspace | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const [note, setNote] = useState("");
    const [health, setHealth] = useState<HealthStatus | null>(null);
    const [action, setAction] = useState("");
    const [actionDate, setActionDate] = useState<string | null>(null);
    const [clientId, setClientId] = useState(draftId);
    const [busy, setBusy] = useState(false);
    const [discarding, setDiscarding] = useState(false);

    useEffect(() => {
        productivityApi.startReview(projectId).then(
            (w) => {
                setWs(w);
                setNote(w.review.note);
                setHealth(w.review.health);
            },
            (e) => setFailed(issues(e)),
        );
    }, [projectId]);

    // Saves the note and health (on leaving the field, and before completing). A conflict reloads someone else's version.
    const save = async (): Promise<number | null> => {
        if (!ws) return null;
        if (note === ws.review.note && health === ws.review.health) return ws.review.version;
        try {
            const { review } = await productivityApi.updateReview(ws.review.id, ws.review.version, { note, health });
            setWs({ ...ws, review });
            return review.version;
        } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
                const fresh = await productivityApi.review(ws.review.id);
                setWs(fresh);
                toast.show({
                    title: "Someone else edited this review",
                    description: "Their note is shown. Your text is still in the box; save again to replace it.",
                    color: "warning",
                });
                return null;
            }
            toast.error("Couldn't save the note", issues(e));
            return null;
        }
    };

    const addAction = async () => {
        if (!ws || !action.trim()) return;
        try {
            const { review } = await productivityApi.addReviewAction(ws.review.id, { title: action.trim(), dueDate: actionDate, clientId });
            setWs({ ...ws, review });
            setAction("");
            setActionDate(null);
            setClientId(draftId());
            emit({ type: "refresh" });
        } catch (e) {
            toast.error("Couldn't add it", issues(e));
        }
    };

    const complete = async () => {
        if (!ws) return;
        setBusy(true);
        const version = await save();
        if (version === null && (note !== ws.review.note || health !== ws.review.health)) return setBusy(false);
        try {
            await productivityApi.completeReview(ws.review.id, version ?? ws.review.version, { note, health });
            toast.success("Review completed", projectName);
            onDone();
            onClose();
        } catch (e) {
            toast.error("Couldn't complete the review", issues(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => {
                if (!open) {
                    void save();
                    onClose();
                }
            }}
            title={`Review: ${projectName}`}
            icon={ClipboardCheck}
            size="lg"
            description={
                ws?.review.periodStart
                    ? `Since the last review, ${formatRelative(ws.review.periodStart)}. Your draft is kept if you close this.`
                    : "The first review of this project. Your draft is kept if you close this."
            }
            footer={
                ws && (
                    <>
                        <Button color="tertiary" size="md" onClick={() => setDiscarding(true)}>
                            Discard
                        </Button>
                        <Button color="secondary" size="md" onClick={() => void save().then(() => onClose())}>
                            Save draft
                        </Button>
                        <Button size="md" onClick={() => void complete()} isLoading={busy} showTextWhileLoading>
                            Complete review
                        </Button>
                    </>
                )
            }
        >
            {failed ? (
                <Notice color="warning" title="Couldn't start the review">
                    {failed}
                </Notice>
            ) : !ws ? (
                <div role="status" aria-label="Loading the review" className="flex flex-col gap-3">
                    <Skeleton className="h-6 w-1/2" />
                    <Skeleton className="h-24 w-full" />
                </div>
            ) : (
                <div className="flex flex-col gap-6">
                    <section className="flex flex-col gap-2" aria-labelledby="review-health">
                        <div className="flex flex-wrap items-center gap-3">
                            <h3 id="review-health" className="text-sm font-semibold text-primary">
                                Health
                            </h3>
                            <HealthBadge health={ws.health} />
                            <span className="text-xs text-tertiary">
                                {ws.metrics.open} open · {ws.metrics.completed} done · {ws.metrics.overdue} overdue
                            </span>
                        </div>
                        <HealthReasons reasons={ws.health.reasons} />
                    </section>
                    <Step title={`Done since last time (${ws.completedSinceCount})`}>
                        {ws.completedSince.length ? (
                            <TaskLines tasks={ws.completedSince} showProject={false} />
                        ) : (
                            <Quiet>Nothing completed in this period.</Quiet>
                        )}
                    </Step>
                    <Step title={`Overdue (${ws.overdue.length})`}>
                        {ws.overdue.length ? <TaskLines tasks={ws.overdue} showProject={false} /> : <Quiet>Nothing overdue.</Quiet>}
                    </Step>
                    <Step title="Milestones and deadlines in the next 30 days">
                        {ws.upcoming.length ? <TaskLines tasks={ws.upcoming} showProject={false} /> : <Quiet>None coming up.</Quiet>}
                    </Step>
                    <Step title="Unresolved: no date, or nobody responsible">
                        {ws.unresolved.length ? (
                            <TaskLines tasks={ws.unresolved} showProject={false} />
                        ) : (
                            <Quiet>Every open task has a date and someone on it.</Quiet>
                        )}
                    </Step>
                    <TextArea
                        label="Review note"
                        rows={4}
                        value={note}
                        onChange={setNote}
                        onBlur={() => void save()}
                        maxLength={5000}
                        hint="What's going well, what's stuck, what you decided. Only members of this project see it."
                    />
                    <RadioGroup
                        aria-label="Health you'd record"
                        value={health ?? "calculated"}
                        onChange={(v) => setHealth(v === "calculated" ? null : (v as HealthStatus))}
                    >
                        <RadioButton value="calculated" label={`As calculated (${HEALTH_LABELS[ws.health.calculated].toLowerCase()})`} />
                        {HEALTH_STATUSES.map((s) => (
                            <RadioButton key={s} value={s} label={HEALTH_LABELS[s]} />
                        ))}
                    </RadioGroup>
                    <Step title="Next actions">
                        {ws.review.actions.length > 0 && <TaskLines tasks={ws.review.actions} showProject={false} />}
                        <form
                            className="flex flex-col gap-3 sm:flex-row sm:items-end"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void addAction();
                            }}
                        >
                            <Input
                                label="Add a next action"
                                value={action}
                                onChange={setAction}
                                placeholder="e.g. Call the builder for a quote"
                                className="flex-1"
                                maxLength={500}
                            />
                            <DateField label="Due (optional)" value={actionDate} onChange={setActionDate} />
                            <Button type="submit" size="md" iconLeading={Plus} isDisabled={!action.trim()}>
                                Add
                            </Button>
                        </form>
                        <Quiet>Each one becomes a task in this project straight away.</Quiet>
                    </Step>
                </div>
            )}
            <ConfirmDialog
                isOpen={discarding}
                onOpenChange={setDiscarding}
                title="Discard this review?"
                description="The note is thrown away. Next actions you've added stay: they're tasks in the project."
                confirmLabel="Discard"
                destructive
                onConfirm={async () => {
                    if (!ws) return;
                    try {
                        await productivityApi.discardReview(ws.review.id);
                        onDone();
                        onClose();
                    } catch (e) {
                        toast.error("Couldn't discard it", issues(e));
                    }
                }}
            />
        </PortalDialog>
    );
};

const Step = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="flex flex-col gap-2 border-t border-secondary pt-4">
        <h3 className="text-sm font-semibold text-primary">{title}</h3>
        {children}
    </section>
);
