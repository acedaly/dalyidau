// Templates: tasks with a checklist that come round again (packing, a service, the monthly
// finances). Each makes an ordinary, independent task and subtasks when used. Private to you
// unless shared with a shared project's members. The checklist is edited as text, one item per
// line, indented for sub-items, which works the same with a keyboard and on a phone.
import { useState } from "react";
import { Archive, Copy06, Edit03, File06, Plus, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { describeRule, recurrenceInput, withAnchor } from "@/shared/tasks/recurrence";
import { type ChecklistItem, type TaskTemplate, type TemplateInput, countItems } from "@/shared/tasks/templates";
import { PRIORITY_LABELS, type Priority, roleAtLeast } from "@/shared/tasks/types";
import { tasksApi } from "../api";
import { LabelPicker, PriorityPicker, ProjectPicker } from "../pickers";
import { RecurrenceEditor } from "../recurrence-editor";
import { useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";

export const TasksTemplatesPage = ({ data }: { data: PageData<"tasks-templates"> }) => (
    <TasksLayout shell={data}>
        <TemplatesBody data={data} />
    </TasksLayout>
);

/** "Clothes\n  Swimmers\nChargers" → a checklist. Two spaces (or a tab) per level. */
export const parseChecklist = (text: string): ChecklistItem[] => {
    const root: ChecklistItem[] = [];
    const stack: { depth: number; items: ChecklistItem[] }[] = [{ depth: -1, items: root }];
    for (const raw of text.split("\n")) {
        if (!raw.trim()) continue;
        const indent = raw.replace(/\t/g, "  ").match(/^ */)![0].length;
        const depth = Math.min(Math.floor(indent / 2), 2);
        const title = raw.trim().replace(/^[-*•]\s*/, "");
        if (!title) continue;
        while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
        const parent = stack[stack.length - 1];
        const item: ChecklistItem = { title };
        parent.items.push(item);
        item.children = [];
        stack.push({ depth, items: item.children });
    }
    const tidy = (items: ChecklistItem[]): ChecklistItem[] =>
        items.map((i) => (i.children?.length ? { title: i.title, children: tidy(i.children) } : { title: i.title }));
    return tidy(root);
};
export const checklistText = (items: ChecklistItem[], depth = 0): string =>
    items.map((i) => `${"  ".repeat(depth)}${i.title}${i.children?.length ? `\n${checklistText(i.children, depth + 1)}` : ""}`).join("\n");

const TemplatesBody = ({ data }: { data: PageData<"tasks-templates"> }) => {
    const { project, openTask, today } = useTasks();
    const toast = useToast();
    const [templates, setTemplates] = useState(data.templates);
    const [archived, setArchived] = useState(data.archived);
    const [editing, setEditing] = useState<TaskTemplate | "new" | null>(null);
    const [using, setUsing] = useState<TaskTemplate | null>(null);
    const [deleting, setDeleting] = useState<TaskTemplate | null>(null);
    const reload = async () => {
        const [a, b] = await Promise.all([tasksApi.templates(), tasksApi.templates(true)]);
        setTemplates(a.templates);
        setArchived(b.templates);
    };
    const act = async (run: () => Promise<unknown>, done: string) => {
        try {
            await run();
            toast.success(done);
            await reload();
        } catch (error) {
            toast.error("Couldn't do that", errorMessage(error));
        }
    };

    const Row = ({ t }: { t: TaskTemplate }) => {
        const shared = t.sharedProjectId ? project(t.sharedProjectId) : null;
        return (
            <li className="flex flex-col gap-3 border-b border-secondary py-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-primary">{t.name}</p>
                    <p className="text-sm text-tertiary">
                        {t.title} · {countItems(t.subtasks)} checklist item{countItems(t.subtasks) === 1 ? "" : "s"}
                        {t.priority < 4 ? ` · ${PRIORITY_LABELS[t.priority].short}` : ""}
                        {t.dueOffsetDays !== null
                            ? ` · due ${t.dueOffsetDays === 0 ? "the same day" : `${t.dueOffsetDays} day${t.dueOffsetDays === 1 ? "" : "s"} later`}`
                            : ""}
                        {t.recurrence
                            ? (() => {
                                  const r = recurrenceInput.safeParse(t.recurrence);
                                  return r.success ? ` · ${describeRule(withAnchor(r.data, today))}` : "";
                              })()
                            : ""}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                        {shared ? (
                            <Badge size="sm" type="color" color="blue">
                                Shared with {shared.name}
                            </Badge>
                        ) : (
                            <Badge size="sm" type="color" color="gray">
                                Only you
                            </Badge>
                        )}
                        {t.labels.map((l) => (
                            <Badge key={l} size="sm" type="color" color="brand">
                                @{l}
                            </Badge>
                        ))}
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    {!t.archived && (
                        <Button size="sm" iconLeading={Plus} onClick={() => setUsing(t)}>
                            Use
                        </Button>
                    )}
                    {t.canEdit && !t.archived && (
                        <Button size="sm" color="secondary" iconLeading={Edit03} onClick={() => setEditing(t)}>
                            Edit
                        </Button>
                    )}
                    <Button
                        size="sm"
                        color="secondary"
                        iconLeading={Copy06}
                        onClick={() => void act(() => tasksApi.duplicateTemplate(t.id), "Template copied")}
                    >
                        Copy
                    </Button>
                    {t.canEdit && (
                        <Button
                            size="sm"
                            color="tertiary"
                            iconLeading={Archive}
                            onClick={() =>
                                void act(() => tasksApi.updateTemplate(t.id, t.version, { archived: !t.archived }), t.archived ? "Restored" : "Archived")
                            }
                        >
                            {t.archived ? "Restore" : "Archive"}
                        </Button>
                    )}
                    {t.canEdit && (
                        <Button size="sm" color="tertiary-destructive" iconLeading={Trash01} onClick={() => setDeleting(t)} aria-label={`Delete ${t.name}`}>
                            <span className="max-sm:sr-only">Delete</span>
                        </Button>
                    )}
                </div>
            </li>
        );
    };

    return (
        <>
            <TasksHeader
                title="Templates"
                description="Tasks with a checklist you use again and again. Using one makes an ordinary task you can change freely."
                crumb={{ label: "Templates" }}
                actions={
                    <Button size="sm" color="secondary" iconLeading={Plus} onClick={() => setEditing("new")}>
                        New template
                    </Button>
                }
            />
            {templates.length === 0 ? (
                <div className="rounded-xl py-8 ring-1 ring-secondary ring-inset">
                    <Empty
                        icon={File06}
                        title="No templates yet"
                        description="Make one here, or open a task and choose Save as template. Its subtasks become the checklist."
                        size="sm"
                    />
                </div>
            ) : (
                <ul aria-label="Templates">
                    {templates.map((t) => (
                        <Row key={t.id} t={t} />
                    ))}
                </ul>
            )}
            {archived.length > 0 && (
                <details>
                    <summary className="cursor-pointer text-sm font-semibold text-secondary">Archived ({archived.length})</summary>
                    <ul aria-label="Archived templates">
                        {archived.map((t) => (
                            <Row key={t.id} t={t} />
                        ))}
                    </ul>
                </details>
            )}
            {editing && <TemplateEditor template={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
            {using && (
                <UseTemplate
                    template={using}
                    onClose={() => setUsing(null)}
                    onUsed={(taskId) => {
                        setUsing(null);
                        toast.show({
                            title: "Task created",
                            description: using.title,
                            color: "success",
                            action: { label: "Open", run: () => openTask(taskId) },
                        });
                    }}
                />
            )}
            <ConfirmDialog
                isOpen={!!deleting}
                onOpenChange={(open) => !open && setDeleting(null)}
                title="Delete this template?"
                description={`“${deleting?.name ?? ""}” is deleted. Tasks already made from it aren't affected. To keep it out of the way instead, archive it.`}
                confirmLabel="Delete template"
                destructive
                onConfirm={async () => {
                    if (deleting) await act(() => tasksApi.deleteTemplate(deleting.id), "Template deleted");
                }}
            />
        </>
    );
};

const TemplateEditor = ({ template, onClose, onSaved }: { template: TaskTemplate | null; onClose: () => void; onSaved: () => void }) => {
    const { projects, today } = useTasks();
    const toast = useToast();
    const [f, setF] = useState<TemplateInput>(() => ({
        name: template?.name ?? "",
        title: template?.title ?? "",
        description: template?.description ?? "",
        priority: template?.priority ?? 4,
        defaultProjectId: template?.defaultProjectId ?? null,
        sharedProjectId: template?.sharedProjectId ?? null,
        labels: template?.labels ?? [],
        dueOffsetDays: template?.dueOffsetDays ?? null,
        dueTime: template?.dueTime ?? null,
        recurrence: template?.recurrence ?? null,
        subtasks: template?.subtasks ?? [],
    }));
    const [checklist, setChecklist] = useState(checklistText(template?.subtasks ?? []));
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const shareable = projects.filter((p) => p.kind === "shared" && roleAtLeast(p.role, "editor") && p.status !== "archived");
    const set = <K extends keyof TemplateInput>(key: K, value: TemplateInput[K]) => setF((x) => ({ ...x, [key]: value }));
    const save = async () => {
        setBusy(true);
        setError(null);
        const body = { ...f, subtasks: parseChecklist(checklist) };
        try {
            if (template) await tasksApi.updateTemplate(template.id, template.version, { template: body });
            else await tasksApi.createTemplate(body);
            toast.success(template ? "Template saved" : "Template created");
            onSaved();
            onClose();
        } catch (e) {
            setError(e instanceof ApiError && e.issues.length ? e.issues.map((i) => i.message).join(" ") : errorMessage(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title={template ? "Edit template" : "New template"}
            icon={File06}
            size="lg"
            onSubmit={() => void save()}
            footer={
                <>
                    <Button color="secondary" size="md" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" size="md" isLoading={busy} showTextWhileLoading isDisabled={!f.name.trim() || !f.title?.trim()}>
                        Save template
                    </Button>
                </>
            }
        >
            {error && <p className="text-sm text-error-primary">{error}</p>}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input label="Template name" placeholder="e.g. Holiday packing" value={f.name} onChange={(v) => set("name", v)} isRequired autoFocus />
                <Input label="Task title" placeholder="e.g. Pack for the trip" value={f.title} onChange={(v) => set("title", v)} isRequired />
            </div>
            <TextArea label="Description" rows={2} value={f.description ?? ""} onChange={(v) => set("description", v)} />
            <TextArea
                label="Checklist"
                rows={6}
                placeholder={"Clothes\n  Swimmers\n  Hats\nChargers"}
                hint="One item per line. Indent with two spaces for a sub-item (up to three levels)."
                value={checklist}
                onChange={setChecklist}
            />
            <div className="flex flex-wrap items-center gap-2">
                <PriorityPicker value={(f.priority ?? 4) as Priority} onChange={(p) => set("priority", p)} />
                <LabelPicker value={f.labels ?? []} onChange={(labels) => set("labels", labels)} />
                <ProjectPicker label="Goes to" value={f.defaultProjectId ?? ""} onChange={(id) => set("defaultProjectId", id || null)} />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Select
                    label="Due"
                    size="sm"
                    value={f.dueOffsetDays === null || f.dueOffsetDays === undefined ? "none" : String(f.dueOffsetDays)}
                    onChange={(key) => {
                        const value = key === "none" ? null : Number(key);
                        setF((x) => ({ ...x, dueOffsetDays: value, ...(value === null ? { dueTime: null, recurrence: null } : {}) }));
                    }}
                    items={[
                        { id: "none", label: "No date" },
                        { id: "0", label: "The day it's used" },
                        { id: "1", label: "The next day" },
                        { id: "7", label: "A week later" },
                        { id: "14", label: "Two weeks later" },
                        { id: "30", label: "30 days later" },
                    ]}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                {f.dueOffsetDays !== null && f.dueOffsetDays !== undefined && (
                    <Input label="Time" type="time" size="sm" value={f.dueTime ?? ""} onChange={(v) => set("dueTime", v || null)} />
                )}
                <Select
                    label="Who can use it"
                    size="sm"
                    value={f.sharedProjectId ?? "private"}
                    onChange={(key) => set("sharedProjectId", key === "private" ? null : String(key))}
                    items={[{ id: "private", label: "Only me" }, ...shareable.map((p) => ({ id: p.id, label: `Everyone in ${p.name}` }))]}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
            </div>
            {f.dueOffsetDays !== null && f.dueOffsetDays !== undefined && (
                <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium text-secondary">Repeats</span>
                    <RecurrenceEditor
                        rule={(() => {
                            const r = f.recurrence ? recurrenceInput.safeParse(f.recurrence) : null;
                            return r?.success ? withAnchor(r.data, today) : null;
                        })()}
                        anchor={today}
                        onChange={(recurrence) => set("recurrence", recurrence)}
                    />
                </div>
            )}
            <div className="h-1" />
        </PortalDialog>
    );
};

const UseTemplate = ({ template, onClose, onUsed }: { template: TaskTemplate; onClose: () => void; onUsed: (taskId: string) => void }) => {
    const { shell, writable, emit } = useTasks();
    const toast = useToast();
    const initial = template.defaultProjectId && writable.some((p) => p.id === template.defaultProjectId) ? template.defaultProjectId : shell.inboxId;
    const [projectId, setProjectId] = useState(initial);
    const [busy, setBusy] = useState(false);
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title={`Use “${template.name}”`}
            description={`Creates “${template.title}” with ${countItems(template.subtasks)} checklist item${countItems(template.subtasks) === 1 ? "" : "s"}.`}
            onSubmit={async () => {
                setBusy(true);
                try {
                    const { task } = await tasksApi.useTemplate(template.id, { projectId });
                    emit({ type: "created", task });
                    onUsed(task.id);
                } catch (error) {
                    toast.error("Couldn't create the task", errorMessage(error));
                } finally {
                    setBusy(false);
                }
            }}
            footer={
                <Button type="submit" size="md" isLoading={busy} showTextWhileLoading>
                    Create task
                </Button>
            }
        >
            <ProjectPicker label="Project" value={projectId} onChange={setProjectId} />
        </PortalDialog>
    );
};
