// Calls to /api/portal/today (docs/DAILY_PLANNER.md#today). Today owns only its preferences, the
// morning and evening records and Plan My Day; sessions, tasks, events and notes go through the
// Planner, Tasks, Calendar and Knowledge clients.
import type { BlockFields } from "@/portal/calendar/planner-api";
import { api } from "@/portal/lib/api";
import type { PlannerConflict, TimeBlockInfo } from "@/shared/planner/types";
import type { DailyReview, PlanProposal, ReviewSummary, TodayDashboard, TodayPreferences } from "@/shared/today/types";

const T = "/api/portal/today";

export type TodayPart = "plan" | "deadlines" | "commitments" | "notifications" | "completed" | "briefing" | "reviews";

export const todayApi = {
    /** Some parts of the dashboard (all of them when none are named). */
    get: (date: string, parts: TodayPart[] = []) =>
        api<{ today: Partial<TodayDashboard> & Pick<TodayDashboard, "date" | "today" | "timeZone" | "now" | "greeting"> }>(
            "GET",
            `${T}?date=${date}${parts.length ? `&parts=${parts.join(",")}` : ""}`,
        ),
    preferences: () => api<{ preferences: TodayPreferences; version: number }>("GET", `${T}/preferences`),
    savePreferences: (preferences: TodayPreferences, version: number) =>
        api<{ preferences: TodayPreferences; version: number }>("PUT", `${T}/preferences`, { preferences, version }),
    reviews: (date: string) => api<{ reviews: { morning: DailyReview | null; evening: DailyReview | null } }>("GET", `${T}/reviews/${date}`),
    saveReview: (
        date: string,
        kind: "morning" | "evening",
        body: { priorities?: string[]; summary?: Partial<ReviewSummary>; note?: string | null; version: number },
    ) => api<{ review: DailyReview }>("PUT", `${T}/reviews/${date}/${kind}`, body),
    propose: (body: { date: string; taskIds?: string[] }) => api<{ proposal: PlanProposal }>("POST", `${T}/plan`, body),
    apply: (date: string, items: (BlockFields & { clientId: string })[]) =>
        api<{
            created: { block: TimeBlockInfo; conflicts: PlannerConflict[] }[];
            failed: { taskId: string; startTime: string; code: string; message: string }[];
        }>("POST", `${T}/plan/apply`, { date, items }),
};
