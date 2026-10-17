// One task in a list: a completion circle ringed in its priority colour, the title (which opens the
// task panel), its dates, labels, project and assignee, and a menu for the common changes. Nothing
// depends on hover: the menu button is always there, and every action is reachable by keyboard.
import type { KeyboardEvent } from "react";
import { Check, ChevronDown, ChevronRight, CornerDownRight, DotsVertical, MessageSquare01, Repeat04 } from "@untitledui/icons";
import { Checkbox as AriaCheckbox } from "react-aria-components";
import { Badge } from "@/components/base/badges/badges";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { CheckboxBase } from "@/components/base/checkbox/checkbox";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { addDays } from "@/shared/tasks/dates";
import { PRIORITIES, PRIORITY_LABELS, type Priority, type TaskSummary } from "@/shared/tasks/types";
import { cx } from "@/utils/cx";
import { AssigneeAvatar, DeadlineBadge, DueBadge, PRIORITY_COLORS, PriorityFlag, ProjectDot, titleOf } from "./shared";
import { useTasks } from "./tasks-context";
import type { useTaskActions } from "./use-task-actions";

export interface TaskRowProps {
    task: TaskSummary;
    actions: ReturnType<typeof useTaskActions>;
    /** Show which project it's in (lists that mix projects). */
    showProject?: boolean;
    /** Indent for subtasks shown under their parent. */
    indent?: number;
    /** Subtasks are shown below and can be collapsed. */
    expanded?: boolean;
    onToggleExpanded?: () => void;
    /** Bulk selection mode. */
    selectable?: boolean;
    selected?: boolean;
    onSelectedChange?: (selected: boolean) => void;
    /** Keyboard focus within the list (j/k). */
    focused?: boolean;
    onFocusRow?: () => void;
    /** Reordering within a list, for the keyboard alternative to dragging. */
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onAddSubtask?: () => void;
    /** Context for a subtask shown without its parent (Today, Upcoming, filters). */
    parentTitle?: string | null;
}

/** The round completion control: a checkbox for assistive technology, a circle on screen. */
export const CompleteCircle = ({ task, onChange, isDisabled }: { task: TaskSummary; onChange: () => void; isDisabled?: boolean }) => (
    <AriaCheckbox
        isSelected={task.status === "completed"}
        isDisabled={isDisabled}
        onChange={onChange}
        aria-label={`${task.status === "completed" ? "Reopen" : "Complete"} “${titleOf(task.title)}”`}
        className="group/check flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full outline-hidden disabled:cursor-not-allowed max-sm:-m-2.5 sm:size-6"
    >
        {({ isSelected, isFocusVisible, isHovered }) => (
            <span
                className={cx(
                    "flex size-5 items-center justify-center rounded-full ring-[1.5px] transition duration-100 ease-linear ring-inset",
                    PRIORITY_COLORS[task.priority].ring,
                    task.priority !== 4 && !isSelected && "bg-primary",
                    isSelected && "bg-fg-quaternary ring-fg-quaternary",
                    isFocusVisible && "outline-2 outline-offset-2 outline-focus-ring",
                )}
            >
                <Check
                    aria-hidden="true"
                    className={cx(
                        "size-3 text-fg-white",
                        isSelected ? "opacity-100" : "text-fg-quaternary opacity-0",
                        isHovered && !isSelected && "opacity-60",
                    )}
                    strokeWidth={3}
                />
            </span>
        )}
    </AriaCheckbox>
);

