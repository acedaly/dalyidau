// A list of tasks: subtasks nested under their parents (collapsible), keyboard navigation (j/k or
// the arrow keys move between tasks; Enter opens; e completes; Alt+↑/↓ reorders), optional bulk
// selection and an inline "Add task" at the end. Reordering by keyboard or menu is the accessible
// alternative to dragging.
import type { KeyboardEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import { Plus } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import type { TaskSummary } from "@/shared/tasks/types";
import type { TaskFields } from "./api";
import { InlineAdd } from "./quick-add";
import { TaskRow } from "./task-row";
import { useTasks } from "./tasks-context";
import type { useTaskActions } from "./use-task-actions";

interface TaskListProps {
    tasks: TaskSummary[];
    actions: ReturnType<typeof useTaskActions>;
    /** Nest subtasks under parents that are in the list (projects, Inbox). Otherwise flat, with parent names as context. */
    nested?: boolean;
    showProject?: boolean;
    /** Allow reordering among siblings. */
    reorderable?: boolean;
    /** Where "Add task" puts new tasks. Omit to hide it. */
    addDefaults?: Omit<TaskFields, "title">;
    addLabel?: string;
    selection?: { selected: Set<string>; onChange: (ids: Set<string>) => void } | null;
    /** Titles of parents not in the list, for flat lists. */
    parentTitles?: Record<string, string>;
    empty?: ReactNode;
    "aria-label": string;
}

interface Node {
    task: TaskSummary;
    depth: number;
    hasChildren: boolean;
}

export const TaskList = ({
    tasks,
    actions,
    nested,
    showProject,
    reorderable,
    addDefaults,
    addLabel = "Add task",
    selection,
    parentTitles,
    empty,
    ...props
}: TaskListProps) => {
    const { canEdit } = useTasks();
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [focusedId, setFocusedId] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [addingUnder, setAddingUnder] = useState<string | null>(null);

    // Parents first, each followed by its (visible) subtasks, in position order.
    const nodes = useMemo<Node[]>(() => {
        const key = (t: TaskSummary) => (t.projected ? `${t.id}:${t.dueDate}` : t.id);
        if (!nested) return tasks.map((task) => ({ task, depth: 0, hasChildren: false, key: key(task) }));
        const ids = new Set(tasks.map((t) => t.id));
        const children = new Map<string, TaskSummary[]>();
        const roots: TaskSummary[] = [];
        for (const task of tasks) {
            if (task.parentId && ids.has(task.parentId)) children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
            else roots.push(task);
        }
        const sort = (list: TaskSummary[]) => [...list].sort((a, b) => a.position - b.position);
        const out: Node[] = [];
        const walk = (task: TaskSummary, depth: number) => {
            const kids = sort(children.get(task.id) ?? []);
            out.push({ task, depth, hasChildren: kids.length > 0 });
            if (!collapsed.has(task.id)) kids.forEach((kid) => walk(kid, depth + 1));
        };
        // Roots keep the order they came in (the server's order), which may group by section or date.
        roots.forEach((task) => walk(task, 0));
        return out;
    }, [tasks, nested, collapsed]);

    const siblings = (task: TaskSummary) =>
        tasks
            .filter((t) => t.parentId === task.parentId && t.sectionId === task.sectionId && t.projectId === task.projectId && !t.projected)
            .sort((a, b) => a.position - b.position);

    const moveBy = (task: TaskSummary, delta: -1 | 1) => {
        const list = siblings(task);
        const index = list.findIndex((t) => t.id === task.id);
        const target = list[index + delta];
        if (!target) return;
        void actions.move(task, delta < 0 ? { beforeId: target.id } : { afterId: target.id });
        setFocusedId(task.id);
    };

    const focusRow = (id: string) => {
        setFocusedId(id);
        window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`li[data-task-id="${id}"]`)?.focus());
    };

    const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, [contenteditable]")) return;
        const down = event.key === "j" || (event.key === "ArrowDown" && !event.altKey);
        const up = event.key === "k" || (event.key === "ArrowUp" && !event.altKey);
        if (!down && !up) return;
        event.preventDefault();
        const index = nodes.findIndex((n) => n.task.id === focusedId);
        const next = nodes[Math.min(Math.max(index + (down ? 1 : -1), 0), nodes.length - 1)];
        if (next) focusRow(next.task.id);
    };

    const toggle = (id: string) => setCollapsed((set) => (set.has(id) ? new Set([...set].filter((x) => x !== id)) : new Set([...set, id])));
    const canAdd = !!addDefaults && (!addDefaults.projectId || canEdit(addDefaults.projectId));

    return (
        <div className="flex flex-col">
            {nodes.length > 0 ? (
                <ul aria-label={props["aria-label"]} onKeyDown={onKeyDown} className={nested ? "pl-7" : undefined}>
                    {nodes.map(({ task, depth, hasChildren }, index) => (
                        <TaskRowWithAdd
                            key={task.projected ? `${task.id}:${task.dueDate}` : task.id}
                            addingUnder={addingUnder}
                            setAddingUnder={setAddingUnder}
                            task={task}
                        >
                            <TaskRow
                                task={task}
                                actions={actions}
                                showProject={showProject}
                                indent={depth}
                                expanded={hasChildren ? !collapsed.has(task.id) : undefined}
                                onToggleExpanded={hasChildren ? () => toggle(task.id) : undefined}
                                selectable={!!selection && !task.projected}
                                selected={selection?.selected.has(task.id)}
                                onSelectedChange={(on) => {
                                    if (!selection) return;
                                    const next = new Set(selection.selected);
                                    if (on) next.add(task.id);
                                    else next.delete(task.id);
                                    selection.onChange(next);
                                }}
                                focused={focusedId ? focusedId === task.id : index === 0}
                                onFocusRow={() => setFocusedId(task.id)}
                                onMoveUp={reorderable && !task.projected ? () => moveBy(task, -1) : undefined}
                                onMoveDown={reorderable && !task.projected ? () => moveBy(task, 1) : undefined}
                                onAddSubtask={nested && task.depth < 3 && !task.projected ? () => setAddingUnder(task.id) : undefined}
                                parentTitle={!nested && task.parentId ? (parentTitles?.[task.parentId] ?? null) : null}
                            />
                        </TaskRowWithAdd>
                    ))}
                </ul>
            ) : (
                empty
            )}
            {canAdd &&
                (adding ? (
                    <InlineAdd defaults={addDefaults!} onDone={() => setAdding(false)} />
                ) : (
                    <div className="py-2">
                        <Button size="sm" color="link-gray" iconLeading={Plus} onClick={() => setAdding(true)}>
                            {addLabel}
                        </Button>
                    </div>
                ))}
        </div>
    );
};

/** A row, followed by an inline composer for a new subtask when one is being added under it. */
const TaskRowWithAdd = ({
    task,
    addingUnder,
    setAddingUnder,
    children,
}: {
    task: TaskSummary;
    addingUnder: string | null;
    setAddingUnder: (id: string | null) => void;
    children: ReactNode;
}) => (
    <>
        {children}
        {addingUnder === task.id && (
            <li className="list-none border-b border-secondary py-2" style={{ paddingLeft: `${(task.depth + 1) * 1.75}rem` }}>
                <InlineAdd defaults={{ parentId: task.id }} placeholder="Subtask name" onDone={() => setAddingUnder(null)} />
            </li>
        )}
    </>
);
