// Calls for Milestone 3 (/api/portal/tasks): dashboards, project health and reviews, project
// Knowledge links, goals, routines, workload, timelines and reports. Like api.ts, every response is
// the server's view after the change.
import { api } from "@/portal/lib/api";
import type {
    DashboardPreferences,
    GoalDetail,
    HealthStatus,
    HouseholdDashboard,
    HouseholdFilter,
    PersonalDashboard,
    ProjectHealth,
    ProjectMetrics,
    ProjectReview,
    ProjectTimeline,
    ReportRange,
    ReviewWorkspace,
    Rotation,
    TaskGoal,
    TaskRoutine,
    TasksReport,
    Workload,
} from "@/shared/tasks/productivity";
import type { RecurrenceInput } from "@/shared/tasks/recurrence";
import type { KnowledgeReference, Priority, ProjectRole, TaskSummary } from "@/shared/tasks/types";
import type { CreateFields } from "./api";

const T = "/api/portal/tasks";

export interface GoalInput {
    title?: string;
    description?: string;
    kind?: "personal" | "shared";
    status?: TaskGoal["status"];
    targetDate?: string | null;
    progressMode?: "tasks" | "manual";
    unit?: string | null;
    startValue?: number;
    targetValue?: number | null;
    projectIds?: string[];
    note?: string;
}

export interface RoutineInput {
    title: string;
    description?: string;
    projectId?: string;
    priority?: Priority;
    dueDate?: string | null;
    dueTime?: string | null;
    recurrence: RecurrenceInput;
    rotation?: Rotation;
    participants?: string[];
    checklist?: string[];
    clientId?: string;
}

