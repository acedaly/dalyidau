// My projects and Shared projects: cards with progress, reorderable in your own sidebar order, plus
// projects on hold, completed and archived (still there, out of the way).
import { useState } from "react";
import { ArrowDown, ArrowUp, FolderPlus, Users03 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { ProgressBar } from "@/components/base/progress-indicators/progress-indicators";
import { Empty } from "@/portal/components/empty";
import { useToast } from "@/portal/components/toast";
import { errorMessage } from "@/portal/lib/api";
import type { PageData } from "@/portal/lib/page-types";
import { shortDate } from "@/shared/tasks/dates";
import { PROJECT_STATUS_LABELS, type TaskProject } from "@/shared/tasks/types";
import { projectHref, tasksApi } from "../api";
import { NewProjectDialog } from "../project-dialogs";
import { ProjectDot } from "../shared";
import { useTasks } from "../tasks-context";
import { TasksHeader, TasksLayout } from "../tasks-layout";

export const TasksProjectsPage = ({ data }: { data: PageData<"tasks-projects"> }) => (
    <TasksLayout shell={data}>
        <ProjectsBody data={data} />
    </TasksLayout>
);

const ProjectCard = ({ project, onUp, onDown }: { project: TaskProject; onUp?: () => void; onDown?: () => void }) => {
    const total = project.counts.open + project.counts.completed;
    return (
        <li className="flex flex-col gap-4 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset">
            <div className="flex items-start gap-3">
                <ProjectDot color={project.color} className="mt-2 size-2.5" />
                <div className="min-w-0 flex-1">
                    <a
                        href={projectHref(project.id)}
                        className="rounded-sm text-md font-semibold text-primary outline-focus-ring hover:underline focus-visible:outline-2"
                    >
                        {project.name}
                    </a>
                    {project.description && <p className="mt-1 line-clamp-2 text-sm text-tertiary">{project.description}</p>}
                </div>
                {(onUp || onDown) && (
                    <div className="flex gap-1">
                        <ButtonUtility size="xs" color="tertiary" icon={ArrowUp} tooltip={`Move “${project.name}” up`} isDisabled={!onUp} onClick={onUp} />
                        <ButtonUtility
                            size="xs"
                            color="tertiary"
                            icon={ArrowDown}
                            tooltip={`Move “${project.name}” down`}
                            isDisabled={!onDown}
                            onClick={onDown}
                        />
                    </div>
                )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-tertiary">
                {project.status !== "active" && (
                    <BadgeWithDot
                        size="sm"
                        type="color"
                        color={project.status === "completed" ? "success" : project.status === "archived" ? "gray" : "warning"}
                    >
                        {PROJECT_STATUS_LABELS[project.status]}
                    </BadgeWithDot>
                )}
                {project.kind === "shared" && (
                    <span className="inline-flex items-center gap-1">
                        <Users03 aria-hidden="true" className="size-3.5" /> {project.memberCount} people · you're{" "}
                        {project.role === "owner" ? "an owner" : project.role === "editor" ? "an editor" : "a viewer"}
                    </span>
                )}
                <span>{project.counts.open} open</span>
                {project.counts.overdue > 0 && <span className="text-error-primary">{project.counts.overdue} overdue</span>}
                {project.targetDate && <span>Target {shortDate(project.targetDate)}</span>}
            </div>
            {total > 0 && (
                <ProgressBar
                    value={project.counts.completed}
                    max={total}
                    labelPosition="right"
                    aria-label={`${project.name}: ${project.counts.completed} of ${total} tasks done`}
                    valueFormatter={() => `${project.counts.completed}/${total}`}
                />
            )}
        </li>
    );
};

const ProjectsBody = ({ data }: { data: PageData<"tasks-projects"> }) => {
    const { projects, setProjects } = useTasks();
    const toast = useToast();
    const [creating, setCreating] = useState(false);
    const shared = data.kind === "shared";
    const mine = projects.filter((p) => !p.isInbox && p.kind === data.kind);
    const active = mine.filter((p) => p.status === "active" || p.status === "on_hold");
    const finished = mine.filter((p) => p.status === "completed" || p.status === "archived");

    const move = async (project: TaskProject, delta: -1 | 1) => {
        // Order is per person and across all their projects; move relative to the neighbour shown here.
        const index = active.findIndex((p) => p.id === project.id);
        const neighbour = active[index + delta];
        if (!neighbour) return;
        const all = projects.filter((p) => !p.isInbox);
        const order = all.filter((p) => p.id !== project.id);
        const at = order.findIndex((p) => p.id === neighbour.id);
        const afterId = delta < 0 ? (order[at - 1]?.id ?? null) : neighbour.id;
        try {
            await tasksApi.moveProject(project.id, afterId);
            setProjects((await tasksApi.projects()).projects);
        } catch (error) {
            toast.error("Couldn't move it", errorMessage(error));
        }
    };

    return (
        <>
            <TasksHeader
                title={shared ? "Shared projects" : "My projects"}
                description={
                    shared
                        ? "Projects you share with others. Only the people in each project can see it."
                        : "Your personal projects. Only you can see them unless you share one."
                }
                crumb={{ label: shared ? "Shared projects" : "My projects" }}
                actions={
                    <Button size="sm" color="secondary" iconLeading={FolderPlus} onClick={() => setCreating(true)}>
                        New project
                    </Button>
                }
            />
            {active.length === 0 ? (
                <div className="rounded-xl py-8 ring-1 ring-secondary ring-inset">
                    <Empty
                        icon={shared ? Users03 : FolderPlus}
                        title={shared ? "No shared projects" : "No projects yet"}
                        description={
                            shared
                                ? "Create a shared project for the household, a trip or the wedding, then add the other person."
                                : "Projects group related tasks: a renovation, finances, a holiday."
                        }
                        actions={<Button onClick={() => setCreating(true)}>New project</Button>}
                    />
                </div>
            ) : (
                <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
                    {active.map((p, i) => (
                        <ProjectCard
                            key={p.id}
                            project={p}
                            onUp={i > 0 ? () => void move(p, -1) : undefined}
                            onDown={i < active.length - 1 ? () => void move(p, 1) : undefined}
                        />
                    ))}
                </ul>
            )}
            {finished.length > 0 && (
                <section aria-label="Completed and archived projects" className="flex flex-col gap-3">
                    <h2 className="text-md font-semibold text-primary">Completed and archived</h2>
                    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
                        {finished.map((p) => (
                            <ProjectCard key={p.id} project={p} />
                        ))}
                    </ul>
                </section>
            )}
            <NewProjectDialog isOpen={creating} onOpenChange={setCreating} kind={data.kind} />
        </>
    );
};
