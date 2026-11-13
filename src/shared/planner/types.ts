// What the Worker sends Wedding Planner (worker/planner, src/planner) in its page data.
import type { PortalContext } from "../portal/types";

/** The app's views. Each has its own address so the back button, links and shortcuts work. */
export const PLANNER_VIEWS = ["home", "guests", "tasks", "budget", "more", "seating", "timeline", "suppliers"] as const;
export type PlannerView = (typeof PLANNER_VIEWS)[number];

export interface PlannerPageData {
    /** The signed-in person, switches and wedding details, as the portal has them. */
    context: PortalContext;
    /** Where the app lives: "/portal/planner" on daly.id.au (the only address since the 13 Nov 2026 restore). */
    base: string;
    view: PlannerView;
    /** The wedding admin in Payload (https://daly.id.au/admin/wedding), for what the app leaves to it (always absolute). */
    portalUrl: string;
}