export const productivityApi = {
    dashboard: (tab: "personal" | "household", filter?: HouseholdFilter) =>
        api<{ tab: string; preferences: DashboardPreferences; personal?: PersonalDashboard; household?: HouseholdDashboard }>(
            "GET",
            `${T}/dashboard?tab=${tab}${filter ? `&filter=${filter}` : ""}`,
        ),
    setDashboardPreferences: (prefs: DashboardPreferences) => api<{ preferences: DashboardPreferences }>("PUT", `${T}/preferences/dashboard`, prefs),

    health: (projectId: string) =>
        api<{ health: ProjectHealth; metrics: ProjectMetrics; draft: { id: string; startedBy: string } | null }>("GET", `${T}/projects/${projectId}/health`),
    setHealth: (projectId: string, version: number, status: HealthStatus | null, note: string | null) =>
        api<{ health: ProjectHealth; metrics: ProjectMetrics }>("PATCH", `${T}/projects/${projectId}/health`, { version, status, note }),
    timeline: (projectId: string) => api<{ timeline: ProjectTimeline }>("GET", `${T}/projects/${projectId}/timeline`),
    projectKnowledge: (projectId: string) => api<{ knowledge: KnowledgeReference[] }>("GET", `${T}/projects/${projectId}/knowledge`),
    linkProjectKnowledge: (projectId: string, objectId: string) =>
        api<{ knowledge: KnowledgeReference[] }>("POST", `${T}/projects/${projectId}/knowledge`, { objectId }),
    unlinkProjectKnowledge: (projectId: string, linkId: string) =>
        api<{ knowledge: KnowledgeReference[] }>("DELETE", `${T}/projects/${projectId}/knowledge/${linkId}`),

    startReview: (projectId: string) => api<ReviewWorkspace>("POST", `${T}/projects/${projectId}/reviews`, {}),
    reviews: (projectId: string, before?: string) =>
        api<{ reviews: ProjectReview[]; hasMore: boolean }>(
            "GET",
            `${T}/projects/${projectId}/reviews${before ? `?before=${encodeURIComponent(before)}` : ""}`,
        ),
    review: (id: string) => api<ReviewWorkspace>("GET", `${T}/reviews/${id}`),
    updateReview: (id: string, version: number, body: { note?: string; health?: HealthStatus | null }) =>
        api<{ review: ProjectReview }>("PATCH", `${T}/reviews/${id}`, { version, ...body }),
    completeReview: (id: string, version: number, body: { note?: string; health?: HealthStatus | null }) =>
        api<{ review: ProjectReview }>("POST", `${T}/reviews/${id}/complete`, { version, ...body }),
    discardReview: (id: string) => api<{ ok: true }>("POST", `${T}/reviews/${id}/discard`, {}),
    addReviewAction: (id: string, fields: Omit<CreateFields, "projectId" | "parentId" | "knowledge">) =>
        api<{ review: ProjectReview }>("POST", `${T}/reviews/${id}/actions`, fields),

    goals: (archived = false) => api<{ goals: TaskGoal[] }>("GET", `${T}/goals${archived ? "?archived=1" : ""}`),
    goal: (id: string) => api<GoalDetail>("GET", `${T}/goals/${id}`),
    createGoal: (body: GoalInput & { title: string }) => api<GoalDetail>("POST", `${T}/goals`, body),
    updateGoal: (id: string, version: number, body: GoalInput) => api<GoalDetail>("PATCH", `${T}/goals/${id}`, { version, ...body }),
    recordProgress: (id: string, version: number, value: number, note: string) =>
        api<GoalDetail>("POST", `${T}/goals/${id}/progress`, { version, value, note }),
    archiveGoal: (id: string, archived: boolean) => api<GoalDetail>("POST", `${T}/goals/${id}/archive`, { archived }),
    deleteGoal: (id: string) => api<{ ok: true }>("POST", `${T}/goals/${id}/delete`, { confirm: "DELETE" }),
    setGoalKind: (id: string, kind: "personal" | "shared") => api<GoalDetail>("POST", `${T}/goals/${id}/kind`, { kind }),
    addGoalMember: (id: string, email: string, role: ProjectRole) =>
        api<{ members: GoalDetail["members"] }>("POST", `${T}/goals/${id}/members`, { email, role }),
    updateGoalMember: (id: string, email: string, role: ProjectRole) =>
        api<{ members: GoalDetail["members"] }>("PATCH", `${T}/goals/${id}/members/${encodeURIComponent(email)}`, { role }),
    removeGoalMember: (id: string, email: string) =>
        api<{ members?: GoalDetail["members"] }>("DELETE", `${T}/goals/${id}/members/${encodeURIComponent(email)}`),
    linkGoal: (id: string, target: { projectId: string } | { taskId: string } | { objectId: string }) =>
        api<GoalDetail>("POST", `${T}/goals/${id}/links`, target),
    unlinkGoal: (id: string, linkId: string) => api<GoalDetail>("DELETE", `${T}/goals/${id}/links/${linkId}`),
    addMilestone: (id: string, title: string, targetDate: string | null) => api<GoalDetail>("POST", `${T}/goals/${id}/milestones`, { title, targetDate }),
    updateMilestone: (id: string, body: { title?: string; targetDate?: string | null; done?: boolean }) =>
        api<{ ok: true }>("PATCH", `${T}/goal-milestones/${id}`, body),
    deleteMilestone: (id: string) => api<{ ok: true }>("DELETE", `${T}/goal-milestones/${id}`),

    routines: () => api<{ routines: TaskRoutine[] }>("GET", `${T}/routines`),
    routine: (id: string) => api<{ routine: TaskRoutine }>("GET", `${T}/routines/${id}`),
    createRoutine: (body: RoutineInput) => api<{ routine: TaskRoutine }>("POST", `${T}/routines`, body),
    convertToRoutine: (taskId: string, rotation: Rotation, participants: string[]) =>
        api<{ routine: TaskRoutine }>("POST", `${T}/routines`, { taskId, rotation, participants }),
    updateRoutine: (id: string, version: number, body: { rotation?: Rotation; participants?: string[] }) =>
        api<{ routine: TaskRoutine }>("PATCH", `${T}/routines/${id}`, { version, ...body }),
    pauseRoutine: (id: string, version: number, paused: boolean) => api<{ routine: TaskRoutine }>("POST", `${T}/routines/${id}/pause`, { version, paused }),
    deleteRoutine: (id: string) => api<{ ok: true }>("DELETE", `${T}/routines/${id}`),
    routineHistory: (id: string, before?: number) =>
        api<{
            entries: { id: number; kind: "completed" | "skipped"; occurrenceDate: string | null; at: string; by: string; byName: string | null }[];
            hasMore: boolean;
        }>("GET", `${T}/routines/${id}/history${before ? `?before=${before}` : ""}`),

    workload: (scope: "mine" | "shared", weeks: number, from?: string) =>
        api<{ workload: Workload }>("GET", `${T}/workload?scope=${scope}&weeks=${weeks}${from ? `&from=${from}` : ""}`),
    report: (scope: "personal" | "shared", range: ReportRange) => api<{ report: TasksReport }>("GET", `${T}/reports?scope=${scope}&range=${range}`),
    reportCsvHref: (scope: "personal" | "shared", range: ReportRange) => `${T}/reports/export?scope=${scope}&range=${range}`,
    /** Tasks and projects related to a Knowledge object, as the caller may see them. */
    relatedToKnowledge: (objectId: string) =>
        api<{
            tasks: TaskSummary[];
            projects: { id: string; name: string; color: string; kind: string; status: string; open: number; completed: number }[];
            taskProjects: { id: string; name: string; color: string }[];
        }>("GET", `${T}/knowledge/${objectId}`),
};

export const goalHref = (id: string) => `/portal/tasks/goals/${id}`;
