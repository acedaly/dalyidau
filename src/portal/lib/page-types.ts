import type { PortalPageData } from "@/shared/portal/types";

/** The page payload for one route, e.g. PageData<"guests">. */
export type PageData<R extends PortalPageData["route"]> = Extract<PortalPageData, { route: R }>;
