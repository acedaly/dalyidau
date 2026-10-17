// The task panel: everything about one task in a slideout, laid out like Untitled UI PRO's
// "create event" slideout. Fields save as they change; text saves when you leave the field (or
// press Enter in the title). A save that loses a race with someone else keeps your text and offers
// to save it on top or discard it. Subtasks, repeats, reminders, Knowledge references, comments
// and history are all here, in that order.
import { useCallback, useEffect, useState } from "react";
import { BookOpen01, Copy06, Link01, Plus, Repeat04, SearchLg, Target04, Trash01, XClose } from "@untitledui/icons";
import { FeedItem } from "@/components/application/activity-feed/activity-feed";
import { Dialog, Modal, ModalOverlay, SlideoutMenu } from "@/components/application/slideout-menus/slideout-menu";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { PortalDialog } from "@/portal/components/dialog";
import { Skeleton } from "@/portal/components/empty";
import { Notice } from "@/portal/components/notice";
import { useToast } from "@/portal/components/toast";
import { ApiError, api, errorMessage } from "@/portal/lib/api";
import { formatDateTime, formatRelative, initials } from "@/portal/lib/format";
import type { KnowledgeSearchHit } from "@/shared/knowledge/types";
import { relativeDate, shortDate } from "@/shared/tasks/dates";
import { describeRule } from "@/shared/tasks/recurrence";
import { LIMITS, type Priority, type TaskDetail } from "@/shared/tasks/types";
import { activitySentence } from "./activity-text";
import { type TaskFields, tasksApi } from "./api";
import { AssigneePicker, DateMenu, LabelPicker, PriorityPicker, ProjectPicker, SectionPicker } from "./pickers";
import { InlineAdd } from "./quick-add";
import { RecurrenceEditor } from "./recurrence-editor";
import { ProjectDot, personLabel, titleOf } from "./shared";
import { TaskRow } from "./task-row";
import { useTaskChanges, useTasks } from "./tasks-context";
import { useTaskActions } from "./use-task-actions";

const Section = ({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) => (
    <section className="flex w-full flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-primary">{title}</h3>
            {action}
        </div>
        {children}
    </section>
);

/** Dotted divider from the Untitled UI slideout layout. */
const Divider = () => (
    <svg height="2" className="w-full shrink-0" aria-hidden="true">
        <line
            x1="0"
            y1="1"
            x2="100%"
            y2="1"
            className="stroke-border-primary"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="0,6"
        />
    </svg>
);

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
        <span className="w-24 shrink-0 text-sm font-medium text-tertiary">{label}</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
);

export const TaskPanel = () => {
    const { panelTaskId, closeTask } = useTasks();
    return (
        // Built from SlideoutMenu's parts (like RecordPanel): SlideoutMenu's className would also shrink the overlay.
        <ModalOverlay isOpen={!!panelTaskId} onOpenChange={(open) => !open && closeTask()} isDismissable className="z-50">
            <Modal className="max-w-full md:max-w-160">
                <Dialog aria-label="Task details">{panelTaskId ? <PanelBody key={panelTaskId} taskId={panelTaskId} onClose={closeTask} /> : null}</Dialog>
            </Modal>
        </ModalOverlay>
    );
};

