// Quick Add: type a task and press Enter. Words like "friday", "p2", "@errands", "#household",
// "every wednesday" or "{30 nov}" (a deadline) are read as you type and shown as chips underneath,
// so nothing is interpreted silently: each chip says what it understood and can be dismissed, which
// puts the words back in the title. The pickers set the same things explicitly and always win.
// If saving fails, everything typed stays where it was.
import { useEffect, useRef, useState } from "react";
import { AlignLeft, Lightning01, Target04 } from "@untitledui/icons";
import { BadgeWithButton } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { PortalDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { clockLabel, relativeDate, shortDate } from "@/shared/tasks/dates";
import { type TokenKind, parseQuickAdd, previewRule } from "@/shared/tasks/parse";
import { describeRule } from "@/shared/tasks/recurrence";
import { DEFAULT_PRIORITY, PRIORITY_LABELS, type Priority } from "@/shared/tasks/types";
import { type TaskFields, tasksApi } from "./api";
import { AssigneePicker, DateMenu, LabelPicker, PriorityPicker, ProjectPicker, SectionPicker } from "./pickers";
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
}

export const QuickAddForm = ({ defaults, onSaved, onCancel, keepOpen, autoFocus = true, placeholder, compact }: QuickAddFormProps) => {
    const { today, projects, writable, shell, emit, project: projectById } = useTasks();
    const toast = useToast();
    const [text, setText] = useState(defaults.title ?? "");
    const [disabled, setDisabled] = useState<TokenKind[]>([]);
    const [description, setDescription] = useState(defaults.description ?? "");
    const [showDescription, setShowDescription] = useState(!!defaults.description);
    const [chosen, setChosen] = useState<Partial<TaskFields>>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);

    const parsed = parseQuickAdd(text, { today, projects: writable.map((p) => ({ id: p.id, name: p.name })), disabled });
    // Subtasks always go in their parent's project, so "#project" doesn't apply to them.
    const inParent = !!defaults.parentId;
    const projectId = chosen.projectId ?? (!inParent ? parsed.projectId : null) ?? defaults.projectId ?? shell.inboxId;
    const fields: TaskFields & { title: string } = {
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
        dueDate: chosen.dueDate !== undefined ? chosen.dueDate : (parsed.dueDate ?? defaults.dueDate ?? null),
        dueTime: chosen.dueDate !== undefined ? null : parsed.dueTime,
        deadline: parsed.deadline ?? defaults.deadline ?? null,
        recurrence: chosen.dueDate !== undefined ? null : parsed.recurrence,
        labels: [...new Set([...(defaults.labels ?? []), ...parsed.labels, ...(chosen.labels ?? [])])],
        assignee: chosen.assignee !== undefined ? chosen.assignee : (defaults.assignee ?? null),
    };
    const targetProject = projectById(inParent ? (defaults.projectId ?? "") : projectId);
    const rule = previewRule(parsed);

    useEffect(() => {
        if (autoFocus) input.current?.focus();
    }, [autoFocus]);

    const save = async () => {
        if (!parsed.title.trim() || busy) return;
        setBusy(true);
        setError(null);
        try {
            const { task } = await tasksApi.create(fields);
            emit({ type: "created", task });
            const where = projectById(task.projectId);
            toast.success("Task added", `${task.title}${where ? ` · ${where.name}` : ""}${task.dueDate ? ` · ${relativeDate(task.dueDate, today)}` : ""}`);
            setText("");
            setDescription("");
            setShowDescription(false);
            setDisabled([]);
            setChosen((c) => ({ projectId: c.projectId, sectionId: c.sectionId }));
            onSaved?.();
            if (keepOpen) input.current?.focus();
        } catch (e) {
            // Keep what they typed; say what went wrong next to it.
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
                return rule ? describeRule(rule) : text;
            default:
                return text.replace(/^@/, "");
        }
    };
    const chips = parsed.tokens.filter((t) => !(inParent && t.kind === "project"));

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
                    onChange={(date) => {
                        setChosen((c) => ({ ...c, dueDate: date }));
                        setDisabled((d) => [...new Set([...d, "date", "time", "recurrence"] as TokenKind[])]);
                    }}
                />
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

/** The Quick Add dialog, opened with "q" or the Add task button from any Tasks page. */
export const QuickAddDialog = () => {
    const { quickAdd, closeQuickAdd } = useTasks();
    return (
        <PortalDialog
            isOpen={!!quickAdd}
            onOpenChange={(open) => !open && closeQuickAdd()}
            title="Add a task"
            icon={Lightning01}
            size="lg"
            description="Type naturally: “Pay rent friday p2 @admin”, “Bins every wednesday at 7pm”, “Tax return {31 oct}” for a deadline. Check what was understood before pressing Enter."
        >
            {quickAdd && <QuickAddForm defaults={quickAdd} onSaved={closeQuickAdd} onCancel={closeQuickAdd} />}
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