export const TaskRow = ({
    task,
    actions,
    showProject,
    indent = 0,
    expanded,
    onToggleExpanded,
    selectable,
    selected,
    onSelectedChange,
    focused,
    onFocusRow,
    onMoveUp,
    onMoveDown,
    onAddSubtask,
    parentTitle,
}: TaskRowProps) => {
    const { today, project, openTask, canEdit, assignable } = useTasks();
    const owner = project(task.projectId);
    const editable = canEdit(task.projectId) && !task.projected;
    const people = assignable(task.projectId);
    const done = task.status === "completed";

    const onMenu = (key: string) => {
        if (key === "open") openTask(task.id);
        else if (key === "today") void actions.update(task, { dueDate: today });
        else if (key === "tomorrow") void actions.update(task, { dueDate: addDays(today, 1) });
        else if (key === "week") void actions.update(task, { dueDate: addDays(today, 7) });
        else if (key === "nodate") void actions.update(task, { dueDate: null, dueTime: null, recurrence: null });
        else if (key.startsWith("p")) void actions.update(task, { priority: Number(key.slice(1)) as Priority });
        else if (key === "skip") void actions.skip(task);
        else if (key === "subtask") onAddSubtask?.();
        else if (key === "up") onMoveUp?.();
        else if (key === "down") onMoveDown?.();
        else if (key === "duplicate") void actions.duplicate(task);
        else if (key === "reopen") void actions.reopen(task);
        else if (key === "delete") actions.remove(task);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") (event.preventDefault(), openTask(task.id));
        else if ((event.key === "e" || event.key === "x") && editable) (event.preventDefault(), void (done ? actions.reopen(task) : actions.complete(task)));
        else if (event.altKey && event.key === "ArrowUp" && onMoveUp) (event.preventDefault(), onMoveUp());
        else if (event.altKey && event.key === "ArrowDown" && onMoveDown) (event.preventDefault(), onMoveDown());
    };

    return (
        <li
            data-task-id={task.id}
            tabIndex={focused ? 0 : -1}
            onFocus={(event) => event.target === event.currentTarget && onFocusRow?.()}
            onKeyDown={onKeyDown}
            aria-label={titleOf(task.title)}
            className={cx(
                "group/row relative flex items-start gap-3 border-b border-secondary py-3 pr-1 outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2",
                focused && "bg-primary_hover",
                task.projected && "opacity-70",
            )}
            style={indent ? { paddingLeft: `${indent * 1.75}rem` } : undefined}
        >
            {selectable && (
                <AriaCheckbox
                    isSelected={selected}
                    onChange={onSelectedChange}
                    aria-label={`Select “${titleOf(task.title)}”`}
                    className="mt-0.5 flex shrink-0 cursor-pointer items-center"
                >
                    {({ isSelected, isFocusVisible }) => <CheckboxBase isSelected={isSelected} isFocusVisible={isFocusVisible} size="md" />}
                </AriaCheckbox>
            )}
            {onToggleExpanded ? (
                <button
                    type="button"
                    onClick={onToggleExpanded}
                    aria-label={`${expanded ? "Collapse" : "Expand"} subtasks of “${titleOf(task.title)}”`}
                    aria-expanded={expanded}
                    className="-ml-7 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-quaternary outline-focus-ring hover:text-fg-quaternary_hover focus-visible:outline-2"
                >
                    {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                </button>
            ) : null}
            {task.projected ? (
                <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center text-fg-quaternary">
                    <Repeat04 className="size-4" />
                </span>
            ) : (
                <CompleteCircle task={task} isDisabled={!editable} onChange={() => void (done ? actions.reopen(task) : actions.complete(task))} />
            )}
            <div className="min-w-0 flex-1">
                {parentTitle && (
                    <p className="flex items-center gap-1 truncate text-xs text-tertiary">
                        <CornerDownRight aria-hidden="true" className="size-3 shrink-0" />
                        <span className="truncate">{parentTitle}</span>
                    </p>
                )}
                <button
                    type="button"
                    onClick={() => openTask(task.id)}
                    className={cx(
                        "block w-full cursor-pointer rounded-sm text-left text-sm font-medium wrap-break-word text-primary outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2",
                        done && "text-tertiary line-through",
                    )}
                >
                    {titleOf(task.title)}
                    {task.projected && <span className="sr-only"> (a later repeat)</span>}
                </button>
                {task.excerpt && <p className="mt-0.5 line-clamp-1 text-sm text-tertiary">{task.excerpt}</p>}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                    <PriorityFlag priority={task.priority} />
                    <DueBadge task={task} today={today} />
                    <DeadlineBadge deadline={task.deadline} today={today} />
                    {task.isMilestone && (
                        <Badge type="color" size="sm" color="purple">
                            Milestone
                        </Badge>
                    )}
                    {task.subtasks.total > 0 && (
                        <span className="text-xs text-tertiary">
                            {task.subtasks.total - task.subtasks.open}/{task.subtasks.total}
                            <span className="sr-only"> subtasks done</span>
                        </span>
                    )}
                    {task.comments > 0 && (
                        <span className="inline-flex items-center gap-1 text-xs text-tertiary">
                            <MessageSquare01 aria-hidden="true" className="size-3.5" />
                            {task.comments}
                            <span className="sr-only"> comments</span>
                        </span>
                    )}
                    {task.labels.map((label) => (
                        <a
                            key={label}
                            href={`/portal/tasks/filters?labels=${encodeURIComponent(label)}`}
                            className="rounded-sm text-xs font-medium text-brand-secondary outline-focus-ring hover:text-brand-secondary_hover focus-visible:outline-2"
                        >
                            @{label}
                        </a>
                    ))}
                    {showProject && owner && (
                        <a
                            href={`/portal/tasks/p/${owner.id}`}
                            className="inline-flex items-center gap-1.5 rounded-sm text-xs text-tertiary outline-focus-ring hover:text-secondary focus-visible:outline-2"
                        >
                            <ProjectDot color={owner.color} />
                            {owner.name}
                        </a>
                    )}
                    {task.assignee && <AssigneeAvatar email={task.assignee} people={people} />}
                </div>
            </div>
            {editable && (
                <Dropdown.Root>
                    <ButtonUtility
                        size="sm"
                        color="tertiary"
                        icon={DotsVertical}
                        tooltip={`Actions for “${titleOf(task.title)}”`}
                        className="mt-0.5 shrink-0 max-sm:size-9"
                    />
                    <Dropdown.Popover className="w-56">
                        <Dropdown.Menu onAction={(key) => onMenu(String(key))}>
                            <Dropdown.Section>
                                <Dropdown.Item id="open" label="Open details" addon="↵" />
                                {!done && onAddSubtask && <Dropdown.Item id="subtask" label="Add subtask" />}
                            </Dropdown.Section>
                            {!done && (
                                <>
                                    <Dropdown.Separator />
                                    <Dropdown.Section>
                                        <Dropdown.Item id="today" label="Due today" />
                                        <Dropdown.Item id="tomorrow" label="Due tomorrow" />
                                        <Dropdown.Item id="week" label="Due in a week" />
                                        {task.recurrence ? (
                                            <Dropdown.Item id="skip" label="Skip this occurrence" />
                                        ) : (
                                            task.dueDate && <Dropdown.Item id="nodate" label="Remove date" />
                                        )}
                                    </Dropdown.Section>
                                    <Dropdown.Separator />
                                    <Dropdown.Section>
                                        {PRIORITIES.map((p) => (
                                            <Dropdown.Item
                                                key={p}
                                                id={`p${p}`}
                                                label={`${PRIORITY_LABELS[p].short} · ${PRIORITY_LABELS[p].label}`}
                                                addon={task.priority === p ? "✓" : undefined}
                                            />
                                        ))}
                                    </Dropdown.Section>
                                </>
                            )}
                            {(onMoveUp || onMoveDown) && (
                                <>
                                    <Dropdown.Separator />
                                    <Dropdown.Section>
                                        {onMoveUp && <Dropdown.Item id="up" label="Move up" addon="⌥↑" />}
                                        {onMoveDown && <Dropdown.Item id="down" label="Move down" addon="⌥↓" />}
                                    </Dropdown.Section>
                                </>
                            )}
                            <Dropdown.Separator />
                            <Dropdown.Section>
                                {done && <Dropdown.Item id="reopen" label="Reopen" />}
                                <Dropdown.Item id="duplicate" label="Duplicate" />
                                <Dropdown.Item id="delete" label="Delete…" />
                            </Dropdown.Section>
                        </Dropdown.Menu>
                    </Dropdown.Popover>
                </Dropdown.Root>
            )}
        </li>
    );
};