const PanelBody = ({ taskId, onClose }: { taskId: string; onClose: () => void }) => {
    const { today, emit, canEdit, openTask, project: projectById, assignable, shell } = useTasks();
    const toast = useToast();
    const actions = useTaskActions();
    const [detail, setDetail] = useState<TaskDetail | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [conflict, setConflict] = useState<TaskFields | null>(null);
    const [saving, setSaving] = useState(false);
    const [comment, setComment] = useState("");
    const [addingSubtask, setAddingSubtask] = useState(false);
    const [knowledgeOpen, setKnowledgeOpen] = useState(false);

    const load = useCallback(async () => {
        try {
            const next = await tasksApi.get(taskId);
            setDetail(next);
            setTitle(next.task.title);
            setDescription(next.task.description);
        } catch (error) {
            setFailed(error instanceof ApiError && error.status === 404 ? "This task doesn't exist or isn't shared with you." : errorMessage(error));
        }
    }, [taskId]);
    useEffect(() => void load(), [load]);

    // Subtasks and other changes made elsewhere on the page.
    useTaskChanges((change) => {
        if (!detail) return;
        if (change.type === "saved" && change.task.id === taskId) setDetail((d) => d && { ...d, task: { ...d.task, ...change.task } });
        else if (
            (change.type === "saved" || change.type === "created" || change.type === "removed") &&
            (("task" in change && change.task.parentId === taskId) || detail.subtasks.some((s) => "id" in change && s.id === change.id))
        )
            void load();
        else if (change.type === "removed" && change.id === taskId) onClose();
    });

    if (failed) {
        return (
            <>
                <SlideoutMenu.Header onClose={onClose}>
                    <h2 className="text-lg font-semibold text-primary">Task</h2>
                </SlideoutMenu.Header>
                <SlideoutMenu.Content role="region" aria-label="Task details">
                    <Notice title="Couldn't open the task" color="warning">
                        {failed}
                    </Notice>
                </SlideoutMenu.Content>
            </>
        );
    }
    if (!detail) {
        return (
            <SlideoutMenu.Content role="status" aria-label="Loading the task">
                <div className="flex flex-col gap-4 pt-6">
                    <Skeleton className="h-6 w-2/3" />
                    <Skeleton className="h-20 w-full" />
                    <Skeleton className="h-40 w-full" />
                </div>
            </SlideoutMenu.Content>
        );
    }

    const { task, project } = detail;
    const editable = canEdit(task.projectId);
    const people = assignable(task.projectId);
    const done = task.status === "completed";

    const save = async (fields: TaskFields, version = task.version) => {
        setSaving(true);
        try {
            const { task: next } = await tasksApi.update(task.id, version, fields);
            setDetail((d) => d && { ...d, task: { ...d.task, ...next, description: fields.description ?? d.task.description } });
            emit({ type: "saved", task: next });
            setConflict(null);
            return next;
        } catch (error) {
            if (error instanceof ApiError && error.status === 409 && error.code === "conflict") {
                // Keep what they wrote; show the latest and let them choose.
                setConflict(fields);
                const fresh = await tasksApi.get(task.id).catch(() => null);
                if (fresh) setDetail(fresh);
            } else toast.error("Couldn't save that", errorMessage(error));
            return null;
        } finally {
            setSaving(false);
        }
    };

    const saveTitle = () => {
        const next = title.replace(/\s+/g, " ").trim();
        if (!next) return setTitle(task.title);
        if (next !== task.title) void save({ title: next });
    };
    const saveDescription = () => {
        if (description !== task.description) void save({ description });
    };

    const projectOf = projectById(task.projectId);

    return (
        <>
            <SlideoutMenu.Header onClose={onClose} className="flex w-full flex-col gap-3 pr-12">
                <div className="flex flex-wrap items-center gap-2 text-sm text-tertiary">
                    <a
                        href={`/portal/tasks/p/${project.id}`}
                        className="inline-flex items-center gap-1.5 rounded-sm font-medium text-secondary outline-focus-ring hover:underline focus-visible:outline-2"
                    >
                        <ProjectDot color={project.color} />
                        {project.name}
                    </a>
                    {detail.parent && (
                        <>
                            <span aria-hidden="true">/</span>
                            <button
                                type="button"
                                onClick={() => openTask(detail.parent!.id)}
                                className="cursor-pointer truncate rounded-sm outline-focus-ring hover:underline focus-visible:outline-2"
                            >
                                {titleOf(detail.parent.title)}
                            </button>
                        </>
                    )}
                    {project.kind === "shared" && (
                        <Badge size="sm" type="color" color="blue">
                            Shared
                        </Badge>
                    )}
                    {!editable && (
                        <Badge size="sm" type="color" color="gray">
                            View only
                        </Badge>
                    )}
                    <span className="ml-auto text-xs" aria-live="polite">
                        {saving ? "Saving…" : ""}
                    </span>
                </div>
                <TextArea
                    aria-label="Task name"
                    rows={1}
                    value={title}
                    maxLength={LIMITS.title}
                    isReadOnly={!editable}
                    onChange={setTitle}
                    onBlur={saveTitle}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            (event.target as HTMLTextAreaElement).blur();
                        } else event.continuePropagation(); // so Escape still closes the panel
                    }}
                    textAreaClassName="resize-none text-lg font-semibold ring-0 shadow-none px-0 focus:ring-0"
                />
            </SlideoutMenu.Header>

            <SlideoutMenu.Content role="region" aria-label="Task details" className="pb-6">
                {conflict && (
                    <Notice
                        title="Someone else changed this task"
                        color="warning"
                        actions={
                            <>
                                <Button size="sm" onClick={() => void save(conflict, detail.task.version)}>
                                    Keep my changes
                                </Button>
                                <Button
                                    size="sm"
                                    color="secondary"
                                    onClick={() => {
                                        setConflict(null);
                                        setTitle(detail.task.title);
                                        setDescription(detail.task.description);
                                    }}
                                >
                                    Discard mine
                                </Button>
                            </>
                        }
                    >
                        Your change wasn't saved, so nothing was overwritten. This shows their latest version.
                    </Notice>
                )}

                <TextArea
                    label="Description"
                    rows={4}
                    placeholder={editable ? "Notes, links, anything that helps" : "No description"}
                    value={description}
                    isReadOnly={!editable}
                    onChange={setDescription}
                    onBlur={saveDescription}
                    hint={
                        description.length > LIMITS.description * 0.9
                            ? `${description.length.toLocaleString()} of ${LIMITS.description.toLocaleString()} characters`
                            : undefined
                    }
                />

                <div className="flex w-full flex-col gap-3">
                    <Field label="Project">
                        <ProjectPicker
                            value={task.projectId}
                            isDisabled={!editable || !!task.parentId}
                            onChange={(projectId) =>
                                projectId !== task.projectId && void actions.move(task, { projectId, sectionId: null, parentId: null }).then((t) => t && load())
                            }
                        />
                        {!task.parentId && (
                            <SectionPicker
                                projectId={task.projectId}
                                value={task.sectionId}
                                isDisabled={!editable}
                                onChange={(sectionId) => void actions.move(task, { sectionId }).then((t) => t && load())}
                            />
                        )}
                    </Field>
                    <Field label="Due">
                        <DateMenu
                            label="Due date"
                            value={task.dueDate}
                            time={task.dueTime}
                            isDisabled={!editable}
                            clearLabel={task.recurrence ? "No date (stops repeating)" : "No date"}
                            onChange={(dueDate) => void save(dueDate ? { dueDate } : { dueDate: null, dueTime: null, recurrence: null })}
                        />
                        {task.dueDate && (
                            <Input
                                aria-label="Due time"
                                type="time"
                                size="sm"
                                className="w-32"
                                isDisabled={!editable}
                                value={task.dueTime ?? ""}
                                onChange={(value) => void save({ dueTime: value || null })}
                            />
                        )}
                    </Field>
                    <Field label="Repeat">
                        <RecurrenceEditor
                            rule={task.recurrence}
                            anchor={task.dueDate ?? today}
                            isDisabled={!editable}
                            onChange={(recurrence) => void save({ recurrence })}
                        />
                        {task.recurrence && !done && editable && (
                            <Button size="sm" color="link-gray" onClick={() => void actions.skip(task).then(load)}>
                                Skip this one
                            </Button>
                        )}
                    </Field>
                    <Field label="Deadline">
                        <DateMenu
                            label="Deadline"
                            icon={Target04}
                            value={task.deadline}
                            placeholder="No deadline"
                            clearLabel="No deadline"
                            isDisabled={!editable}
                            onChange={(deadline) => void save({ deadline })}
                        />
                        <span className="text-xs text-tertiary">When it must be done by. The due date is when you plan to do it.</span>
                    </Field>
                    <Field label="Priority">
                        <PriorityPicker value={task.priority} isDisabled={!editable} onChange={(priority: Priority) => void save({ priority })} />
                    </Field>
                    {projectOf?.kind === "shared" && (
                        <Field label="Assignee">
                            <AssigneePicker
                                projectId={task.projectId}
                                value={task.assignee}
                                isDisabled={!editable}
                                onChange={(assignee) => void save({ assignee })}
                            />
                        </Field>
                    )}
                    <Field label="Labels">
                        <LabelPicker value={task.labels} isDisabled={!editable} onChange={(labels) => void save({ labels })} />
                    </Field>
                    <Field label="Milestone">
                        <Toggle
                            size="sm"
                            label="An important target in this project"
                            isSelected={task.isMilestone}
                            isDisabled={!editable}
                            onChange={(isMilestone) => void save({ isMilestone })}
                        />
                    </Field>
                </div>

                <Divider />

                <Section
                    title={`Subtasks${detail.subtasks.length ? ` (${detail.subtasks.filter((s) => s.status === "completed").length}/${detail.subtasks.length})` : ""}`}
                    action={
                        editable && task.depth < 3 && !addingSubtask ? (
                            <Button size="sm" color="link-color" iconLeading={Plus} onClick={() => setAddingSubtask(true)}>
                                Add subtask
                            </Button>
                        ) : null
                    }
                >
                    {detail.subtasks.length > 0 && (
                        <ul aria-label="Subtasks" className="-mt-1">
                            {detail.subtasks.map((sub) => (
                                <TaskRow key={sub.id} task={sub} actions={actions} />
                            ))}
                        </ul>
                    )}
                    {addingSubtask && (
                        <InlineAdd
                            defaults={{ parentId: task.id, projectId: task.projectId }}
                            placeholder="Subtask name"
                            onDone={() => (setAddingSubtask(false), void load())}
                        />
                    )}
                    {!detail.subtasks.length && !addingSubtask && (
                        <p className="text-sm text-tertiary">Break it into steps. Each one can be completed on its own.</p>
                    )}
                </Section>

                <Divider />

                <Section
                    title="Knowledge"
                    action={
                        editable && shell.canUseKnowledge ? (
                            <Button size="sm" color="link-color" iconLeading={Link01} onClick={() => setKnowledgeOpen(true)}>
                                Link
                            </Button>
                        ) : null
                    }
                >
                    {detail.knowledge.length ? (
                        <ul className="flex flex-col gap-2">
                            {detail.knowledge.map((ref) => (
                                <li key={ref.linkId} className="flex items-center gap-3 rounded-lg px-3 py-2 ring-1 ring-secondary ring-inset">
                                    <BookOpen01 aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                                    {ref.available ? (
                                        <a
                                            href={`/portal/knowledge/o/${ref.objectId}`}
                                            className="min-w-0 flex-1 truncate rounded-sm text-sm font-medium text-primary outline-focus-ring hover:underline focus-visible:outline-2"
                                        >
                                            {ref.title}
                                            <span className="ml-2 text-xs font-normal text-tertiary">{ref.spaceName}</span>
                                        </a>
                                    ) : (
                                        <span className="min-w-0 flex-1 text-sm text-tertiary">A Knowledge item you don't have access to</span>
                                    )}
                                    {editable && (
                                        <ButtonUtility
                                            size="xs"
                                            color="tertiary"
                                            icon={XClose}
                                            tooltip="Remove link"
                                            onClick={async () => {
                                                try {
                                                    const { knowledge } = await tasksApi.unlinkKnowledge(task.id, ref.linkId);
                                                    setDetail((d) => d && { ...d, knowledge });
                                                } catch (error) {
                                                    toast.error("Couldn't remove it", errorMessage(error));
                                                }
                                            }}
                                        />
                                    )}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-sm text-tertiary">
                            {shell.canUseKnowledge
                                ? "Link the notes, decisions or references behind this task. Only people who can read them in Knowledge will see them."
                                : "Knowledge links appear here."}
                        </p>
                    )}
                </Section>
                {knowledgeOpen && (
                    <KnowledgeLinkDialog
                        onClose={() => setKnowledgeOpen(false)}
                        onPick={async (objectId) => {
                            try {
                                const { knowledge } = await tasksApi.linkKnowledge(task.id, objectId);
                                setDetail((d) => d && { ...d, knowledge });
                                setKnowledgeOpen(false);
                            } catch (error) {
                                toast.error("Couldn't link it", errorMessage(error));
                            }
                        }}
                    />
                )}

                <Divider />

                <Reminders detail={detail} onChange={(reminders) => setDetail((d) => d && { ...d, reminders })} />

                <Divider />

                <Section title={`Comments${detail.comments.length ? ` (${detail.comments.length})` : ""}`}>
                    {detail.comments.length > 0 && (
                        <ul className="flex flex-col gap-4">
                            {detail.comments.map((c) => (
                                <li key={c.id} className="flex flex-col gap-1">
                                    <FeedItem
                                        id={c.id}
                                        size="sm"
                                        user={{
                                            name: c.authorName ?? personLabel(c.author, people),
                                            initials: initials(c.authorName ?? c.author.split("@")[0]),
                                        }}
                                        date={formatRelative(c.createdAt)}
                                        dateTime={c.createdAt}
                                        message={c.body}
                                    />
                                    {editable && (
                                        <div className="pl-11">
                                            <Button
                                                size="sm"
                                                color="link-gray"
                                                onClick={async () => {
                                                    try {
                                                        const { comments } = await tasksApi.deleteComment(c.id);
                                                        setDetail((d) => d && { ...d, comments });
                                                    } catch (error) {
                                                        toast.error("Couldn't delete it", errorMessage(error));
                                                    }
                                                }}
                                            >
                                                Delete
                                            </Button>
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {editable && (
                        <form
                            className="flex flex-col gap-2"
                            onSubmit={async (event) => {
                                event.preventDefault();
                                if (!comment.trim()) return;
                                try {
                                    const { comments } = await tasksApi.addComment(task.id, comment);
                                    setDetail((d) => d && { ...d, comments });
                                    setComment("");
                                    emit({ type: "saved", task: { ...task, comments: comments.length } });
                                } catch (error) {
                                    toast.error("Couldn't add the comment", errorMessage(error));
                                }
                            }}
                        >
                            <TextArea
                                aria-label="Add a comment"
                                placeholder="Add a comment"
                                rows={2}
                                value={comment}
                                onChange={setComment}
                                maxLength={LIMITS.comment}
                            />
                            <Button type="submit" size="sm" color="secondary" className="self-end" isDisabled={!comment.trim()}>
                                Comment
                            </Button>
                        </form>
                    )}
                </Section>

                {(detail.completions.length > 0 || detail.activity.length > 0) && (
                    <>
                        <Divider />
                        <Section title="History">
                            {task.recurrence && (
                                <p className="flex items-center gap-2 text-sm text-tertiary">
                                    <Repeat04 aria-hidden="true" className="size-4" /> {describeRule(task.recurrence)}
                                </p>
                            )}
                            {detail.completions.length > 0 && (
                                <ul className="flex flex-col gap-1 text-sm text-tertiary">
                                    {detail.completions.map((c) => (
                                        <li key={c.id} className={c.undoneAt ? "line-through" : undefined}>
                                            {c.kind === "skipped" ? "Skipped" : "Completed"} {c.occurrenceDate ? shortDate(c.occurrenceDate) : ""}
                                            {c.nextDate ? ` → next ${relativeDate(c.nextDate, today)}` : ""} ·{" "}
                                            {formatDateTime(c.at, shell.preferences.timeZone)}
                                            {c.undoneAt && <span className="sr-only"> (undone)</span>}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <ul className="flex flex-col gap-4">
                                {detail.activity.slice(0, 12).map((entry, i, all) => (
                                    <li key={entry.id}>
                                        <FeedItem
                                            id={entry.id}
                                            size="sm"
                                            connector={i < all.length - 1}
                                            user={{
                                                name: entry.actorName ?? personLabel(entry.actor, people),
                                                initials: initials(entry.actorName ?? entry.actor.split("@")[0]),
                                            }}
                                            date={formatRelative(entry.at)}
                                            dateTime={entry.at}
                                            action={{ content: activitySentence(entry, today) }}
                                        />
                                    </li>
                                ))}
                            </ul>
                        </Section>
                    </>
                )}
            </SlideoutMenu.Content>

            {editable && (
                <SlideoutMenu.Footer className="flex w-full flex-wrap items-center gap-3">
                    <Button size="sm" color="tertiary-destructive" iconLeading={Trash01} onClick={() => actions.remove(task)}>
                        Delete
                    </Button>
                    <Button size="sm" color="tertiary" iconLeading={Copy06} onClick={() => void actions.duplicate(task)}>
                        Duplicate
                    </Button>
                    <Button
                        size="sm"
                        className="ml-auto"
                        color={done ? "secondary" : "primary"}
                        onClick={async () => {
                            if (done) await actions.reopen(task);
                            else await actions.complete(task);
                            void load();
                        }}
                    >
                        {done ? "Reopen" : task.recurrence ? "Complete this occurrence" : "Complete"}
                    </Button>
                </SlideoutMenu.Footer>
            )}
            {actions.dialogs}
        </>
    );
};

/** Reminders are the caller's own; nobody else sees them. Shown in the app when they fall due. */
const Reminders = ({ detail, onChange }: { detail: TaskDetail; onChange: (reminders: TaskDetail["reminders"]) => void }) => {
    const { today, shell } = useTasks();
    const toast = useToast();
    const [date, setDate] = useState<string | null>(detail.task.dueDate ?? today);
    const [time, setTime] = useState(detail.task.dueTime ?? "09:00");
    const add = async (body: Parameters<typeof tasksApi.addReminder>[1]) => {
        try {
            onChange((await tasksApi.addReminder(detail.task.id, body)).reminders);
        } catch (error) {
            toast.error("Couldn't add the reminder", errorMessage(error));
        }
    };
    return (
        <Section title="Reminders">
            <p className="text-sm text-tertiary">
                Shown here in Tasks when it's time, on any device where Tasks is open. There are no email or phone notifications yet.
            </p>
            {detail.reminders.length > 0 && (
                <ul className="flex flex-col gap-2">
                    {detail.reminders.map((r) => (
                        <li key={r.id} className="flex items-center gap-3 text-sm text-secondary">
                            <span className="flex-1">
                                {formatDateTime(r.remindAt, shell.preferences.timeZone)}
                                {r.kind === "relative" && (
                                    <span className="text-tertiary"> · {r.offsetMinutes ? `${r.offsetMinutes} min before` : "at the due time"}</span>
                                )}
                                {r.dismissedAt && <span className="text-tertiary"> · done</span>}
                            </span>
                            <ButtonUtility
                                size="xs"
                                color="tertiary"
                                icon={XClose}
                                tooltip="Remove reminder"
                                onClick={async () => {
                                    try {
                                        await tasksApi.deleteReminder(r.id);
                                        onChange(detail.reminders.filter((x) => x.id !== r.id));
                                    } catch (error) {
                                        toast.error("Couldn't remove it", errorMessage(error));
                                    }
                                }}
                            />
                        </li>
                    ))}
                </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <DateMenu label="Reminder date" value={date} onChange={setDate} placeholder="Choose a date" />
                <Input aria-label="Reminder time" type="time" size="sm" className="w-32" value={time} onChange={setTime} />
                <Button size="sm" color="secondary" isDisabled={!date || !time} onClick={() => date && void add({ kind: "absolute", date, time })}>
                    Add reminder
                </Button>
                {detail.task.dueDate && (
                    <Button size="sm" color="link-color" onClick={() => void add({ kind: "relative", offsetMinutes: detail.task.dueTime ? 30 : 0 })}>
                        {detail.task.dueTime ? "30 min before it's due" : "On the day (9 am)"}
                    </Button>
                )}
            </div>
        </Section>
    );
};

/** Find a Knowledge object to link, using Knowledge's own search: only the caller's spaces are ever searched. */
const KnowledgeLinkDialog = ({ onClose, onPick }: { onClose: () => void; onPick: (objectId: string) => void }) => {
    const [query, setQuery] = useState("");
    const [hits, setHits] = useState<KnowledgeSearchHit[]>([]);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!query.trim()) return setHits([]);
        const timer = window.setTimeout(() => {
            api<{ hits: KnowledgeSearchHit[] }>("GET", `/api/portal/knowledge/search?q=${encodeURIComponent(query.trim())}&limit=20`)
                .then((r) => (setHits(r.hits), setError(null)))
                .catch((e) => setError(errorMessage(e)));
        }, 150);
        return () => window.clearTimeout(timer);
    }, [query]);
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title="Link Knowledge"
            icon={BookOpen01}
            description="Only you and people who can read it in Knowledge will see what it's called."
        >
            <Input aria-label="Search Knowledge" icon={SearchLg} placeholder="Search your Knowledge" value={query} onChange={setQuery} autoFocus />
            {error && <p className="text-sm text-error-primary">{error}</p>}
            <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto pb-4">
                {hits.map((hit) => (
                    <li key={hit.object.id}>
                        <button
                            type="button"
                            onClick={() => onPick(hit.object.id)}
                            className="flex w-full cursor-pointer flex-col items-start rounded-md px-3 py-2 text-left outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
                        >
                            <span className="text-sm font-medium text-primary">{titleOf(hit.object.title)}</span>
                        </button>
                    </li>
                ))}
                {query.trim() && !hits.length && !error && <li className="px-3 py-2 text-sm text-tertiary">Nothing found.</li>}
            </ul>
        </PortalDialog>
    );
};
