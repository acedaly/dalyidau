// Quick Add: type a task and press Enter. Words like "friday", "p2", "@errands", "#household",
// "every wednesday" or "{30 nov}" (a deadline) are read as you type and shown as chips underneath,
// so nothing is interpreted silently: each chip says what it understood and can be dismissed, which
// puts the words back in the title. The pickers set the same things explicitly and always win;
// choosing a date keeps a typed repeat (which then starts from that date) and time. Words that look
// like a date but aren't understood are pointed out, never dropped. If saving fails, everything
// typed stays where it was, and each draft carries a request id so a retry can't add it twice.
import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlignLeft, Lightning01, Target04 } from "@untitledui/icons";
import { BadgeWithButton } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { Toggle } from "@/components/base/toggle/toggle";
import { PortalDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { clockLabel, relativeDate, shortDate } from "@/shared/tasks/dates";
import { type TokenKind, parseQuickAdd } from "@/shared/tasks/parse";
import { describeRule, firstOnOrAfter, recurrenceInput, withAnchor } from "@/shared/tasks/recurrence";
import { DEFAULT_PRIORITY, PRIORITY_LABELS, type Priority } from "@/shared/tasks/types";
import { type CreateFields, type TaskFields, taskHref, tasksApi } from "./api";
import { AssigneePicker, DateMenu, LabelPicker, PriorityPicker, ProjectPicker, SectionPicker } from "./pickers";
import { draftId } from "./quick-add-events";
import { type QuickAddDefaults, useTasks } from "./tasks-context";

const TOKEN_NAMES: Record<TokenKind, string> = {
    date: "Due",
    time: "Time",
    priority: "Priority",
    label: "Label",
    project: "Project",
    recurrence: "Repeats",
    deadline: "Deadline",
};

interface QuickAddFormProps {
    defaults: QuickAddDefaults;
    onSaved?: () => void;
    onCancel?: () => void;
    /** Stay open for the next task after saving (inline lists). */
    keepOpen?: boolean;
    autoFocus?: boolean;
    placeholder?: string;
    compact?: boolean;
    /** Opens a task from the success message (on Tasks pages, in the panel; elsewhere, its page). */
    onOpenTask?: (id: string) => void;
}

export const QuickAddForm = ({ defaults, onSaved, onCancel, keepOpen, autoFocus = true, placeholder, compact, onOpenTask }: QuickAddFormProps) => {
    const { today, projects, writable, shell, emit, project: projectById } = useTasks();
    const toast = useToast();
    const [text, setText] = useState(defaults.title ?? "");
    const [disabled, setDisabled] = useState<TokenKind[]>([]);
    const [description, setDescription] = useState(defaults.description ?? "");
    const [showDescription, setShowDescription] = useState(!!defaults.description);
    const [chosen, setChosen] = useState<Partial<TaskFields>>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [clientId, setClientId] = useState(draftId);
    const [linkKnowledge, setLinkKnowledge] = useState(!!defaults.knowledge);
    const input = useRef<HTMLInputElement>(null);

    const parsed = parseQuickAdd(text, { today, projects: writable.map((p) => ({ id: p.id, name: p.name })), disabled });
    // Subtasks always go in their parent's project, so "#project" doesn't apply to them.
    const inParent = !!defaults.parentId;
    const projectId = chosen.projectId ?? (!inParent ? parsed.projectId : null) ?? defaults.projectId ?? shell.inboxId;
    // A date chosen with the picker replaces a typed date only; a typed repeat then starts from it.
    const dueDate = chosen.dueDate !== undefined ? chosen.dueDate : (parsed.dueDate ?? defaults.dueDate ?? null);
    const recurrence = parsed.recurrence;
    const draftRule = (() => {
        const input = recurrence && recurrenceInput.safeParse(recurrence);
        if (!input || !input.success) return null;
        const start = dueDate ?? today;
        const first = firstOnOrAfter(withAnchor(input.data, start), start);
        return first ? withAnchor(input.data, first) : null;
    })();
    const fields: CreateFields = {
        title: parsed.title,
        description: description.trim() || undefined,
        ...(inParent
            ? { parentId: defaults.parentId }
            : {
                  projectId,
                  sectionId:
                      projectId === defaults.projectId ? (chosen.sectionId !== undefined ? chosen.sectionId : defaults.sectionId) : (chosen.sectionId ?? null),
              }),
        priority: (chosen.priority ?? parsed.priority ?? defaults.priority ?? DEFAULT_PRIORITY) as Priority,
        dueDate,
        dueTime: chosen.dueTime !== undefined ? chosen.dueTime : parsed.dueTime,
        deadline: parsed.deadline ?? defaults.deadline ?? null,
        recurrence,
        labels: [...new Set([...(defaults.labels ?? []), ...parsed.labels, ...(chosen.labels ?? [])])],
        assignee: chosen.assignee !== undefined ? chosen.assignee : (defaults.assignee ?? null),
        clientId,
        ...(defaults.knowledge && linkKnowledge ? { knowledge: [defaults.knowledge.id] } : {}),
    };
    if (!fields.dueDate) fields.dueTime = null;
    const targetProject = projectById(inParent ? (defaults.projectId ?? "") : projectId);
    const rule = draftRule;

    useEffect(() => {
        if (autoFocus) input.current?.focus();
    }, [autoFocus]);

    const save = async () => {
        if (!parsed.title.trim() || busy) return;
        setBusy(true);
        setError(null);
        try {
            const { task, replayed } = await tasksApi.create(fields);
            emit({ type: "created", task });
            const where = projectById(task.projectId);
            toast.show({
                title: replayed ? "Already added" : "Task added",
                description: `${task.title}${where ? ` · ${where.name}` : ""}${task.dueDate ? ` · ${relativeDate(task.dueDate, today)}` : ""}`,
                color: "success",
                action: onOpenTask
                    ? { label: "Open", run: () => onOpenTask(task.id) }
                    : { label: "Open", run: () => window.location.assign(taskHref(task.id)) },
            });
            setText("");
            setDescription("");
            setShowDescription(false);
            setDisabled([]);
            setChosen((c) => ({ projectId: c.projectId, sectionId: c.sectionId }));
            setClientId(draftId());
            onSaved?.();
            if (keepOpen) input.current?.focus();
        } catch (e) {
            // Keep what they typed (and the request id, so retrying can't add it twice); say what went wrong next to it.
            setError(e instanceof ApiError && e.issues.length ? e.issues.map((i) => i.message).join(" ") : errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    const chipLabel = (kind: TokenKind, text: string) => {
        switch (kind) {
            case "date":
                // An ambiguous reading shows the exact date it chose.
                return parsed.dueDate
                    ? parsed.tokens.some((t) => t.kind === "date" && t.ambiguous)
                        ? shortDate(parsed.dueDate)
                        : relativeDate(parsed.dueDate, today)
                    : text;
            case "time":
                return parsed.dueTime ? clockLabel(parsed.dueTime) : text;
            case "deadline":
                return parsed.deadline ? relativeDate(parsed.deadline, today) : text;
            case "priority":
                return parsed.priority ? `${PRIORITY_LABELS[parsed.priority].short} ${PRIORITY_LABELS[parsed.priority].label}` : text;
            case "project":
                return projects.find((p) => p.id === parsed.projectId)?.name ?? text;
            case "recurrence":
                return rule ? `${describeRule(rule)}, from ${relativeDate(rule.anchor, today)}` : text;
            default:
                return text.replace(/^@/, "");
        }
    };
    // A date chosen with the picker replaces the typed one, so its chip goes.
    const chips = parsed.tokens.filter((t) => !(inParent && t.kind === "project") && !(t.kind === "date" && chosen.dueDate !== undefined));

    return (
        <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                void save();
            }}
            onKeyDown={(event) => {
                if (event.key === "Escape" && onCancel) {
                    event.stopPropagation();
                    onCancel();
                }
            }}
        >
            <Input
                ref={input}
                aria-label="Task name"
                aria-describedby={chips.length ? "quick-add-understood" : undefined}
                placeholder={placeholder ?? "e.g. Pay electricity bill friday p2 @admin"}
                size={compact ? "sm" : "md"}
                value={text}
                onChange={(value) => {
                    setText(value);
                    if (!value) setDisabled([]);
                }}
                isInvalid={!!error}
                hint={error ?? undefined}
            />
            {chips.length > 0 && (
                <div id="quick-add-understood" className="flex flex-wrap items-center gap-1.5" aria-live="polite">
                    <span className="text-xs text-tertiary">Understood:</span>
                    {chips.map((token) => (
                        <BadgeWithButton
                            key={`${token.kind}:${token.text}`}
                            size="sm"
                            type="color"
                            color={token.ambiguous ? "warning" : "brand"}
                            buttonLabel={`Don't read “${token.text}” as ${TOKEN_NAMES[token.kind].toLowerCase()}`}
                            onButtonClick={() => setDisabled((d) => [...d, token.kind])}
                        >
                            <span>
                                {TOKEN_NAMES[token.kind]}: {chipLabel(token.kind, token.text)}
                                {token.ambiguous && <span className="font-normal"> ({token.ambiguous})</span>}
                            </span>
                        </BadgeWithButton>
                    ))}
                </div>
            )}
            {parsed.hints.length > 0 && (
                <ul id="quick-add-not-understood" className="flex flex-col gap-1" aria-live="polite">
                    {parsed.hints.map((hint) => (
                        <li key={hint.text} className="flex items-start gap-1.5 text-xs text-secondary">
                            <AlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0 text-fg-warning-primary" />
                            <span>
                                “{hint.text}” {hint.message}, so it stays in the title. Use the pickers below to set it.
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {showDescription ? <TextArea aria-label="Description" placeholder="Description" rows={3} value={description} onChange={setDescription} /> : null}
            <div className="flex flex-wrap items-center gap-2">
                {!inParent && (
                    <ProjectPicker value={projectId} onChange={(id) => setChosen((c) => ({ ...c, projectId: id, sectionId: null, assignee: null }))} />
                )}
                {!inParent && (
                    <SectionPicker projectId={projectId} value={fields.sectionId ?? null} onChange={(id) => setChosen((c) => ({ ...c, sectionId: id }))} />
                )}
                <DateMenu
                    label="Due date"
                    value={fields.dueDate ?? null}
                    time={fields.dueTime}
                    onChange={(date) => setChosen((c) => ({ ...c, dueDate: date }))}
                />
                {fields.dueDate && (
                    <Input
                        aria-label="Due time"
                        type="time"
                        size="sm"
                        className="w-32"
                        value={fields.dueTime ?? ""}
                        onChange={(value) => setChosen((c) => ({ ...c, dueTime: value || null }))}
                    />
                )}
                <PriorityPicker value={fields.priority as Priority} onChange={(priority) => setChosen((c) => ({ ...c, priority }))} />
                <LabelPicker value={fields.labels ?? []} onChange={(labels) => setChosen((c) => ({ ...c, labels }))} />
                {targetProject?.kind === "shared" && (
                    <AssigneePicker
                        projectId={targetProject.id}
                        value={fields.assignee ?? null}
                        onChange={(assignee) => setChosen((c) => ({ ...c, assignee }))}
                    />
                )}
                {!showDescription && (
                    <Button size="sm" color="tertiary" iconLeading={AlignLeft} onClick={() => setShowDescription(true)}>
                        Description
                    </Button>
                )}
                {fields.deadline && (
                    <span className="inline-flex items-center gap-1 text-xs text-tertiary">
                        <Target04 aria-hidden="true" className="size-3.5" /> Deadline {relativeDate(fields.deadline, today)}
                    </span>
                )}
            </div>
            {defaults.knowledge && (
                <Toggle
                    size="sm"
                    className="w-full"
                    isSelected={linkKnowledge}
                    onChange={setLinkKnowledge}
                    label={`Link to “${defaults.knowledge.title || "Untitled"}”`}
                    hint="Only people who can read it in Knowledge will see what it is."
                />
            )}
            <div className="flex items-center justify-end gap-2">
                {onCancel && (
                    <Button size="sm" color="secondary" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
                <Button type="submit" size="sm" iconLeading={Lightning01} isLoading={busy} showTextWhileLoading isDisabled={!parsed.title.trim()}>
                    Add task
                </Button>
            </div>
        </form>
    );
};

/** The Quick Add dialog, opened with "q" or the Add task button from any page. */
export const QuickAddDialog = ({ inTasks = true }: { inTasks?: boolean }) => {
    const { quickAdd, closeQuickAdd, openTask } = useTasks();
    return (
        <PortalDialog
            isOpen={!!quickAdd}
            onOpenChange={(open) => !open && closeQuickAdd()}
            title="Add a task"
            icon={Lightning01}
            size="lg"
            description="Type naturally: “Pay rent friday p2 @admin”, “Bins every wednesday at 7pm”, “Tax return {31 oct}” for a deadline. Check what was understood before pressing Enter."
        >
            {quickAdd && <QuickAddForm defaults={quickAdd} onSaved={closeQuickAdd} onCancel={closeQuickAdd} onOpenTask={inTasks ? openTask : undefined} />}
            <div className="h-4" />
        </PortalDialog>
    );
};

/** Add tasks inline at the end of a list or under a parent; stays open for the next one. */
export const InlineAdd = ({ defaults, onDone, placeholder }: { defaults: QuickAddDefaults; onDone: () => void; placeholder?: string }) => (
    <div className="rounded-xl bg-primary p-3 shadow-xs ring-1 ring-secondary ring-inset">
        <QuickAddForm defaults={defaults} keepOpen compact onCancel={onDone} placeholder={placeholder} />
    </div>
);
