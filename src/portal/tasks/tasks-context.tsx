// State shared by everything on a Tasks page: the shell the Worker sent (projects, sections,
// labels, people), the task panel and Quick Add, and a small change feed so a task saved in the
// panel or Quick Add updates whichever list the page is showing.
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { TaskFields } from "@/portal/tasks/api";
import { type TaskLabel, type TaskProject, type TaskSection, type TaskSummary, type TasksShell, roleAtLeast } from "@/shared/tasks/types";

export type TaskChange = { type: "saved"; task: TaskSummary } | { type: "created"; task: TaskSummary } | { type: "removed"; id: string } | { type: "refresh" };

export interface QuickAddDefaults extends Omit<TaskFields, "title"> {
    title?: string;
}

interface TasksContextValue {
    shell: TasksShell;
    today: string;
    projects: TaskProject[];
    labels: TaskLabel[];
    setProjects: (projects: TaskProject[]) => void;
    setLabels: (labels: TaskLabel[]) => void;
    project: (id: string) => TaskProject | undefined;
    sections: (projectId: string) => TaskSection[];
    setSections: (projectId: string, sections: TaskSection[]) => void;
    /** People a task in this project can be assigned to (empty for personal projects). */
    assignable: (projectId: string) => { email: string; name: string | null }[];
    /** Projects a task can be added to or moved into. */
    writable: TaskProject[];
    canEdit: (projectId: string) => boolean;
    openTask: (id: string) => void;
    closeTask: () => void;
    panelTaskId: string | null;
    openQuickAdd: (defaults?: QuickAddDefaults) => void;
    quickAdd: QuickAddDefaults | null;
    closeQuickAdd: () => void;
    emit: (change: TaskChange) => void;
    subscribe: (listener: (change: TaskChange) => void) => () => void;
}

const Context = createContext<TasksContextValue | null>(null);

export const TasksProvider = ({ shell, initialTask = null, children }: { shell: TasksShell; initialTask?: string | null; children: ReactNode }) => {
    const [projects, setProjects] = useState(shell.projects);
    const [labels, setLabels] = useState(shell.labels);
    const [sectionMap, setSectionMap] = useState(shell.sections);
    const [panelTaskId, setPanelTaskId] = useState<string | null>(initialTask);
    const [quickAdd, setQuickAdd] = useState<QuickAddDefaults | null>(null);
    const listeners = useRef(new Set<(change: TaskChange) => void>());

    const emit = useCallback((change: TaskChange) => listeners.current.forEach((listener) => listener(change)), []);
    const subscribe = useCallback((listener: (change: TaskChange) => void) => {
        listeners.current.add(listener);
        return () => void listeners.current.delete(listener);
    }, []);

    // The panel's task lives in the URL (?task=…) so it survives a reload and can be shared.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const url = new URL(window.location.href);
        if (/^\/portal\/tasks\/t\//.test(url.pathname)) return;
        if (panelTaskId) url.searchParams.set("task", panelTaskId);
        else url.searchParams.delete("task");
        window.history.replaceState(null, "", url);
    }, [panelTaskId]);

    const value = useMemo<TasksContextValue>(() => {
        const project = (id: string) => projects.find((p) => p.id === id);
        return {
            shell,
            today: shell.today,
            projects,
            labels,
            setProjects,
            setLabels,
            project,
            sections: (projectId) => sectionMap[projectId] ?? [],
            setSections: (projectId, sections) => setSectionMap((map) => ({ ...map, [projectId]: sections })),
            assignable: (projectId) => (project(projectId)?.kind === "shared" ? (shell.assignable[projectId] ?? []) : []),
            writable: projects.filter((p) => roleAtLeast(p.role, "editor") && p.status !== "archived"),
            canEdit: (projectId) => {
                const p = project(projectId);
                return !!p && roleAtLeast(p.role, "editor") && p.status !== "archived";
            },
            openTask: setPanelTaskId,
            closeTask: () => setPanelTaskId(null),
            panelTaskId,
            openQuickAdd: (defaults = {}) => setQuickAdd(defaults),
            quickAdd,
            closeQuickAdd: () => setQuickAdd(null),
            emit,
            subscribe,
        };
    }, [shell, projects, labels, sectionMap, panelTaskId, quickAdd, emit, subscribe]);

    return <Context.Provider value={value}>{children}</Context.Provider>;
};

export const useTasks = () => {
    const context = useContext(Context);
    if (!context) throw new Error("useTasks must be used inside TasksProvider");
    return context;
};

/** Runs `listener` for every change made anywhere on the page (panel, Quick Add, other lists). */
export const useTaskChanges = (listener: (change: TaskChange) => void) => {
    const { subscribe } = useTasks();
    const latest = useRef(listener);
    latest.current = listener;
    useEffect(() => subscribe((change) => latest.current(change)), [subscribe]);
};
