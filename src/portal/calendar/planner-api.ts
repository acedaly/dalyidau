// Calls to /api/portal/calendar/planner (docs/DAILY_PLANNER.md). Completing a task goes through
// Tasks' own API (tasksApi.complete), never through the planner.
import { api } from "@/portal/lib/api";
import type { DayPlan, PlanResult, PlannerConflict, PlannerData, PlannerPreferences, PlannerTaskLists, TimeBlockInfo } from "@/shared/planner/types";

const P = "/api/portal/calendar/planner";

export interface BlockFields {
    taskId: string;
    startDate: string;
    startTime: string;
    durationMinutes: number;
    occurrenceDate?: string | null;
    source?: "manual" | "suggestion";
    clientId?: string;
}

export interface BlockChange {
    version: number;
    startDate?: string;
    startTime?: string;
    durationMinutes?: number;
    status?: "cancelled";
}

export type BlockResult = { block: TimeBlockInfo; conflicts: PlannerConflict[] };

export const plannerApi = {
    day: (date: string) => api<{ plan: DayPlan & { lists: PlannerTaskLists } }>("GET", `${P}/day?date=${date}`),
    window: (from: string, to: string) => api<{ planner: PlannerData }>("GET", `${P}/window?from=${from}&to=${to}`),
    tasks: () => api<{ lists: PlannerTaskLists }>("GET", `${P}/tasks`),
    preferences: () => api<{ preferences: PlannerPreferences; version: number }>("GET", `${P}/preferences`),
    savePreferences: (preferences: PlannerPreferences, version: number) =>
        api<{ preferences: PlannerPreferences; version: number }>("PUT", `${P}/preferences`, { preferences, version }),
    estimate: (taskId: string, minutes: number | null) => api<{ taskId: string; minutes: number | null }>("PUT", `${P}/estimates/${taskId}`, { minutes }),
    check: (body: { taskId: string; blockId?: string; startDate: string; startTime: string; durationMinutes: number }) =>
        api<{ conflicts: PlannerConflict[] }>("POST", `${P}/check`, body),
    suggest: (body: { from?: string; days?: number; taskIds?: string[] }) => api<{ plan: PlanResult }>("POST", `${P}/suggest`, body),
    create: (body: BlockFields) => api<BlockResult>("POST", `${P}/blocks`, body),
    get: (id: string) => api<{ block: TimeBlockInfo }>("GET", `${P}/blocks/${id}`),
    update: (id: string, body: BlockChange) => api<BlockResult>("PATCH", `${P}/blocks/${id}`, body),
};

/** What's dragged from the Tasks panel (a task) or from the timeline (a block being moved). */
export const DRAG_TYPE = "application/x-daly-plan";
export type DragPayload = { kind: "task"; taskId: string; minutes: number } | { kind: "block"; blockId: string; version: number; minutes: number };

export const readDrag = (data: DataTransfer): DragPayload | null => {
    try {
        const value = JSON.parse(data.getData(DRAG_TYPE)) as DragPayload;
        return value && (value.kind === "task" || value.kind === "block") ? value : null;
    } catch {
        return null;
    }
};

export const durationLabel = (minutes: number) => {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
};
