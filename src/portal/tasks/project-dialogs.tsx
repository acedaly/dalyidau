// Project dialogs, laid out like Untitled UI PRO's "new project" and "share with people" modals:
// create or edit a project (name, description, colour, dates, status, default view) and manage who
// it's shared with. Members can only be people who can already open Tasks in the portal.
import { useState } from "react";
import { FolderPlus, Lock01, Trash01, UsersPlus } from "@untitledui/icons";
import { AvatarLabelGroup } from "@/components/base/avatar/avatar-label-group";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { RadioButton, RadioGroup } from "@/components/base/radio-buttons/radio-buttons";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { ConfirmDialog, PortalDialog } from "@/portal/components/dialog";
import { useToast } from "@/portal/components/toast";
import { ApiError, errorMessage } from "@/portal/lib/api";
import { initials } from "@/portal/lib/format";
import { usePortal } from "@/portal/portal-context";
import {
    COLORS,
    COLOR_LABELS,
    PROJECT_ROLES,
    PROJECT_STATUSES,
    PROJECT_STATUS_LABELS,
    type ProjectRole,
    type TaskColor,
    type TaskMember,
    type TaskProject,
} from "@/shared/tasks/types";
import { projectHref, tasksApi } from "./api";
import { DateMenu } from "./pickers";
import { ProjectDot } from "./shared";
import { useTasks } from "./tasks-context";

const ROLE_TEXT: Record<ProjectRole, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };
const ROLE_HINT: Record<ProjectRole, string> = {
    owner: "Everything, including members, sharing and deleting",
    editor: "Add, change and complete tasks and sections",
    viewer: "Read only; can't be assigned tasks",
};

const ColorSelect = ({ value, onChange }: { value: TaskColor; onChange: (c: TaskColor) => void }) => (
    <Select
        label="Colour"
        size="sm"
        value={value}
        onChange={(key) => key && onChange(key as TaskColor)}
        items={COLORS.map((c) => ({ id: c, label: COLOR_LABELS[c], icon: <ProjectDot color={c} className="mx-1" /> }))}
    >
        {(item) => (
            <Select.Item id={item.id} icon={item.icon}>
                {item.label}
            </Select.Item>
        )}
    </Select>
);

/** New project. Optional starter sections, one per line. */
export const NewProjectDialog = ({
    isOpen,
    onOpenChange,
    kind = "personal",
}: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    kind?: "personal" | "shared";
}) => {
    const toast = useToast();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [color, setColor] = useState<TaskColor>("brand");
    const [shared, setShared] = useState(kind);
    const [sections, setSections] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title="New project"
            icon={FolderPlus}
            description="Group related tasks, split them into sections and, if you like, share them."
            onSubmit={async () => {
                if (!name.trim()) return setError("Give the project a name");
                setBusy(true);
                try {
                    const { project } = await tasksApi.createProject({
                        name,
                        description,
                        color,
                        kind: shared,
                        sections: sections
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean),
                    });
                    window.location.assign(projectHref(project.id));
                } catch (e) {
                    setError(e instanceof ApiError ? e.message : errorMessage(e));
                    toast.error("Couldn't create the project", errorMessage(e));
                } finally {
                    setBusy(false);
                }
            }}
            footer={
                <>
                    <Button color="secondary" size="md" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button type="submit" size="md" isLoading={busy} showTextWhileLoading>
                        Create project
                    </Button>
                </>
            }
        >
            <Input
                label="Name"
                isRequired
                value={name}
                onChange={setName}
                autoFocus
                isInvalid={!!error}
                hint={error ?? undefined}
                placeholder="e.g. Home renovation"
            />
            <TextArea label="Description" rows={2} value={description} onChange={setDescription} />
            <ColorSelect value={color} onChange={setColor} />
            <RadioGroup aria-label="Who can see it" value={shared} onChange={(v) => setShared(v as "personal" | "shared")}>
                <RadioButton value="personal" label="Personal" hint="Only you. You can share it later." />
                <RadioButton value="shared" label="Shared" hint="Add people after it's created." />
            </RadioGroup>
            <TextArea
                label="Sections"
                hint="Optional, one per line"
                rows={3}
                value={sections}
                onChange={setSections}
                placeholder={"Venue\nCatering\nTransport"}
            />
        </PortalDialog>
    );
};

