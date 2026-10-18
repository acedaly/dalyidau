// Sort, priority and grouping controls for a list, remembered per person and list (they follow the
// person to other devices). Lists that are already bounded (Today, Overdue, Inbox) are sorted and
// filtered here in the browser, without asking the server again; My Tasks asks the server, since
// it pages through everything.
import { FilterLines } from "@untitledui/icons";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Select } from "@/components/base/select/select";
import { PRIORITIES, PRIORITY_LABELS, type TaskProject, type TaskSummary } from "@/shared/tasks/types";
import { LIST_GROUP_LABELS, LIST_SORT_LABELS, type ListGroup, type ListSort, type ViewPreferences } from "@/shared/tasks/view-preferences";

interface ListControlsProps {
    preferences: ViewPreferences;
    onChange: (preferences: ViewPreferences) => void;
    sorts: readonly ListSort[];
    defaultSort: ListSort;
    groups?: readonly ListGroup[];
    defaultGroup?: ListGroup;
    label: string;
}

export const ListControls = ({ preferences, onChange, sorts, defaultSort, groups, defaultGroup = "none", label }: ListControlsProps) => {
    const priorities = preferences.priorities ?? [];
    return (
        <div role="group" aria-label={`Sort and filter ${label}`} className="flex flex-wrap items-center gap-2">
            <Select
                aria-label="Sort by"
                size="sm"
                className="w-full sm:w-44"
                icon={FilterLines}
                value={preferences.sort ?? defaultSort}
                onChange={(key) => key && onChange({ ...preferences, sort: key as ListSort })}
                items={sorts.map((s) => ({ id: s, label: `Sort: ${LIST_SORT_LABELS[s]}` }))}
            >
                {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
            </Select>
            {groups && (
                <Select
                    aria-label="Group by"
                    size="sm"
                    className="w-full sm:w-44"
                    value={preferences.group ?? defaultGroup}
                    onChange={(key) => key && onChange({ ...preferences, group: key as ListGroup })}
                    items={groups.map((g) => ({ id: g, label: g === "none" ? LIST_GROUP_LABELS.none : `Group: ${LIST_GROUP_LABELS[g]}` }))}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            )}
            <ButtonGroup
                size="sm"
                aria-label="Only these priorities"
                selectionMode="multiple"
                selectedKeys={new Set(priorities.map(String))}
                onSelectionChange={(keys) => onChange({ ...preferences, priorities: [...keys].map(Number).sort() })}
            >
                {PRIORITIES.map((p) => (
                    <ButtonGroupItem key={p} id={String(p)} aria-label={`${PRIORITY_LABELS[p].short} ${PRIORITY_LABELS[p].label}`}>
                        {PRIORITY_LABELS[p].short}
                    </ButtonGroupItem>
                ))}
            </ButtonGroup>
        </div>
    );
};

const byDue = (a: TaskSummary, b: TaskSummary) =>
    (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99") || a.priority - b.priority;

/** The list in the chosen order. "manual" keeps the server's order (the project's own order). */
export function sortTasks(tasks: TaskSummary[], sort: ListSort, projects: TaskProject[]): TaskSummary[] {
    const projectIndex = new Map(projects.map((p, i) => [p.id, p.isInbox ? -1 : i]));
    const compare: Record<ListSort, ((a: TaskSummary, b: TaskSummary) => number) | null> = {
        due: byDue,
        priority: (a, b) => a.priority - b.priority || byDue(a, b),
        project: (a, b) => (projectIndex.get(a.projectId) ?? 999) - (projectIndex.get(b.projectId) ?? 999) || a.position - b.position,
        created: (a, b) => b.createdAt.localeCompare(a.createdAt),
        manual: null,
    };
    const fn = compare[sort];
    return fn ? [...tasks].sort(fn) : tasks;
}

/** Only the chosen priorities (all of them when none are chosen). */
export const withPriorities = (tasks: TaskSummary[], priorities: number[] | undefined) =>
    priorities?.length ? tasks.filter((t) => priorities.includes(t.priority)) : tasks;
