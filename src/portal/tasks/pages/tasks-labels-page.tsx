// Labels: your own list (create, rename, recolour, delete) with how many open tasks carry each, and
// the labels other people have put on shared tasks you can see.
import { useEffect, useState } from "react";
import { Edit05, Plus, Tag01, Trash01 } from "@untitledui/icons";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { Empty } from "@/portal/components/empty";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { COLORS, COLOR_LABELS, type TaskColor, type TaskLabel } from "@/shared/tasks/types";
import { tasksApi } from "../api";
import { ProjectDot } from "../shared";
import { useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";

export const TasksLabelsPage = ({ data }: { data: PageData<"tasks-labels"> }) => (
    <TasksLayout shell={data}>
        <LabelsBody />
    </TasksLayout>
);

const LabelDialog = ({ label, onClose, onSaved }: { label: TaskLabel | null; onClose: () => void; onSaved: (labels: TaskLabel[]) => void }) => {
    const toast = useToast();
    const [name, setName] = useState(label?.name ?? "");
    const [color, setColor] = useState<TaskColor>(label?.color ?? "gray");
    return (
        <PortalDialog
            isOpen
            onOpenChange={(open) => !open && onClose()}
            title={label ? "Edit label" : "New label"}
            icon={Tag01}
            description={label ? "Renaming changes it on every task you can edit." : undefined}
            onSubmit={async () => {
                try {
                    const result = label ? await tasksApi.updateLabel(label.id, { name, color }) : await tasksApi.createLabel(name, color);
                    onSaved(result.labels);
                    onClose();
                } catch (error) {
                    toast.error("Couldn't save the label", errorMessage(error));
                }
            }}
            footer={
                <>
                    <Button color="secondary" size="md" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" size="md" isDisabled={!name.trim()}>
                        Save
                    </Button>
                </>
            }
        >
            <Input label="Name" value={name} onChange={setName} autoFocus placeholder="e.g. errands" />
            <Select
                label="Colour"
                size="sm"
                value={color}
                onChange={(key) => key && setColor(key as TaskColor)}
                items={COLORS.map((c) => ({ id: c, label: COLOR_LABELS[c], icon: <ProjectDot color={c} className="mx-1" /> }))}
            >
                {(item) => (
                    <Select.Item id={item.id} icon={item.icon}>
                        {item.label}
                    </Select.Item>
                )}
            </Select>
        </PortalDialog>
    );
};

const LabelsBody = () => {
    const { labels, setLabels } = useTasks();
    const toast = useToast();
    const [editing, setEditing] = useState<TaskLabel | "new" | null>(null);
    const [deleting, setDeleting] = useState<TaskLabel | null>(null);
    const [others, setOthers] = useState<string[]>([]);
    useEffect(() => {
        tasksApi.labels().then(
            (r) => (setLabels(r.labels), setOthers(r.others)),
            () => undefined,
        );
    }, [setLabels]);

    return (
        <>
            <TasksHeader
                title="Labels"
                description="Tag tasks across projects (@errands, @waiting, @phone) and filter by them. Your list is your own; labels on shared tasks are seen by everyone in that project."
                crumb={{ label: "Labels" }}
                actions={
                    <Button size="sm" color="secondary" iconLeading={Plus} onClick={() => setEditing("new")}>
                        New label
                    </Button>
                }
            />
            {labels.length === 0 ? (
                <Empty
                    icon={Tag01}
                    title="No labels yet"
                    description="Create one here, or type @name when adding a task."
                    size="sm"
                    actions={<Button onClick={() => setEditing("new")}>New label</Button>}
                />
            ) : (
                <ul className="divide-y divide-secondary rounded-xl ring-1 ring-secondary ring-inset">
                    {labels.map((label) => (
                        <li key={label.id} className="flex items-center gap-3 px-4 py-3">
                            <a
                                href={`/portal/tasks/filters?labels=${encodeURIComponent(label.name)}`}
                                className="rounded-full outline-focus-ring focus-visible:outline-2"
                            >
                                <Badge size="md" type="pill-color" color={label.color}>
                                    {label.name}
                                </Badge>
                            </a>
                            <span className="flex-1 text-sm text-tertiary">
                                {label.openCount} open task{label.openCount === 1 ? "" : "s"}
                            </span>
                            <ButtonUtility size="xs" color="tertiary" icon={Edit05} tooltip={`Edit “${label.name}”`} onClick={() => setEditing(label)} />
                            <ButtonUtility size="xs" color="tertiary" icon={Trash01} tooltip={`Delete “${label.name}”`} onClick={() => setDeleting(label)} />
                        </li>
                    ))}
                </ul>
            )}
            {others.length > 0 && (
                <section aria-label="Labels from shared projects" className="flex flex-col gap-3">
                    <h2 className="text-md font-semibold text-primary">On shared tasks</h2>
                    <p className="text-sm text-tertiary">Labels other people have added to tasks you can see.</p>
                    <div className="flex flex-wrap gap-2">
                        {others.map((name) => (
                            <a
                                key={name}
                                href={`/portal/tasks/filters?labels=${encodeURIComponent(name)}`}
                                className="rounded-full outline-focus-ring focus-visible:outline-2"
                            >
                                <Badge size="md" type="pill-color" color="gray">
                                    {name}
                                </Badge>
                            </a>
                        ))}
                    </div>
                </section>
            )}
            {editing && <LabelDialog label={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={setLabels} />}
            <ConfirmDialog
                isOpen={!!deleting}
                onOpenChange={(open) => !open && setDeleting(null)}
                title={`Delete “${deleting?.name ?? ""}”?`}
                description="It's removed from your list and from every task you can edit. The tasks themselves aren't touched."
                confirmLabel="Delete label"
                destructive
                onConfirm={async () => {
                    if (!deleting) return;
                    try {
                        setLabels((await tasksApi.deleteLabel(deleting.id)).labels);
                    } catch (error) {
                        toast.error("Couldn't delete it", errorMessage(error));
                    }
                }}
            />
        </>
    );
};