export const EditProjectDialog = ({
    project,
    isOpen,
    onOpenChange,
    onSaved,
}: {
    project: TaskProject;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: (p: TaskProject) => void;
}) => {
    const toast = useToast();
    const [name, setName] = useState(project.name);
    const [description, setDescription] = useState(project.description);
    const [color, setColor] = useState<TaskColor>(project.color);
    const [startDate, setStartDate] = useState(project.startDate);
    const [targetDate, setTargetDate] = useState(project.targetDate);
    const [status, setStatus] = useState(project.status);
    const [defaultView, setDefaultView] = useState(project.defaultView);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const isOwner = project.role === "owner";
    return (
        <>
            <PortalDialog
                isOpen={isOpen}
                onOpenChange={onOpenChange}
                title="Project settings"
                icon={FolderPlus}
                onSubmit={async () => {
                    try {
                        const { project: saved } = await tasksApi.updateProject(project.id, project.version, {
                            ...(project.isInbox ? {} : { name }),
                            description,
                            color,
                            startDate,
                            targetDate,
                            defaultView,
                            ...(isOwner && !project.isInbox && status !== project.status ? { status } : {}),
                        });
                        onSaved(saved);
                        onOpenChange(false);
                    } catch (e) {
                        toast.error("Couldn't save the project", errorMessage(e));
                    }
                }}
                footer={
                    <>
                        {isOwner && !project.isInbox && (
                            <Button color="tertiary-destructive" size="md" iconLeading={Trash01} className="sm:mr-auto" onClick={() => setConfirmDelete(true)}>
                                Delete project
                            </Button>
                        )}
                        <Button color="secondary" size="md" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" size="md">
                            Save
                        </Button>
                    </>
                }
            >
                <Input label="Name" value={name} onChange={setName} isDisabled={project.isInbox} />
                <TextArea label="Description" rows={2} value={description} onChange={setDescription} />
                <ColorSelect value={color} onChange={setColor} />
                <div className="flex flex-wrap gap-6">
                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium text-secondary">Start</span>
                        <DateMenu label="Start date" value={startDate} onChange={setStartDate} placeholder="No start date" clearLabel="No start date" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm font-medium text-secondary">Target</span>
                        <DateMenu label="Target completion date" value={targetDate} onChange={setTargetDate} placeholder="No target" clearLabel="No target" />
                    </div>
                </div>
                {isOwner && !project.isInbox && (
                    <Select
                        label="Status"
                        size="sm"
                        value={status}
                        onChange={(key) => key && setStatus(key as TaskProject["status"])}
                        items={PROJECT_STATUSES.map((s) => ({ id: s, label: PROJECT_STATUS_LABELS[s] }))}
                        hint="Archived projects are read-only and hidden from everyday lists."
                    >
                        {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                    </Select>
                )}
                <Select
                    label="Opens as"
                    size="sm"
                    value={defaultView}
                    onChange={(key) => key && setDefaultView(key as "list" | "board")}
                    items={[
                        { id: "list", label: "List" },
                        { id: "board", label: "Board" },
                    ]}
                >
                    {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                </Select>
                <div className="h-2" />
            </PortalDialog>
            <ConfirmDialog
                isOpen={confirmDelete}
                onOpenChange={setConfirmDelete}
                title={`Delete “${project.name}”?`}
                description={`Its ${project.counts.open + project.counts.completed} tasks, their subtasks, comments and history are deleted for everyone. This can't be undone. To keep it, archive it instead.`}
                confirmLabel="Delete project"
                destructive
                onConfirm={async () => {
                    try {
                        await tasksApi.deleteProject(project.id);
                        window.location.assign("/portal/tasks/projects");
                    } catch (e) {
                        toast.error("Couldn't delete it", errorMessage(e));
                    }
                }}
            />
        </>
    );
};

/** Share a project and manage its members. Owners change things; everyone can see who's in it and leave. */
export const MembersDialog = ({
    project,
    members,
    isOpen,
    onOpenChange,
    onChange,
}: {
    project: TaskProject;
    members: TaskMember[];
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onChange: (members: TaskMember[], project?: TaskProject) => void;
}) => {
    const { user } = usePortal();
    const { setProjects, projects } = useTasks();
    const toast = useToast();
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<ProjectRole>("editor");
    const [error, setError] = useState<string | null>(null);
    const isOwner = project.role === "owner";
    const replaceProject = (next: TaskProject) => setProjects(projects.map((p) => (p.id === next.id ? next : p)));

    const run = async (work: () => Promise<void>) => {
        try {
            setError(null);
            await work();
        } catch (e) {
            setError(errorMessage(e));
        }
    };

    return (
        <PortalDialog
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title={project.kind === "shared" ? "Share with people" : "Sharing"}
            icon={UsersPlus}
            description={
                project.kind === "shared"
                    ? "These people can see this project and its tasks. Nothing else of yours is shared."
                    : "Only you can see this project."
            }
        >
            {project.kind === "personal" ? (
                <div className="flex flex-col gap-3 pb-6">
                    <p className="flex items-center gap-2 text-sm text-tertiary">
                        <Lock01 aria-hidden="true" className="size-4" /> Personal project
                    </p>
                    {isOwner && !project.isInbox && (
                        <Button
                            className="self-start"
                            onClick={() =>
                                run(async () => {
                                    const { project: next } = await tasksApi.setProjectKind(project.id, "shared");
                                    replaceProject(next);
                                    onChange(members, next);
                                })
                            }
                        >
                            Share this project
                        </Button>
                    )}
                </div>
            ) : (
                <div className="flex flex-col gap-4 pb-6">
                    <ul className="flex flex-col gap-3">
                        {members.map((m) => (
                            <li key={m.email} className="flex flex-wrap items-center gap-3">
                                <AvatarLabelGroup
                                    size="md"
                                    initials={initials(m.name ?? m.email.split("@")[0])}
                                    title={m.name ?? m.email.split("@")[0]}
                                    subtitle={m.email}
                                />
                                <div className="ml-auto flex items-center gap-2">
                                    {isOwner ? (
                                        <Select
                                            aria-label={`Role for ${m.email}`}
                                            size="sm"
                                            className="w-32"
                                            value={m.role}
                                            onChange={(key) =>
                                                key &&
                                                key !== m.role &&
                                                run(async () => onChange((await tasksApi.updateMember(project.id, m.email, key as ProjectRole)).members))
                                            }
                                            items={PROJECT_ROLES.map((r) => ({ id: r, label: ROLE_TEXT[r], supportingText: undefined }))}
                                        >
                                            {(item) => <Select.Item id={item.id}>{item.label}</Select.Item>}
                                        </Select>
                                    ) : (
                                        <span className="text-sm text-tertiary">{ROLE_TEXT[m.role]}</span>
                                    )}
                                    {(isOwner || m.email === user.email) && (
                                        <Button
                                            size="sm"
                                            color="link-destructive"
                                            onClick={() =>
                                                run(async () => {
                                                    const result = await tasksApi.removeMember(project.id, m.email);
                                                    if (m.email === user.email) window.location.assign("/portal/tasks/projects?kind=shared");
                                                    else onChange(result.members ?? []);
                                                })
                                            }
                                        >
                                            {m.email === user.email ? "Leave" : "Remove"}
                                        </Button>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                    {isOwner && (
                        <form
                            className="flex flex-col gap-3 border-t border-secondary pt-4"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void run(async () => {
                                    onChange((await tasksApi.addMember(project.id, email.trim(), role)).members);
                                    setEmail("");
                                    toast.success("Added", "They can see this project now.");
                                });
                            }}
                        >
                            <Input
                                label="Add someone by email"
                                type="email"
                                value={email}
                                onChange={setEmail}
                                placeholder="name@example.com"
                                hint="They must already be able to open Tasks in the portal."
                            />
                            <Select
                                label="Role"
                                size="sm"
                                value={role}
                                onChange={(key) => key && setRole(key as ProjectRole)}
                                items={PROJECT_ROLES.map((r) => ({ id: r, label: ROLE_TEXT[r], supportingText: ROLE_HINT[r] }))}
                            >
                                {(item) => (
                                    <Select.Item id={item.id} supportingText={item.supportingText}>
                                        {item.label}
                                    </Select.Item>
                                )}
                            </Select>
                            <Button type="submit" className="self-start" isDisabled={!email.trim()}>
                                Add member
                            </Button>
                        </form>
                    )}
                    {isOwner && members.length === 1 && (
                        <Button
                            size="sm"
                            color="link-gray"
                            className="self-start"
                            onClick={() =>
                                run(async () => {
                                    const { project: next } = await tasksApi.setProjectKind(project.id, "personal");
                                    replaceProject(next);
                                    onChange(members, next);
                                })
                            }
                        >
                            Make it personal again
                        </Button>
                    )}
                </div>
            )}
            {error && (
                <p role="alert" className="pb-4 text-sm text-error-primary">
                    {error}
                </p>
            )}
        </PortalDialog>
    );
};
