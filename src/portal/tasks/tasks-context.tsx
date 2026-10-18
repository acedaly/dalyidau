// State shared by everything on a Tasks page: the shell the Worker sent (projects, sections,
// labels, people), the task panel and Quick Add, the person's own list preferences, and a small
// change feed so a task saved in the panel or Quick Add updates whichever list the page is showing.
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type TaskFields, tasksApi } from "@/portal/tasks/api";
import { type TaskLabel, type TaskProject, type TaskSection, type TaskSummary, type TasksShell, roleAtLeast } from "@/shared/tasks/types";
import type { ViewKey, ViewPreferenceMap, ViewPreferences } from "@/shared/tasks/view-preferences";

export type TaskChange = { type: "saved"; task: TaskSummary } | { type: "created"; task: TaskSummary } | { type: "removed"; id: string } | { type: "refresh" };

export interface QuickAddDefaults extends Omit<TaskFields, "title"> {
    title?: string;
    /** Offer to reference this Knowledge object from the new task (Quick Add on a Knowledge page). */
    knowledge?: { id: string; title: string };
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
    /** The caller's own choices for a list (sort, grouping, filters, layout). */
    viewPreferences: (view: ViewKey) => ViewPreferences;
    /** Changes them at once and saves them in the background; they follow the person to other devices. */
    setViewPreferences: (view: ViewKey, preferences: ViewPreferences) => void;
}

const Context = createContext<TasksContextValue | null>(null);

/** One shared "no choices yet" value, so lists without saved preferences don't re-render or reload. */
const NO_PREFERENCES: ViewPreferences = {};

export const TasksProvider = ({
    shell,
    initialTask = null,
    syncUrl = true,
    children,
}: {
    shell: TasksShell;
    initialTask?: string | null;
    /** Keep the open task in the address (?task=…). Off for Quick Add on pages outside Tasks. */
    syncUrl?: boolean;
    children: ReactNode;
}) => {
    const [projects, setProjects] = useState(shell.projects);
    const [labels, setLabels] = useState(shell.labels);
    const [sectionMap, setSectionMap] = useState(shell.sections);
    const [panelTaskId, setPanelTaskId] = useState<string | null>(initialTask);
    const [quickAdd, setQuickAdd] = useState<QuickAddDefaults | null>(null);
    const [viewPrefs, setViewPrefs] = useState<ViewPreferenceMap>(shell.viewPreferences ?? {});
    const listeners = useRef(new Set<(change: TaskChange) => void>());
    const saveTimers = useRef(new Map<ViewKey, number>());

    // Saved a moment after the last change, so clicking through options sends one request.
    const setViewPreferences = useCallback((view: ViewKey, preferences: ViewPreferences) => {
        setViewPrefs((map) => ({ ...map, [view]: preferences }));
        window.clearTimeout(saveTimers.current.get(view));
        saveTimers.current.set(
            view,
            window.setTimeout(() => void tasksApi.setViewPreferences(view, preferences).catch(() => undefined), 400),
        );
    }, []);

    const emit = useCallback((change: TaskChange) => listeners.current.forEach((listener) => listener(change)), []);
    const subscribe = useCallback((listener: (change: TaskChange) => void) => {
        listeners.current.add(listener);
        return () => void listeners.current.delete(listener);
    }, []);

    // The panel's task lives in the URL (?task=…) so it survives a reload and can be shared.
    useEffect(() => {
        if (typeof window === "undefined" || !syncUrl) return;
        const url = new URL(window.location.href);
        if (/^\/portal\/tasks\/t\//.test(url.pathname)) return;
        if (panelTaskId) url.searchParams.set("task", panelTaskId);
        else url.searchParams.delete("task");
        window.history.replaceState(null, "", url);
    }, [panelTaskId, syncUrl]);

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
            viewPreferences: (view) => viewPrefs[view] ?? NO_PREFERENCES,
            setViewPreferences,
        };
    }, [shell, projects, labels, sectionMap, panelTaskId, quickAdd, emit, subscribe, viewPrefs, setViewPreferences]);

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
