// Filters: combine projects, labels, priorities, dates, deadlines, assignee, status and text, see
// the matching tasks, and save the combination. The builder is a slideout laid out like Untitled UI
// PRO's filters menu. What's saved is only the validated definition; the server applies it to your
// own projects every time.
import { useState } from "react";
import { Bookmark, Edit05, FilterLines, Trash01 } from "@untitledui/icons";
import { Checkbox as AriaCheckbox } from "react-aria-components";
import { Dialog, Modal, ModalOverlay, SlideoutMenu } from "@/components/application/slideout-menus/slideout-menu";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { CheckboxBase } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import {
    ASSIGNEE_FILTERS,
    ASSIGNEE_LABELS,
    DEADLINE_FILTERS,
    DEADLINE_LABELS,
    DUE_FILTERS,
    DUE_LABELS,
    SCOPE_FILTERS,
    SCOPE_LABELS,
    SORTS,
    SORT_LABELS,
    STATUS_FILTERS,
    STATUS_LABELS,
    type TaskFilter,
    describeFilter,
    filterToParams,
} from "@/shared/tasks/filters";
import { PRIORITIES, PRIORITY_LABELS, type TaskColor } from "@/shared/tasks/types";
import { cx } from "@/utils/cx";
import { tasksApi } from "../api";
import { BulkBar } from "../bulk-bar";
import { PRIORITY_COLORS } from "../shared";
import { TaskList } from "../task-list";
import { useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";
import { useLiveList } from "../use-live-list";
import { useTaskActions } from "../use-task-actions";

const PAGE = 200;

export const TasksFiltersPage = ({ data }: { data: PageData<"tasks-filters"> }) => (
    <TasksLayout shell={data}>
        <FiltersBody data={data} />
    </TasksLayout>
);

const href = (filter: TaskFilter) => {
    const params = filterToParams(filter).toString();
    return params ? `/portal/tasks/filters?${params}` : "/portal/tasks/filters?status=open";
};

const CheckBadge = ({ label, color, isSelected, onChange }: { label: string; color: TaskColor; isSelected: boolean; onChange: (on: boolean) => void }) => (
    <AriaCheckbox
        isSelected={isSelected}
        onChange={onChange}
        className={(state) => cx("flex cursor-pointer items-center gap-2", state.isDisabled && "cursor-not-allowed")}
    >
        {({ isSelected: on, isFocusVisible }) => (
            <>
                <CheckboxBase isSelected={on} isFocusVisible={isFocusVisible} />
                <Badge size="md" type="pill-color" color={color}>
                    {label}
                </Badge>
            </>
        )}
    </AriaCheckbox>
);

function EnumSelect<T extends string>({
    label,
    value,
    options,
    labels,
    onChange,
}: {
    label: string;
    value: T;
    options: readonly T[];
    labels: Record<T, string>;
    onChange: (v: T) => void;
}) {
    return (
        <Select label={label} size="sm" value={value} onChange={(key) => key && onChange(key as T)} items={options.map((o) => ({ id: o, label: labels[o] }))}>
            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
        </Select>
    );
}

const FilterBuilder = ({ initial, isOpen, onOpenChange }: { initial: TaskFilter; isOpen: boolean; onOpenChange: (open: boolean) => void }) => {
    const { projects, labels, shell, sections } = useTasks();
    const [f, setF] = useState<TaskFilter>(initial);
    const set = <K extends keyof TaskFilter>(key: K, value: TaskFilter[K]) => setF((x) => ({ ...x, [key]: value }));
    const toggle = <T,>(list: T[], value: T, on: boolean) => (on ? [...list, value] : list.filter((v) => v !== value));
    const labelNames = [...new Set([...labels.map((l) => l.name), ...f.labels])];

    return (
        <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable className="z-50">
            <Modal className="max-w-full md:max-w-110">
                <Dialog aria-label="Filter tasks">
                    <SlideoutMenu.Header onClose={() => onOpenChange(false)} className="relative flex w-full flex-col gap-0.5 px-4 pt-6 md:px-6">
                        <h2 className="text-md font-semibold text-primary md:text-lg">Filter tasks</h2>
                        <p className="text-sm text-tertiary">Combine any of these. Only your own projects are ever searched.</p>
                    </SlideoutMenu.Header>
                    <SlideoutMenu.Content role="region" aria-label="Filter options">
                        <Select
                            aria-label="Start from a saved filter"
                            size="md"
                            placeholder="Start from a saved filter"
                            icon={FilterLines}
                            onChange={(key) => {
                                const view = shell.views.find((v) => v.id === key);
                                if (view) setF(view.definition);
                            }}
                            items={shell.views.map((v) => ({ id: v.id, label: v.name }))}
                        >
                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                        </Select>
                        <Input label="Words" size="sm" placeholder="In the title or description" value={f.text} onChange={(v) => set("text", v)} />
                        <div className="flex flex-col gap-3">
                            <p className="text-sm font-semibold text-primary">Priority</p>
                            <div className="flex flex-wrap gap-3 pl-1">
                                {PRIORITIES.map((p) => (
                                    <CheckBadge
                                        key={p}
                                        label={`${PRIORITY_LABELS[p].short} ${PRIORITY_LABELS[p].label}`}
                                        color={PRIORITY_COLORS[p].badge as TaskColor}
                                        isSelected={f.priorities.includes(p)}
                                        onChange={(on) => set("priorities", toggle(f.priorities, p, on))}
                                    />
                                ))}
                            </div>
                        </div>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <EnumSelect label="Due" value={f.due} options={DUE_FILTERS} labels={DUE_LABELS} onChange={(v) => set("due", v)} />
                            <EnumSelect
                                label="Deadline"
                                value={f.deadline}
                                options={DEADLINE_FILTERS}
                                labels={DEADLINE_LABELS}
                                onChange={(v) => set("deadline", v)}
                            />
                            <EnumSelect
                                label="Assigned"
                                value={f.assignee}
                                options={ASSIGNEE_FILTERS}
                                labels={ASSIGNEE_LABELS}
                                onChange={(v) => set("assignee", v)}
                            />
                            <EnumSelect label="Status" value={f.status} options={STATUS_FILTERS} labels={STATUS_LABELS} onChange={(v) => set("status", v)} />
                            <EnumSelect label="Projects" value={f.scope} options={SCOPE_FILTERS} labels={SCOPE_LABELS} onChange={(v) => set("scope", v)} />
                            <EnumSelect label="Sort by" value={f.sort} options={SORTS} labels={SORT_LABELS} onChange={(v) => set("sort", v)} />
                        </div>
                        {labelNames.length > 0 && (
                            <div className="flex flex-col gap-3">
                                <div className="flex items-center justify-between">
                                    <p className="text-sm font-semibold text-primary">Labels</p>
                                    <Select
                                        aria-label="Label match"
                                        size="sm"
                                        className="w-40"
                                        value={f.labelMode}
                                        onChange={(key) => key && set("labelMode", key as "any" | "all")}
                                        items={[
                                            { id: "any", label: "Any of these" },
                                            { id: "all", label: "All of these" },
                                        ]}
                                    >
                                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                    </Select>
                                </div>
                                <div className="flex flex-col items-start gap-3 pl-1">
                                    {labelNames.map((name) => (
                                        <CheckBadge
                                            key={name}
                                            label={name}
                                            color={labels.find((l) => l.name === name)?.color ?? "gray"}
                                            isSelected={f.labels.includes(name)}
                                            onChange={(on) => set("labels", toggle(f.labels, name, on))}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}
                        <div className="flex flex-col gap-3">
                            <p className="text-sm font-semibold text-primary">Only these projects</p>
                            <div className="flex flex-col items-start gap-3 pl-1">
                                {projects.map((p) => (
                                    <CheckBadge
                                        key={p.id}
                                        label={p.name}
                                        color={p.color}
                                        isSelected={f.projectIds.includes(p.id)}
                                        onChange={(on) => {
                                            set("projectIds", toggle(f.projectIds, p.id, on));
                                            // A section only means something while its project is chosen.
                                            if (!on)
                                                set(
                                                    "sectionIds",
                                                    f.sectionIds.filter((id) => !sections(p.id).some((x) => x.id === id)),
                                                );
                                        }}
                                    />
                                ))}
                            </div>
                        </div>
                        {f.projectIds.some((id) => sections(id).length) && (
                            <div className="flex flex-col gap-3">
                                <p className="text-sm font-semibold text-primary">Only these sections</p>
                                <div className="flex flex-col items-start gap-3 pl-1">
                                    {f.projectIds.flatMap((id) =>
                                        sections(id).map((section) => (
                                            <CheckBadge
                                                key={section.id}
                                                label={`${projects.find((p) => p.id === id)?.name ?? ""} / ${section.name}`}
                                                color="gray"
                                                isSelected={f.sectionIds.includes(section.id)}
                                                onChange={(on) => set("sectionIds", toggle(f.sectionIds, section.id, on))}
                                            />
                                        )),
                                    )}
                                </div>
                            </div>
                        )}
                    </SlideoutMenu.Content>
                    <SlideoutMenu.Footer className="flex w-full items-center justify-end gap-3">
                        <Button size="sm" color="link-color" className="mr-auto" onClick={() => setF({ ...initial, ...filterToDefaults() })}>
                            Clear all
                        </Button>
                        <Button size="sm" color="secondary" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button size="sm" onClick={() => window.location.assign(href(f))}>
                            Apply
                        </Button>
                    </SlideoutMenu.Footer>
                </Dialog>
            </Modal>
        </ModalOverlay>
    );
};

const filterToDefaults = (): TaskFilter => ({
    projectIds: [],
    sectionIds: [],
    labels: [],
    labelMode: "any",
    priorities: [],
    due: "any",
    deadline: "any",
    assignee: "anyone",
    status: "open",
    scope: "all",
    text: "",
    sort: "due",
});

const FiltersBody = ({ data }: { data: PageData<"tasks-filters"> }) => {
    const { project, shell } = useTasks();
    const toast = useToast();
    const actions = useTaskActions();
    const [builder, setBuilder] = useState(false);
    const [saveOpen, setSaveOpen] = useState(false);
    const [name, setName] = useState(data.savedView?.name ?? "");
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [hasMore, setHasMore] = useState(data.hasMore);
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const params = filterToParams(data.filter);
    const { tasks, setTasks } = useLiveList(data.tasks, async () => (await tasksApi.filter(new URLSearchParams([...params, ["limit", String(PAGE)]]))).tasks, {
        keepCompleted: data.filter.status !== "open",
    });
    const summary = describeFilter(data.filter, (id) => project(id)?.name);
    const titles = Object.fromEntries(tasks.map((t) => [t.id, t.title]));

    return (
        <>
            <TasksHeader
                title={data.savedView?.name ?? "Filters"}
                description={summary}
                crumb={{ label: "Filters", href: "/portal/tasks/filters" }}
                actions={
                    <>
                        <Button size="sm" color="secondary" iconLeading={FilterLines} onClick={() => setBuilder(true)}>
                            Edit filter
                        </Button>
                        <Button size="sm" color="secondary" iconLeading={Bookmark} onClick={() => setSaveOpen(true)}>
                            {data.savedView ? "Rename" : "Save"}
                        </Button>
                        {data.savedView && (
                            <Button
                                size="sm"
                                color="tertiary-destructive"
                                iconLeading={Trash01}
                                onClick={() => setConfirmDelete(true)}
                                aria-label="Delete this saved filter"
                            />
                        )}
                        <Button size="sm" color={selecting ? "primary" : "secondary"} onClick={() => (setSelecting(!selecting), setSelected(new Set()))}>
                            {selecting ? "Done selecting" : "Select"}
                        </Button>
                    </>
                }
            />
            {shell.views.length > 0 && (
                <nav aria-label="Saved filters" className="flex flex-wrap gap-2">
                    {shell.views.map((v) => (
                        <a
                            key={v.id}
                            href={`/portal/tasks/filters?saved=${v.id}`}
                            className={cx("rounded-full outline-focus-ring focus-visible:outline-2")}
                            aria-current={data.savedView?.id === v.id ? "page" : undefined}
                        >
                            <Badge size="md" type="pill-color" color={data.savedView?.id === v.id ? "brand" : "gray"}>
                                {v.name}
                            </Badge>
                        </a>
                    ))}
                </nav>
            )}
            <TaskList
                aria-label="Matching tasks"
                tasks={tasks}
                actions={actions}
                showProject
                parentTitles={titles}
                selection={selecting ? { selected, onChange: setSelected } : null}
                empty={<Empty icon={FilterLines} title="No matching tasks" description="Try fewer conditions, or include completed tasks." size="sm" />}
            />
            {hasMore && (
                <Button
                    size="sm"
                    color="secondary"
                    className="self-start"
                    onClick={async () => {
                        try {
                            const more = await tasksApi.filter(new URLSearchParams([...params, ["offset", String(tasks.length)], ["limit", String(PAGE)]]));
                            setTasks([...tasks, ...more.tasks]);
                            setHasMore(more.hasMore);
                        } catch (error) {
                            toast.error("Couldn't load more", errorMessage(error));
                        }
                    }}
                >
                    Load more
                </Button>
            )}
            {selecting && <BulkBar selected={selected} onClear={() => setSelected(new Set())} />}
            {builder && <FilterBuilder initial={data.filter} isOpen onOpenChange={setBuilder} />}
            <PortalDialog
                isOpen={saveOpen}
                onOpenChange={setSaveOpen}
                title={data.savedView ? "Rename filter" : "Save this filter"}
                icon={data.savedView ? Edit05 : Bookmark}
                description={summary}
                onSubmit={async () => {
                    try {
                        const view = data.savedView
                            ? (await tasksApi.updateView(data.savedView.id, data.savedView.version, { name })).view
                            : (await tasksApi.createView(name, data.filter)).view;
                        setSaveOpen(false);
                        window.setTimeout(() => window.location.assign(`/portal/tasks/filters?saved=${view.id}`), 250);
                    } catch (error) {
                        toast.error("Couldn't save the filter", errorMessage(error));
                    }
                }}
                footer={
                    <Button type="submit" size="md" isDisabled={!name.trim()}>
                        Save
                    </Button>
                }
            >
                <Input label="Name" value={name} onChange={setName} autoFocus placeholder="e.g. Errands this week" />
            </PortalDialog>
            <ConfirmDialog
                isOpen={confirmDelete}
                onOpenChange={setConfirmDelete}
                title={`Delete “${data.savedView?.name ?? ""}”?`}
                description="Only the saved filter is deleted. No tasks change."
                confirmLabel="Delete filter"
                destructive
                onConfirm={async () => {
                    if (!data.savedView) return;
                    await tasksApi.deleteView(data.savedView.id);
                    window.location.assign("/portal/tasks/filters");
                }}
            />
            {actions.dialogs}
        </>
    );
};
