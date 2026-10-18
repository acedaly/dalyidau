// Goals: what you (or the household) are working towards. Progress comes from linked projects and
// tasks, or is entered by hand against a target in your own units ("$", "km", "chapters"). A goal
// has milestones and a history of every update.
//
// Personal goals are yours alone. A shared goal is shared with the people you add to it, and only
// them; linking it to a shared project shares nothing, and everyone sees progress worked out from
// the projects and tasks they themselves can open. A shared goal can only link shared projects.
import { useState } from "react";
import { Archive, BookOpen01, CheckCircle, Edit05, Folder, LineChartUp01, Link01, Plus, Target04, Trash01, UsersPlus, XClose } from "@untitledui/icons";
import { FeedItem } from "@/components/application/activity-feed/activity-feed";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { RadioButton, RadioGroup } from "@/components/base/radio-buttons/radio-buttons";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { DateField } from "@/portal/components/date-field";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { formatNumber, formatRelative, initials } from "@/portal/lib/format";
import type { PageData } from "@/portal/lib/page-types";
import { usePortal } from "@/portal/portal-context";
import { shortDate } from "@/shared/tasks/dates";
import { GOAL_STATUSES, GOAL_STATUS_LABELS, type GoalDetail, type GoalProgressEvent, type GoalStatus, type TaskGoal } from "@/shared/tasks/productivity";
import { PROJECT_ROLES, type ProjectRole, roleAtLeast } from "@/shared/tasks/types";
import { projectHref, tasksApi } from "../api";
import { KnowledgeLinkDialog } from "../knowledge-link-dialog";
import { type GoalInput, goalHref, productivityApi } from "../productivity-api";
import { Card, GoalProgress, GoalStatusBadge, MoreLink, Quiet, TargetText, TaskLines } from "../productivity-ui";
import { ProjectDot, personLabel, titleOf } from "../shared";
import { useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";

const issues = (e: unknown) => (e instanceof ApiError && e.issues.length ? e.issues.map((i) => i.message).join(" ") : errorMessage(e));

// --- List ----------------------------------------------------------------------------------------

export const TasksGoalsPage = ({ data }: { data: PageData<"tasks-goals"> }) => (
    <TasksLayout shell={data}>
        <GoalsBody data={data} />
    </TasksLayout>
);

const GoalsBody = ({ data }: { data: PageData<"tasks-goals"> }) => {
    const { today } = useTasks();
    const [creating, setCreating] = useState(false);
    const [showArchived, setShowArchived] = useState(false);
    const active = data.goals.filter((g) => g.status !== "achieved" && g.status !== "abandoned");
    const finished = data.goals.filter((g) => g.status === "achieved" || g.status === "abandoned");
    return (
        <>
            <TasksHeader
                title="Goals"
                description="What you're working towards. Personal goals are only yours; shared goals are shared with the people you add."
                crumb={{ label: "Goals" }}
                actions={
                    <Button size="sm" iconLeading={Plus} onClick={() => setCreating(true)}>
                        New goal
                    </Button>
                }
            />
            {!data.goals.length && !data.archived.length ? (
                <Empty
                    icon={Target04}
                    title="No goals yet"
                    description="Set a goal and link the projects that get you there, or track a number by hand: savings, distance, books read."
                    actions={
                        <Button size="md" iconLeading={Plus} onClick={() => setCreating(true)}>
                            New goal
                        </Button>
                    }
                />
            ) : (
                <div className="flex flex-col gap-8">
                    <GoalGrid title="In progress" goals={active} today={today} empty="No active goals." />
                    {finished.length > 0 && <GoalGrid title="Achieved and abandoned" goals={finished} today={today} />}
                    {data.archived.length > 0 && (
                        <div className="flex flex-col gap-4">
                            <Button size="sm" color="link-gray" iconLeading={Archive} onClick={() => setShowArchived(!showArchived)} className="self-start">
                                {showArchived ? "Hide" : "Show"} {data.archived.length} archived
                            </Button>
                            {showArchived && <GoalGrid title="Archived" goals={data.archived} today={today} />}
                        </div>
                    )}
                </div>
            )}
            <GoalDialog isOpen={creating} onOpenChange={setCreating} />
        </>
    );
};

const GoalGrid = ({ title, goals, today, empty }: { title: string; goals: TaskGoal[]; today: string; empty?: string }) => (
    <section className="flex flex-col gap-4" aria-label={title}>
        <h2 className="text-md font-semibold text-primary">{title}</h2>
        {goals.length ? (
            <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {goals.map((g) => (
                    <li key={g.id} className="flex flex-col gap-3 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
                        <div className="flex items-start justify-between gap-3">
                            <a href={goalHref(g.id)} className="min-w-0 text-md font-semibold text-primary hover:underline">
                                {titleOf(g.title)}
                            </a>
                            <GoalStatusBadge status={g.status} />
                        </div>
                        <GoalProgress goal={g} />
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tertiary">
                            <Badge size="sm" type="color" color={g.kind === "shared" ? "blue" : "gray"}>
                                {g.kind === "shared" ? `Shared · ${g.memberCount}` : "Personal"}
                            </Badge>
                            {g.attention ? <span className="text-warning-primary">{g.attention}</span> : <TargetText date={g.targetDate} today={today} />}
                            {g.milestones.total > 0 && (
                                <span>
                                    {g.milestones.done} of {g.milestones.total} milestones
                                </span>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
        ) : (
            <Quiet>{empty}</Quiet>
        )}
    </section>
);

// --- Create and edit -----------------------------------------------------------------------------

const GoalDialog = ({
    isOpen,
    onOpenChange,
    goal,
    onSaved,
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    goal?: GoalDetail;
    onSaved?: (d: GoalDetail) => void;
}) => {
    const { projects } = useTasks();
    const toast = useToast();
    const g = goal?.goal;
    const [title, setTitle] = useState(g?.title ?? "");
    const [description, setDescription] = useState(g?.description ?? "");
    const [kind, setKind] = useState<"personal" | "shared">(g?.kind ?? "personal");
    const [targetDate, setTargetDate] = useState<string | null>(g?.targetDate ?? null);
    const [mode, setMode] = useState<"tasks" | "manual">(g?.progress.mode ?? "tasks");
    const [unit, setUnit] = useState(g?.progress.unit ?? "");
    const [start, setStart] = useState(String(g?.progress.start ?? 0));
    const [target, setTarget] = useState(g?.progress.target === null || g?.progress.target === undefined ? "" : String(g.progress.target));
    const [projectIds, setProjectIds] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const linkable = projects.filter((p) => !p.isInbox && p.status !== "archived" && (kind === "personal" || p.kind === "shared"));

    const save = async () => {
        if (!title.trim()) return setError("Give the goal a title");
        const startValue = Number(start || 0);
        const targetValue = target.trim() === "" ? null : Number(target);
        if (mode === "manual" && (targetValue === null || !Number.isFinite(targetValue) || !Number.isFinite(startValue)))
            return setError("Enter a starting value and a target as numbers");
        setBusy(true);
        setError(null);
        const body: GoalInput = {
            title,
            description,
            targetDate,
            progressMode: mode,
            ...(mode === "manual" ? { unit: unit.trim() || null, startValue, targetValue } : {}),
        };
        try {
            if (goal) {
                const saved = await productivityApi.updateGoal(goal.goal.id, goal.goal.version, body);
                onSaved?.(saved);
                onOpenChange(false);
                toast.success("Goal saved");
            } else {
                const created = await productivityApi.createGoal({
                    ...body,
                    title,
                    kind,
                    projectIds: projectIds.filter((id) => linkable.some((p) => p.id === id)),
                });
                window.location.assign(goalHref(created.goal.id));
            }
        } catch (e) {
            setError(issues(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title={goal ? "Edit goal" : "New goal"}
            icon={Target04}
            size="md"
            description={goal ? undefined : "Keep it short and concrete. You can link projects, tasks and notes afterwards too."}
            onSubmit={() => void save()}
            footer={
                <>
                    <Button color="secondary" size="md" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button type="submit" size="md" isLoading={busy} showTextWhileLoading>
                        {goal ? "Save" : "Create goal"}
                    </Button>
                </>
            }
        >
            {error && (
                <Notice color="error" title="Not saved">
                    {error}
                </Notice>
            )}
            <Input label="Goal" isRequired value={title} onChange={setTitle} autoFocus placeholder="e.g. Save for a holiday" />
            <TextArea label="Why it matters" rows={2} value={description} onChange={setDescription} hint="Optional" />
            {!goal && (
                <RadioGroup aria-label="Who can see it" value={kind} onChange={(v) => setKind(v as "personal" | "shared")}>
                    <RadioButton value="personal" label="Personal" hint="Only you." />
                    <RadioButton value="shared" label="Shared" hint="With the people you add next. It can only draw on shared projects." />
                </RadioGroup>
            )}
            <DateField label="Target date" value={targetDate} onChange={setTargetDate} hint="Optional" />
            <RadioGroup aria-label="How progress is measured" value={mode} onChange={(v) => setMode(v as "tasks" | "manual")}>
                <RadioButton value="tasks" label="From tasks" hint="The share of linked projects' and tasks' work that's done." />
                <RadioButton value="manual" label="A number I update" hint="Money saved, kilometres run, chapters written…" />
            </RadioGroup>
            {mode === "manual" && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <Input label="Unit" value={unit} onChange={setUnit} placeholder="$, km, books" hint="Optional" />
                    <Input label="Starting at" type="number" inputMode="decimal" value={start} onChange={setStart} />
                    <Input label="Target" isRequired type="number" inputMode="decimal" value={target} onChange={setTarget} />
                </div>
            )}
            {!goal && linkable.length > 0 && (
                <fieldset className="flex flex-col gap-2">
                    <legend className="mb-2 text-sm font-medium text-secondary">Link projects (optional)</legend>
                    {linkable.slice(0, 20).map((p) => (
                        <Checkbox
                            key={p.id}
                            label={p.name}
                            isSelected={projectIds.includes(p.id)}
                            onChange={(on) => setProjectIds((ids) => (on ? [...ids, p.id] : ids.filter((id) => id !== p.id)))}
                        />
                    ))}
                </fieldset>
            )}
        </PortalDialog>
    );
};

// --- One goal ------------------------------------------------------------------------------------

export const TasksGoalPage = ({ data }: { data: PageData<"tasks-goal"> }) => (
    <TasksLayout shell={data}>
        <GoalBody data={data} />
    </TasksLayout>
);

const GoalBody = ({ data }: { data: PageData<"tasks-goal"> }) => {
    const { today, projects, shell } = useTasks();
    const toast = useToast();
    const [d, setD] = useState<GoalDetail>(data.detail);
    const [editing, setEditing] = useState(false);
    const [sharing, setSharing] = useState(false);
    const [linkingKnowledge, setLinkingKnowledge] = useState(false);
    const [linkingTask, setLinkingTask] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const g = d.goal;
    const canEdit = roleAtLeast(g.role, "editor") && !g.archivedAt;
    const isOwner = g.role === "owner";
    const people = d.members;

    const run = async (work: () => Promise<GoalDetail | { ok: true } | void>, success?: string) => {
        try {
            const next = await work();
            if (next && "goal" in next) setD(next);
            else setD(await productivityApi.goal(g.id));
            if (success) toast.success(success);
        } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
                toast.show({ title: "Someone else changed this goal", description: "Showing the latest version. Try again.", color: "warning" });
                setD(await productivityApi.goal(g.id));
            } else toast.error("That didn't work", issues(e));
        }
    };

    const linkableProjects = projects.filter(
        (p) => !p.isInbox && p.status !== "archived" && (g.kind === "personal" || p.kind === "shared") && !d.projects.some((x) => x.id === p.id),
    );

    return (
        <>
            <TasksHeader
                title={titleOf(g.title)}
                crumb={{ label: "Goals", href: "/portal/tasks/goals" }}
                description={
                    <div className="flex flex-col gap-3">
                        {g.description && <p className="max-w-prose text-md whitespace-pre-line text-tertiary">{g.description}</p>}
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                            <GoalStatusBadge status={g.status} />
                            <Badge size="sm" type="color" color={g.kind === "shared" ? "blue" : "gray"}>
                                {g.kind === "shared" ? `Shared · ${g.memberCount} people` : "Personal"}
                            </Badge>
                            <TargetText date={g.targetDate} today={today} />
                            {g.archivedAt && (
                                <Badge size="sm" type="color" color="gray">
                                    Archived
                                </Badge>
                            )}
                        </div>
                    </div>
                }
                actions={
                    <>
                        {canEdit && (
                            <Select
                                aria-label="Goal status"
                                size="sm"
                                className="w-40"
                                value={g.status}
                                onChange={(key) => {
                                    if (!key || key === g.status) return;
                                    void run(
                                        () => productivityApi.updateGoal(g.id, g.version, { status: key as GoalStatus }),
                                        key === "achieved" ? "Goal achieved. Well done." : "Status changed",
                                    );
                                }}
                                items={GOAL_STATUSES.map((s) => ({ id: s, label: GOAL_STATUS_LABELS[s] }))}
                            >
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                        )}
                        {canEdit && (
                            <Button size="sm" color="secondary" iconLeading={Edit05} onClick={() => setEditing(true)}>
                                Edit
                            </Button>
                        )}
                        {(isOwner || g.kind === "shared") && (
                            <Button size="sm" color="secondary" iconLeading={UsersPlus} onClick={() => setSharing(true)}>
                                {g.kind === "shared" ? "Members" : "Share"}
                            </Button>
                        )}
                    </>
                }
            />
            {g.progress.percent === 100 && g.status !== "achieved" && canEdit && (
                <Notice
                    color="success"
                    title="Everything linked is done"
                    actions={
                        <Button size="sm" onClick={() => void run(() => productivityApi.updateGoal(g.id, g.version, { status: "achieved" }), "Goal achieved")}>
                            Mark achieved
                        </Button>
                    }
                >
                    Mark the goal achieved when you're happy it's met.
                </Notice>
            )}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <Card title="Progress" icon={LineChartUp01} className="lg:col-span-2" id="goal-progress">
                    <GoalProgress goal={g} />
                    {g.progress.mode === "manual" ? (
                        canEdit && (
                            <ProgressForm
                                goal={g}
                                onSave={(value, note) => run(() => productivityApi.recordProgress(g.id, g.version, value, note), "Progress recorded")}
                            />
                        )
                    ) : (
                        <Quiet>
                            Worked out from the linked projects and tasks you can open: {g.progress.done} of {g.progress.total} done. Repeating tasks count as
                            open until they're stopped.
                        </Quiet>
                    )}
                </Card>
                <Card title="What's next" icon={Target04} id="goal-next">
                    {d.next.length ? <TaskLines tasks={d.next} /> : <Quiet>No dated open tasks linked yet.</Quiet>}
                </Card>
                <Card title="Milestones" icon={CheckCircle} count={d.milestones.length} id="goal-milestones">
                    {d.milestones.length ? (
                        <ul className="flex flex-col gap-2">
                            {d.milestones.map((m) => (
                                <li key={m.id} className="flex items-center gap-2">
                                    <Checkbox
                                        isDisabled={!canEdit}
                                        isSelected={!!m.doneAt}
                                        label={m.title}
                                        hint={m.targetDate ? `By ${shortDate(m.targetDate)}` : undefined}
                                        onChange={(done) => void run(() => productivityApi.updateMilestone(m.id, { done }))}
                                    />
                                    {canEdit && (
                                        <ButtonUtility
                                            size="xs"
                                            color="tertiary"
                                            icon={Trash01}
                                            tooltip={`Delete “${m.title}”`}
                                            className="ml-auto"
                                            onClick={() => void run(() => productivityApi.deleteMilestone(m.id))}
                                        />
                                    )}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <Quiet>Break the goal into a few checkpoints.</Quiet>
                    )}
                    {canEdit && <MilestoneForm onAdd={(title, date) => run(() => productivityApi.addMilestone(g.id, title, date))} />}
                </Card>
                <Card
                    title="Linked projects"
                    icon={Folder}
                    count={d.projects.length}
                    id="goal-projects"
                    action={
                        canEdit && linkableProjects.length > 0 ? (
                            <Select
                                aria-label="Link a project"
                                size="sm"
                                className="w-44"
                                placeholder="Link a project"
                                selectedKey={null}
                                onChange={(key) => key && void run(() => productivityApi.linkGoal(g.id, { projectId: String(key) }), "Project linked")}
                                items={linkableProjects.map((p) => ({ id: p.id, label: p.name }))}
                            >
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                        ) : undefined
                    }
                >
                    {d.projects.length ? (
                        <ul className="flex flex-col gap-2">
                            {d.projects.map((p) => (
                                <li key={p.linkId} className="flex items-center gap-2 text-sm">
                                    <ProjectDot color={p.color} />
                                    <a href={projectHref(p.id, "overview")} className="min-w-0 flex-1 truncate font-medium text-primary hover:underline">
                                        {p.name}
                                    </a>
                                    <span className="shrink-0 text-xs text-tertiary">
                                        {p.completed} of {p.open + p.completed} done
                                    </span>
                                    {canEdit && (
                                        <ButtonUtility
                                            size="xs"
                                            color="tertiary"
                                            icon={XClose}
                                            tooltip={`Unlink ${p.name}`}
                                            onClick={() => void run(() => productivityApi.unlinkGoal(g.id, p.linkId))}
                                        />
                                    )}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <Quiet>
                            {g.kind === "shared" ? "Link shared projects that move this goal forward." : "Link the projects that move this goal forward."}
                        </Quiet>
                    )}
                </Card>
                <Card
                    title="Linked tasks"
                    icon={Link01}
                    count={d.tasks.length}
                    id="goal-tasks"
                    action={
                        canEdit ? (
                            <Button size="sm" color="link-color" iconLeading={Plus} onClick={() => setLinkingTask(true)}>
                                Link
                            </Button>
                        ) : undefined
                    }
                >
                    {d.tasks.length ? (
                        <TaskLines
                            tasks={d.tasks}
                            meta={(t) =>
                                canEdit && (
                                    <ButtonUtility
                                        size="xs"
                                        color="tertiary"
                                        icon={XClose}
                                        tooltip="Unlink"
                                        onClick={() => void run(() => productivityApi.unlinkGoal(g.id, (t as GoalDetail["tasks"][number]).linkId))}
                                    />
                                )
                            }
                        />
                    ) : (
                        <Quiet>Individual tasks that count towards this goal.</Quiet>
                    )}
                </Card>
                {shell.canUseKnowledge && (
                    <Card
                        title="Knowledge"
                        icon={BookOpen01}
                        count={d.knowledge.length}
                        id="goal-knowledge"
                        action={
                            canEdit ? (
                                <Button size="sm" color="link-color" iconLeading={Link01} onClick={() => setLinkingKnowledge(true)}>
                                    Link
                                </Button>
                            ) : undefined
                        }
                    >
                        {d.knowledge.length ? (
                            <ul className="flex flex-col gap-2">
                                {d.knowledge.map((k) =>
                                    k.available ? (
                                        <li key={k.linkId} className="flex items-center gap-2 text-sm">
                                            <BookOpen01 aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                                            <a
                                                href={`/portal/knowledge/o/${k.objectId}`}
                                                className="min-w-0 flex-1 truncate font-medium text-primary hover:underline"
                                            >
                                                {k.title}
                                            </a>
                                            {canEdit && (
                                                <ButtonUtility
                                                    size="xs"
                                                    color="tertiary"
                                                    icon={XClose}
                                                    tooltip="Unlink"
                                                    onClick={() => void run(() => productivityApi.unlinkGoal(g.id, k.linkId))}
                                                />
                                            )}
                                        </li>
                                    ) : null,
                                )}
                            </ul>
                        ) : (
                            <Quiet>Plans, notes and decisions behind the goal. Others see only what they can read in Knowledge.</Quiet>
                        )}
                    </Card>
                )}
                <Card title="History" icon={LineChartUp01} className="lg:col-span-3" id="goal-history">
                    <ul className="flex flex-col gap-4">
                        {d.history.slice(0, 30).map((e, i, all) => (
                            <li key={e.id}>
                                <FeedItem
                                    id={String(e.id)}
                                    size="sm"
                                    connector={i < all.length - 1}
                                    user={{ name: e.byName ?? personLabel(e.by, people), initials: initials(e.byName ?? e.by.split("@")[0]) }}
                                    date={formatRelative(e.at)}
                                    dateTime={e.at}
                                    action={{ content: historyText(e, g) }}
                                />
                            </li>
                        ))}
                    </ul>
                </Card>
            </div>
            {isOwner && (
                <div className="flex flex-wrap gap-3 border-t border-secondary pt-6">
                    <Button
                        size="sm"
                        color="secondary"
                        iconLeading={Archive}
                        onClick={() => void run(() => productivityApi.archiveGoal(g.id, !g.archivedAt), g.archivedAt ? "Restored" : "Archived")}
                    >
                        {g.archivedAt ? "Restore" : "Archive"}
                    </Button>
                    <Button size="sm" color="secondary-destructive" iconLeading={Trash01} onClick={() => setDeleting(true)}>
                        Delete goal
                    </Button>
                </div>
            )}
            {editing && <GoalDialog isOpen onOpenChange={setEditing} goal={d} onSaved={setD} />}
            {sharing && <GoalMembersDialog detail={d} onClose={() => setSharing(false)} onChange={setD} />}
            {linkingKnowledge && (
                <KnowledgeLinkDialog
                    onClose={() => setLinkingKnowledge(false)}
                    onPick={(objectId) => {
                        setLinkingKnowledge(false);
                        void run(() => productivityApi.linkGoal(g.id, { objectId }), "Linked");
                    }}
                />
            )}
            {linkingTask && (
                <TaskLinkDialog
                    sharedOnly={g.kind === "shared"}
                    onClose={() => setLinkingTask(false)}
                    onPick={(taskId) => {
                        setLinkingTask(false);
                        void run(() => productivityApi.linkGoal(g.id, { taskId }), "Task linked");
                    }}
                />
            )}
            <ConfirmDialog
                isOpen={deleting}
                onOpenChange={setDeleting}
                title="Delete this goal?"
                description="Its milestones and history are deleted too. Linked projects and tasks aren't touched. This can't be undone; archive it to keep a record."
                confirmLabel="Delete goal"
                destructive
                onConfirm={async () => {
                    try {
                        await productivityApi.deleteGoal(g.id);
                        window.location.assign("/portal/tasks/goals");
                    } catch (e) {
                        toast.error("Couldn't delete it", issues(e));
                    }
                }}
            />
        </>
    );
};

const historyText = (e: GoalProgressEvent, g: TaskGoal) => {
    const note = e.note ? `: “${e.note}”` : "";
    switch (e.kind) {
        case "created":
            return "created the goal";
        case "value":
            return `updated progress to ${formatNumber(e.value ?? 0)}${g.progress.unit ? ` ${g.progress.unit}` : ""}${note}`;
        case "status":
            return `marked it ${GOAL_STATUS_LABELS[e.status ?? "in_progress"].toLowerCase()}${note}`;
        case "milestone":
            return `${(e.value ?? 1) > 0 ? "reached" : "reopened"} a milestone${note}`;
        case "member":
            return (e.value ?? 1) > 0 ? "added a member" : "removed a member";
        case "link":
            return (e.value ?? 1) > 0 ? "linked something" : "removed a link";
        default:
            return e.note ? e.note.toLowerCase() : "edited the goal";
    }
};

const ProgressForm = ({ goal, onSave }: { goal: TaskGoal; onSave: (value: number, note: string) => Promise<void> }) => {
    const [value, setValue] = useState(String(goal.progress.current));
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    return (
        <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={async (event) => {
                event.preventDefault();
                const n = Number(value);
                if (!Number.isFinite(n)) return;
                setBusy(true);
                await onSave(n, note.trim());
                setNote("");
                setBusy(false);
            }}
        >
            <Input
                label={`Now at${goal.progress.unit ? ` (${goal.progress.unit})` : ""}`}
                type="number"
                inputMode="decimal"
                value={value}
                onChange={setValue}
                className="sm:w-40"
            />
            <Input label="Note" value={note} onChange={setNote} placeholder="Optional" maxLength={500} className="flex-1" />
            <Button type="submit" size="md" isLoading={busy} showTextWhileLoading>
                Update
            </Button>
        </form>
    );
};

const MilestoneForm = ({ onAdd }: { onAdd: (title: string, date: string | null) => Promise<void> }) => {
    const [title, setTitle] = useState("");
    const [date, setDate] = useState<string | null>(null);
    return (
        <form
            className="flex flex-col gap-3"
            onSubmit={async (event) => {
                event.preventDefault();
                if (!title.trim()) return;
                await onAdd(title.trim(), date);
                setTitle("");
                setDate(null);
            }}
        >
            <Input aria-label="New milestone" placeholder="Add a milestone" value={title} onChange={setTitle} size="sm" maxLength={200} />
            {title.trim() && (
                <div className="flex flex-wrap items-end gap-2">
                    <DateField label="By (optional)" value={date} onChange={setDate} />
                    <Button type="submit" size="sm" iconLeading={Plus}>
                        Add
                    </Button>
                </div>
            )}
        </form>
    );
};

/** Find one of your tasks to link, using Tasks search (your projects only). */
const TaskLinkDialog = ({ onClose, onPick, sharedOnly }: { onClose: () => void; onPick: (taskId: string) => void; sharedOnly: boolean }) => {
    const { project } = useTasks();
    const [query, setQuery] = useState("");
    const [hits, setHits] = useState<{ id: string; title: string; projectId: string }[]>([]);
    const search = async (q: string) => {
        setQuery(q);
        if (!q.trim()) return setHits([]);
        try {
            const r = await tasksApi.search(q);
            setHits(r.tasks.filter((t) => !sharedOnly || project(t.projectId)?.kind === "shared"));
        } catch {
            setHits([]);
        }
    };
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title="Link a task"
            icon={Link01}
            description={sharedOnly ? "A shared goal can only link tasks in shared projects." : "Any task you can open."}
        >
            <Input aria-label="Search tasks" placeholder="Search your tasks" value={query} onChange={(v) => void search(v)} autoFocus />
            <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto pb-4">
                {hits.map((t) => (
                    <li key={t.id}>
                        <button
                            type="button"
                            onClick={() => onPick(t.id)}
                            className="flex w-full cursor-pointer flex-col items-start rounded-md px-3 py-2 text-left outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
                        >
                            <span className="text-sm font-medium text-primary">{titleOf(t.title)}</span>
                            <span className="text-xs text-tertiary">{project(t.projectId)?.name}</span>
                        </button>
                    </li>
                ))}
                {query.trim() && !hits.length && <li className="px-3 py-2 text-sm text-tertiary">Nothing found.</li>}
            </ul>
        </PortalDialog>
    );
};

const GoalMembersDialog = ({ detail, onClose, onChange }: { detail: GoalDetail; onClose: () => void; onChange: (d: GoalDetail) => void }) => {
    const toast = useToast();
    const { user } = usePortal();
    const g = detail.goal;
    const isOwner = g.role === "owner";
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<ProjectRole>("editor");
    const [error, setError] = useState<string | null>(null);
    const reload = async () => onChange(await productivityApi.goal(g.id));
    const ROLE_TEXT: Record<ProjectRole, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title={g.kind === "shared" ? "Goal members" : "Share this goal"}
            icon={UsersPlus}
            description="Only the people listed here can see the goal. Being in a linked project doesn't give anyone access."
        >
            {g.kind === "personal" ? (
                isOwner && (
                    <div className="flex flex-col gap-3 pb-6">
                        <Quiet>Sharing lets you add people. A shared goal can only link shared projects and tasks.</Quiet>
                        {error && (
                            <Notice color="error" title="Not shared">
                                {error}
                            </Notice>
                        )}
                        <Button
                            size="md"
                            className="self-start"
                            onClick={async () => {
                                try {
                                    onChange(await productivityApi.setGoalKind(g.id, "shared"));
                                } catch (e) {
                                    setError(issues(e));
                                }
                            }}
                        >
                            Share the goal
                        </Button>
                    </div>
                )
            ) : (
                <div className="flex flex-col gap-4 pb-6">
                    <ul className="flex flex-col gap-2">
                        {detail.members.map((m) => (
                            <li key={m.email} className="flex items-center justify-between gap-3 text-sm">
                                <span className="min-w-0 truncate text-secondary">{m.name ?? m.email}</span>
                                <span className="flex shrink-0 items-center gap-2">
                                    {isOwner && m.role !== "owner" ? (
                                        <Select
                                            aria-label={`Role for ${m.email}`}
                                            size="sm"
                                            className="w-28"
                                            value={m.role}
                                            onChange={async (key) => {
                                                if (!key) return;
                                                try {
                                                    await productivityApi.updateGoalMember(g.id, m.email, key as ProjectRole);
                                                    await reload();
                                                } catch (e) {
                                                    toast.error("Couldn't change it", issues(e));
                                                }
                                            }}
                                            items={PROJECT_ROLES.map((r) => ({ id: r, label: ROLE_TEXT[r] }))}
                                        >
                                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                        </Select>
                                    ) : (
                                        <span className="text-tertiary">{ROLE_TEXT[m.role]}</span>
                                    )}
                                    {isOwner && m.role !== "owner" && (
                                        <ButtonUtility
                                            size="xs"
                                            color="tertiary"
                                            icon={XClose}
                                            tooltip={`Remove ${m.email}`}
                                            onClick={async () => {
                                                try {
                                                    await productivityApi.removeGoalMember(g.id, m.email);
                                                    await reload();
                                                } catch (e) {
                                                    toast.error("Couldn't remove them", issues(e));
                                                }
                                            }}
                                        />
                                    )}
                                </span>
                            </li>
                        ))}
                    </ul>
                    {isOwner && (
                        <form
                            className="flex flex-col gap-3 sm:flex-row sm:items-end"
                            onSubmit={async (event) => {
                                event.preventDefault();
                                setError(null);
                                try {
                                    await productivityApi.addGoalMember(g.id, email.trim(), role);
                                    setEmail("");
                                    await reload();
                                } catch (e) {
                                    setError(issues(e));
                                }
                            }}
                        >
                            <Input
                                label="Add someone"
                                type="email"
                                value={email}
                                onChange={setEmail}
                                placeholder="their portal email"
                                className="flex-1"
                                isInvalid={!!error}
                                hint={error ?? undefined}
                            />
                            <Select
                                aria-label="Role"
                                size="md"
                                className="sm:w-32"
                                value={role}
                                onChange={(key) => key && setRole(key as ProjectRole)}
                                items={PROJECT_ROLES.filter((r) => r !== "owner").map((r) => ({ id: r, label: ROLE_TEXT[r] }))}
                            >
                                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                            </Select>
                            <Button type="submit" size="md">
                                Add
                            </Button>
                        </form>
                    )}
                    {!isOwner && (
                        <Button
                            size="sm"
                            color="secondary-destructive"
                            className="self-start"
                            onClick={async () => {
                                try {
                                    await productivityApi.removeGoalMember(g.id, user.email);
                                    window.location.assign("/portal/tasks/goals");
                                } catch (e) {
                                    toast.error("Couldn't leave", issues(e));
                                }
                            }}
                        >
                            Leave this goal
                        </Button>
                    )}
                    <MoreLink href="/portal/tasks/goals">All goals</MoreLink>
                </div>
            )}
        </PortalDialog>
    );
};
