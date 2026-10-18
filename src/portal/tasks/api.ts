// Calls to /api/portal/tasks. Every response is the server's view after the change, so pages can
// replace what they show with it rather than guessing.
import { api } from "@/portal/lib/api";
import type { TaskFilter } from "@/shared/tasks/filters";
import type { RecurrenceInput } from "@/shared/tasks/recurrence";
import type { TaskTemplate, TemplateInput } from "@/shared/tasks/templates";
import type {
    CompletedEntry,
    DayProgress,
    KnowledgeReference,
    Priority,
    SavedTaskView,
    TaskActivityEntry,
    TaskComment,
    TaskDetail,
    TaskLabel,
    TaskMember,
    TaskPreferences,
    TaskProject,
    TaskReminder,
    TaskSection,
    TaskSummary,
    TasksShell,
} from "@/shared/tasks/types";
import type { UpcomingMode, ViewKey, ViewPreferences } from "@/shared/tasks/view-preferences";

const T = "/api/portal/tasks";

export interface TaskFields {
    title?: string;
    description?: string;
    projectId?: string;
    sectionId?: string | null;
    parentId?: string | null;
    priority?: Priority;
    dueDate?: string | null;
    dueTime?: string | null;
    deadline?: string | null;
    recurrence?: RecurrenceInput | null;
    labels?: string[];
    assignee?: string | null;
    isMilestone?: boolean;
    afterId?: string | null;
}

/** Only when creating: a request id that makes a retry return the same task, and Knowledge to link. */
export interface CreateFields extends TaskFields {
    title: string;
    clientId?: string;
    knowledge?: string[];
}

export interface CompletionResult {
    task: TaskSummary;
    alreadyDone: boolean;
    nextDate: string | null;
}

export type BulkAction =
    | { action: "complete"; includeSubtasks?: boolean }
    | { action: "delete" }
    | { action: "priority"; priority: Priority }
    | { action: "due"; dueDate: string | null }
    | { action: "shift"; days: number }
    | { action: "move"; projectId: string; sectionId?: string | null }
    | { action: "label" | "unlabel"; label: string };

