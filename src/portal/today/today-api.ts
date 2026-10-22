// Calls to /api/portal/today (docs/DAILY_PLANNER.md#today). Today owns only its preferences and the
// person's planning hours; events go through Calendar's client.
import { api } from "@/portal/lib/api";
import type { PlanningHours } from "@/shared/today/availability";
import type { TodayDashboard, TodayPreferences } from "@/shared/today/types";

const T = "/api/portal/today";

export type TodayPart = "plan" | "commitments" | "notifications" | "briefing";

export const todayApi = {
    /** Some parts of the dashboard (all of them when none are named). */
    get: (date: string, parts: TodayPart[] = []) =>
        api<{ today: Partial<TodayDashboard> & Pick<TodayDashboard, "date" | "today" | "timeZone" | "now" | "greeting"> }>(
            "GET",
            `${T}?date=${date}${parts.length ? `&parts=${parts.join(",")}` : ""}`,
        ),
    savePreferences: (preferences: TodayPreferences, version: number) =>
        api<{ preferences: TodayPreferences; version: number }>("PUT", `${T}/preferences`, { preferences, version }),
    savePlanningHours: (preferences: PlanningHours, version: number) =>
        api<{ preferences: PlanningHours; version: number }>("PUT", `${T}/hours`, { preferences, version }),
};
