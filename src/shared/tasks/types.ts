// Daly Tasks & Projects: shapes shared by the Worker and the browser.
import type { TaskFilter } from "./filters";
import type { RecurrenceRule } from "./recurrence";

export const PROJECT_ROLES = ["owner", "editor", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

const RANK: Record<ProjectRole, number> = { viewer: 0, editor: 1, owner: 2 };
export const roleAtLeast = (role: ProjectRole, minimum: ProjectRole) => RANK[role] >= RANK[minimum];

export const PROJECT_STATUSES = ["active", "on_hold", "completed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = { active: "Active", on_hold: "On hold", completed: "Completed", archived: "Archived" };

export const COLORS = ["gray", "brand", "error", "warning", "success", "blue", "indigo", "purple", "pink", "orange"] as const;
export type TaskColor = (typeof COLORS)[number];
export const COLOR_LABELS: Record<TaskColor, string> = {
    gray: "Grey",
    brand: "Brand",
    error: "Red",
    warning: "Amber",
    success: "Green",
    blue: "Blue",
    indigo: "Indigo",
    purple: "Purple",
    pink: "Pink",
    orange: "Orange",
};

export type Priority = 1 | 2 | 3 | 4;
export const PRIORITIES: readonly Priority[] = [1, 2, 3, 4];
export const DEFAULT_PRIORITY: Priority = 4;
export const PRIORITY_LABELS: Record<Priority, { short: string; label: string }> = {
    1: { short: "P1", label: "Urgent" },
    2: { short: "P2", label: "High" },
    3: { short: "P3", label: "Normal" },
    4: { short: "P4", label: "Low" },
};

/** Subtasks nest at most this deep below a top-level task (database CHECK depth BETWEEN 0 AND 3). */
export const MAX_DEPTH = 3;

export const LIMITS = {
    title: 500,
    description: 10_000,
    comment: 5_000,
    projectName: 120,
    projectDescription: 2_000,
    sectionName: 120,
    labelName: 60,
    labelsPerTask: 20,
    viewName: 80,
    bulk: 100,
    knowledgeLinksPerTask: 20,
    remindersPerTask: 5,
};

export interface TaskProject {
    id: string;
    name: string;
    description: string;
    color: TaskColor;
    kind: "personal" | "shared";
    isInbox: boolean;
    status: ProjectStatus;
    startDate: string | null;
    targetDate: string | null;
    defaultView: "list" | "board";
    role: ProjectRole;
    version: number;
    /** Open and completed top-level and subtasks, for progress. */
    counts: { open: number; completed: number; overdue: number };
    memberCount: number;
    updatedAt: string;
}

export interface TaskMember {
    email: string;
    name: string | null;
    role: ProjectRole;
    addedBy: string;
    createdAt: string;
}

export interface TaskSection {
    id: string;
    projectId: string;
    name: string;
    position: number;
}

export interface TaskSummary {
    id: string;
    projectId: string;
    sectionId: string | null;
    parentId: string | null;
    depth: number;
    title: string;
    /** First 240 characters, for rows. The full text comes with the detail. */
    excerpt: string;
    hasDescription: boolean;
    status: "open" | "completed";
    priority: Priority;
    dueDate: string | null;
    dueTime: string | null;
    deadline: string | null;
    recurrence: RecurrenceRule | null;
    isMilestone: boolean;
    assignee: string | null;
    labels: string[];
    position: number;
    completedAt: string | null;
    completedBy: string | null;
    subtasks: { open: number; total: number };
    comments: number;
    version: number;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    updatedBy: string;
    /** Set on rows from Upcoming that are a later repeat of this task rather than the task itself. */
    projected?: boolean;
}

export interface TaskCompletion {
    id: number;
    kind: "completed" | "skipped";
    occurrenceDate: string | null;
    nextDate: string | null;
    at: string;
    by: string;
    undoneAt: string | null;
}

export interface TaskComment {
    id: string;
    author: string;
    authorName: string | null;
    body: string;
    createdAt: string;
    editedAt: string | null;
}

/** A Knowledge reference as one person sees it: available only while their own Knowledge membership allows. */
export type KnowledgeReference = { linkId: string; available: true; objectId: string; title: string; spaceName: string } | { linkId: string; available: false };

export interface TaskReminder {
    id: string;
    kind: "absolute" | "relative";
    offsetMinutes: number | null;
    remindAt: string;
    dismissedAt: string | null;
}

export interface TaskActivityEntry {
    id: number;
    projectId: string;
    taskId: string | null;
    /** The task's current title, if it still exists and the reader can see it. Never stored in the history. */
    taskTitle: string | null;
    actor: string;
    actorName: string | null;
    action: string;
    at: string;
    changes: Record<string, unknown> | null;
}

export interface TaskDetail {
    task: TaskSummary & { description: string };
    project: Pick<TaskProject, "id" | "name" | "color" | "kind" | "isInbox" | "role">;
    parent: { id: string; title: string } | null;
    subtasks: TaskSummary[];
    completions: TaskCompletion[];
    comments: TaskComment[];
    knowledge: KnowledgeReference[];
    reminders: TaskReminder[];
    activity: TaskActivityEntry[];
}

export interface TaskLabel {
    id: string;
    name: string;
    color: TaskColor;
    /** Open tasks carrying this label that the owner can see. */
    openCount: number;
}

export interface SavedTaskView {
    id: string;
    name: string;
    definition: TaskFilter;
    version: number;
}

export interface TaskPreferences {
    timeZone: string;
    todayPriority: Priority | null;
}

export interface DueReminder {
    id: string;
    taskId: string;
    title: string;
    remindAt: string;
}

/** What every Tasks page gets for its navigation, header, pickers and Quick Add. */
export interface TasksShell {
    today: string;
    preferences: TaskPreferences;
    inboxId: string;
    projects: TaskProject[];
    /** People who can be assigned, per shared project the caller can edit. */
    assignable: Record<string, { email: string; name: string | null }[]>;
    sections: Record<string, TaskSection[]>;
    labels: TaskLabel[];
    views: SavedTaskView[];
    reminders: DueReminder[];
    canUseKnowledge: boolean;
}

export type TaskViewName = "inbox" | "today" | "upcoming" | "overdue" | "completed";

export interface CompletedEntry {
    task: TaskSummary;
    completion: TaskCompletion;
}

export type TasksRoute =
    | (TasksShell & { route: "tasks-view"; view: Exclude<TaskViewName, "completed" | "upcoming">; tasks: TaskSummary[] })
    | (TasksShell & { route: "tasks-upcoming"; from: string; days: number; overdue: TaskSummary[]; tasks: TaskSummary[] })
    | (TasksShell & { route: "tasks-completed"; entries: CompletedEntry[]; hasMore: boolean })
    | (TasksShell & {
          route: "tasks-project";
          project: TaskProject;
          tab: "list" | "board" | "overview";
          tasks: TaskSummary[];
          completedCount: number;
          members: TaskMember[];
          overview: ProjectOverview | null;
          openTask: string | null;
      })
    | (TasksShell & { route: "tasks-projects"; kind: "personal" | "shared"; archived: TaskProject[] })
    | (TasksShell & { route: "tasks-labels" })
    | (TasksShell & { route: "tasks-filters"; filter: TaskFilter; savedView: SavedTaskView | null; tasks: TaskSummary[]; hasMore: boolean })
    | (TasksShell & { route: "tasks-search"; query: string; tasks: TaskSummary[]; matchedProjects: { id: string; name: string }[] })
    | (TasksShell & { route: "tasks-activity"; entries: TaskActivityEntry[]; projectId: string | null })
    | (TasksShell & { route: "tasks-settings" });

export interface ProjectOverview {
    upcomingDeadlines: TaskSummary[];
    milestones: TaskSummary[];
    knowledge: KnowledgeReference[];
    activity: TaskActivityEntry[];
}