export const tasksApi = {
    list: (view: "inbox" | "today" | "overdue" | "upcoming", query = "") =>
        api<{ tasks: TaskSummary[]; progress?: DayProgress }>("GET", `${T}/lists/${view}${query}`),
    upcoming: (mode: UpcomingMode, from: string) =>
        api<{ tasks: TaskSummary[]; deadlines: TaskSummary[]; done: TaskSummary[]; from: string; days: number }>(
            "GET",
            `${T}/lists/upcoming?mode=${mode}&from=${from}`,
        ),
    shell: () => api<{ shell: TasksShell }>("GET", `${T}/shell`),
    setViewPreferences: (view: ViewKey, preferences: ViewPreferences) =>
        api<{ preferences: ViewPreferences }>("PUT", `${T}/preferences/views/${view}`, preferences),
    completed: (before?: number) => api<{ entries: CompletedEntry[]; hasMore: boolean }>("GET", `${T}/lists/completed${before ? `?before=${before}` : ""}`),
    filter: (params: URLSearchParams) => api<{ tasks: TaskSummary[]; hasMore: boolean }>("GET", `${T}/filter?${params}`),
    search: (q: string) => api<{ tasks: TaskSummary[]; projects: { id: string; name: string }[] }>("GET", `${T}/search?q=${encodeURIComponent(q)}`),

    create: (fields: CreateFields) => api<{ task: TaskSummary; replayed: boolean }>("POST", `${T}/tasks`, fields),
    get: (id: string) => api<TaskDetail>("GET", `${T}/tasks/${id}`),
    /** `scope` applies when a repeating task's date changes: just this occurrence (default) or the series from here on. */
    update: (id: string, version: number, fields: TaskFields, scope?: "occurrence" | "series") =>
        api<{ task: TaskSummary }>("PATCH", `${T}/tasks/${id}`, { version, ...fields, ...(scope ? { scope } : {}) }),
    complete: (id: string, occurrence: string | null, includeSubtasks = false) =>
        api<CompletionResult>("POST", `${T}/tasks/${id}/complete`, { occurrence, includeSubtasks }),
    skip: (id: string, occurrence: string | null) => api<CompletionResult>("POST", `${T}/tasks/${id}/skip`, { occurrence }),
    reopen: (id: string) => api<{ task: TaskSummary }>("POST", `${T}/tasks/${id}/reopen`, {}),
    move: (id: string, to: { projectId?: string; sectionId?: string | null; parentId?: string | null; afterId?: string | null; beforeId?: string | null }) =>
        api<{ task: TaskSummary }>("POST", `${T}/tasks/${id}/move`, to),
    duplicate: (id: string) => api<{ task: TaskSummary }>("POST", `${T}/tasks/${id}/duplicate`, {}),
    /** One later occurrence of a repeating task, by its series date. */
    occurrence: (id: string, body: { action: "skip" | "restore"; date: string } | { action: "move"; date: string; to: string }) =>
        api<{ task: TaskSummary }>("POST", `${T}/tasks/${id}/occurrences`, body),
    saveAsTemplate: (id: string, name: string) => api<{ template: TaskTemplate }>("POST", `${T}/tasks/${id}/template`, { name }),

    templates: (archived = false) => api<{ templates: TaskTemplate[] }>("GET", `${T}/templates${archived ? "?archived=1" : ""}`),
    createTemplate: (body: TemplateInput) => api<{ template: TaskTemplate }>("POST", `${T}/templates`, body),
    updateTemplate: (id: string, version: number, body: { template?: TemplateInput; archived?: boolean }) =>
        api<{ template: TaskTemplate }>("PATCH", `${T}/templates/${id}`, { version, ...body }),
    deleteTemplate: (id: string) => api<{ ok: true }>("DELETE", `${T}/templates/${id}`),
    duplicateTemplate: (id: string) => api<{ template: TaskTemplate }>("POST", `${T}/templates/${id}/duplicate`, {}),
    useTemplate: (id: string, body: { projectId?: string; sectionId?: string | null; startDate?: string }) =>
        api<{ task: TaskSummary }>("POST", `${T}/templates/${id}/use`, body),

    importPreview: (body: ImportRequest) => api<ImportPreview>("POST", `${T}/import/todoist/preview`, body),
    importRun: (body: ImportRequest & { batchId?: string }) => api<ImportRun>("POST", `${T}/import/todoist/run`, body),
    remove: (id: string) => api<{ ok: true }>("DELETE", `${T}/tasks/${id}`),
    bulk: (ids: string[], action: BulkAction) => api<{ changed: number }>("POST", `${T}/tasks/bulk`, { ids, ...action }),

    addComment: (id: string, body: string) => api<{ comments: TaskComment[] }>("POST", `${T}/tasks/${id}/comments`, { body }),
    editComment: (id: string, body: string) => api<{ comments: TaskComment[] }>("PATCH", `${T}/comments/${id}`, { body }),
    deleteComment: (id: string) => api<{ comments: TaskComment[] }>("DELETE", `${T}/comments/${id}`),

    linkKnowledge: (id: string, objectId: string) => api<{ knowledge: KnowledgeReference[] }>("POST", `${T}/tasks/${id}/knowledge`, { objectId }),
    unlinkKnowledge: (id: string, linkId: string) => api<{ knowledge: KnowledgeReference[] }>("DELETE", `${T}/tasks/${id}/knowledge/${linkId}`),

    addReminder: (id: string, body: { kind: "absolute"; date: string; time: string } | { kind: "relative"; offsetMinutes: number }) =>
        api<{ reminders: TaskReminder[] }>("POST", `${T}/tasks/${id}/reminders`, body),
    deleteReminder: (id: string) => api<{ ok: true }>("DELETE", `${T}/reminders/${id}`),
    dismissReminder: (id: string) => api<{ ok: true }>("POST", `${T}/reminders/${id}/dismiss`, {}),

    projects: () => api<{ projects: TaskProject[] }>("GET", `${T}/projects`),
    project: (id: string) => api<{ project: TaskProject; tasks: TaskSummary[]; members: TaskMember[]; sections: TaskSection[] }>("GET", `${T}/projects/${id}`),
    projectCompleted: (id: string) => api<{ tasks: TaskSummary[] }>("GET", `${T}/projects/${id}/completed`),
    createProject: (body: {
        name: string;
        description?: string;
        color?: string;
        kind?: "personal" | "shared";
        sections?: string[];
        startDate?: string | null;
        targetDate?: string | null;
    }) => api<{ project: TaskProject }>("POST", `${T}/projects`, body),
    updateProject: (
        id: string,
        version: number,
        body: Partial<Pick<TaskProject, "name" | "description" | "color" | "startDate" | "targetDate" | "defaultView" | "status" | "reviewFrequency">>,
    ) => api<{ project: TaskProject }>("PATCH", `${T}/projects/${id}`, { version, ...body }),
    setProjectKind: (id: string, kind: "personal" | "shared") => api<{ project: TaskProject }>("POST", `${T}/projects/${id}/kind`, { kind }),
    deleteProject: (id: string) => api<{ ok: true }>("POST", `${T}/projects/${id}/delete`, { confirm: "DELETE" }),
    moveProject: (id: string, afterId: string | null) => api<{ ok: true }>("POST", `${T}/projects/${id}/position`, { afterId }),
    addMember: (id: string, email: string, role: TaskMember["role"]) => api<{ members: TaskMember[] }>("POST", `${T}/projects/${id}/members`, { email, role }),
    updateMember: (id: string, email: string, role: TaskMember["role"]) =>
        api<{ members: TaskMember[] }>("PATCH", `${T}/projects/${id}/members/${encodeURIComponent(email)}`, { role }),
    removeMember: (id: string, email: string) => api<{ members?: TaskMember[] }>("DELETE", `${T}/projects/${id}/members/${encodeURIComponent(email)}`),

    createSection: (projectId: string, name: string) => api<{ section: TaskSection }>("POST", `${T}/projects/${projectId}/sections`, { name }),
    renameSection: (id: string, name: string) => api<{ ok: true }>("PATCH", `${T}/sections/${id}`, { name }),
    moveSection: (id: string, afterId: string | null) => api<{ ok: true }>("POST", `${T}/sections/${id}/position`, { afterId }),
    deleteSection: (id: string, moveTo: string | null) => api<{ ok: true }>("POST", `${T}/sections/${id}/delete`, { moveTo }),

    labels: () => api<{ labels: TaskLabel[]; others: string[] }>("GET", `${T}/labels`),
    createLabel: (name: string, color: string) => api<{ labels: TaskLabel[] }>("POST", `${T}/labels`, { name, color }),
    updateLabel: (id: string, body: { name?: string; color?: string }) => api<{ labels: TaskLabel[] }>("PATCH", `${T}/labels/${id}`, body),
    deleteLabel: (id: string) => api<{ labels: TaskLabel[] }>("DELETE", `${T}/labels/${id}`),

    createView: (name: string, definition: TaskFilter) => api<{ view: SavedTaskView }>("POST", `${T}/filters`, { name, definition }),
    updateView: (id: string, version: number, body: { name?: string; definition?: TaskFilter }) =>
        api<{ view: SavedTaskView }>("PATCH", `${T}/filters/${id}`, { version, ...body }),
    deleteView: (id: string) => api<{ ok: true }>("DELETE", `${T}/filters/${id}`),

    activity: (projectId?: string | null, before?: number) => {
        const params = new URLSearchParams();
        if (projectId) params.set("project", projectId);
        if (before) params.set("before", String(before));
        return api<{ entries: TaskActivityEntry[] }>("GET", `${T}/activity?${params}`);
    },
    preferences: (body: Partial<TaskPreferences>) => api<{ preferences: TaskPreferences }>("PATCH", `${T}/preferences`, body),
};

export const taskHref = (id: string) => `/portal/tasks/t/${id}`;
export const projectHref = (id: string, view?: "list" | "board" | "overview" | "timeline") => `/portal/tasks/p/${id}${view ? `?view=${view}` : ""}`;

export interface ImportRequest {
    files: { name: string; text: string }[];
    options: {
        priorityScale: "one_is_highest" | "four_is_highest";
        destinations: Record<string, string>;
        duplicates: "link" | "import";
        changed: "keep" | "update";
    };
}

export type ImportStatus = "new" | "unchanged" | "update" | "conflict" | "deleted" | "duplicate" | "import_duplicate";

export interface ImportPreview {
    fingerprint: string;
    importedBefore: string | null;
    projects: {
        key: string;
        file: string;
        name: string;
        board: boolean;
        destination: { kind: "new" } | { kind: "existing"; projectId: string; name: string; imported: boolean };
        sameName: { id: string; name: string } | null;
        sections: string[];
        taskCount: number;
        subtaskCount: number;
        commentCount: number;
        repeating: number;
        labels: string[];
        counts: Record<ImportStatus, number>;
        unsupported: Record<string, number>;
        priorityValues: Record<string, number>;
        warnings: string[];
        sample: {
            title: string;
            depth: number;
            section: string | null;
            priority: Priority;
            due: string | null;
            deadline: string | null;
            labels: string[];
            status: ImportStatus;
        }[];
    }[];
    notImported: string[];
}

export interface ImportRun {
    batchId: string;
    done: boolean;
    summary: NonNullable<import("@/shared/tasks/types").ImportRecord["summary"]>;
}
