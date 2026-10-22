import type { FlagKey } from "./flags";
import type { Permission } from "./permissions";

export type ApplicationId = "wedding" | "calendar" | "intelligence" | "intelligence-centre" | "assets";

export type ApplicationIcon = "wedding" | "calendar" | "intelligence" | "centre" | "assets";

export type NavigationIcon =
    | "dashboard"
    | "guests"
    | "households"
    | "rsvps"
    | "events"
    | "communications"
    | "invitations"
    | "website"
    | "seating"
    | "catering"
    | "tasks"
    | "timeline"
    | "budget"
    | "suppliers"
    | "settings"
    | "knowledge"
    | "shared"
    | "reports"
    | "intelligence"
    | "briefing"
    | "review"
    | "calendar"
    | "year"
    | "agenda"
    | "subscriptions"
    | "family"
    | "leave"
    | "planner"
    | "holidays"
    | "centre"
    | "map"
    | "incidents"
    | "hazards"
    | "history"
    | "watch"
    | "wallboard"
    | "sources"
    | "changes"
    | "situation"
    | "replay"
    | "analytics"
    | "correlations"
    | "rules"
    | "assistant"
    | "assets"
    | "vehicles"
    | "property"
    | "maintenance"
    | "insurance"
    | "warranty"
    | "documents"
    | "scan";

export interface ApplicationNavigationItem {
    label: string;
    href: string;
    icon: NavigationIcon;
    permission?: Permission;
    flag?: FlagKey;
    active?: "exact" | "prefix";
}

export interface ApplicationNavigationSection {
    label: string;
    items: readonly ApplicationNavigationItem[];
}

export interface ApplicationStatusConfig {
    flag: FlagKey;
    enabledLabel: string;
    disabledLabel: string;
}

export interface PortalApplication {
    id: ApplicationId;
    name: string;
    /** One line for the launcher card. */
    summary: string;
    description: string;
    icon: ApplicationIcon;
    baseRoute: string;
    requiredPermission: Permission;
    enabled: boolean;
    status?: ApplicationStatusConfig;
    navigation: readonly ApplicationNavigationSection[];
}

export const APPLICATIONS = [
    {
        id: "wedding",
        name: "Wedding Planner",
        summary: "Guests, RSVPs, seating and budget.",
        description: "Manage our wedding, including guests, RSVPs, seating, catering, planning, budget and communications.",
        icon: "wedding",
        baseRoute: "/portal/wedding",
        requiredPermission: "wedding.view",
        enabled: true,
        status: {
            flag: "wedding.site.public",
            enabledLabel: "Website published",
            disabledLabel: "Website private",
        },
        navigation: [
            {
                label: "Wedding",
                items: [
                    { label: "Dashboard", href: "/portal/wedding", icon: "dashboard" },
                    { label: "Guests", href: "/portal/wedding/guests", icon: "guests" },
                    { label: "Households", href: "/portal/wedding/households", icon: "households" },
                    { label: "RSVPs", href: "/portal/wedding/rsvps", icon: "rsvps" },
                    { label: "Events", href: "/portal/wedding/events", icon: "events" },
                    { label: "Invitation Studio", href: "/portal/wedding/invitations", icon: "invitations" },
                    {
                        label: "Communications",
                        href: "/portal/wedding/communications",
                        icon: "communications",
                        flag: "module.communications",
                    },
                    {
                        label: "Email & SMS settings",
                        href: "/portal/wedding/communications/providers",
                        icon: "settings",
                        flag: "module.communications",
                    },
                    { label: "Website", href: "/portal/wedding/website", icon: "website", active: "prefix" },
                ],
            },
            {
                label: "Planning",
                items: [
                    { label: "Seating", href: "/portal/wedding/seating", icon: "seating", flag: "module.planning" },
                    { label: "Catering", href: "/portal/wedding/catering", icon: "catering", flag: "module.planning" },
                    { label: "Tasks", href: "/portal/wedding/tasks", icon: "tasks", flag: "module.planning" },
                    { label: "Timeline", href: "/portal/wedding/timeline", icon: "timeline", flag: "module.planning" },
                    {
                        label: "Budget",
                        href: "/portal/wedding/budget",
                        icon: "budget",
                        flag: "module.budget",
                        permission: "wedding.budget.view",
                    },
                    {
                        label: "Suppliers",
                        href: "/portal/wedding/suppliers",
                        icon: "suppliers",
                        flag: "module.budget",
                        permission: "wedding.budget.view",
                    },
                ],
            },
            {
                label: "Application",
                items: [{ label: "Wedding settings", href: "/portal/wedding/settings", icon: "settings", active: "prefix" }],
            },
        ],
    },
    {
        id: "calendar",
        name: "Daly Calendar",
        summary: "Calendars, school holidays and leave.",
        description:
            "Personal and shared calendars, subscribed feeds, the family planner, NSW public and school holidays, and an annual leave planner with forecasts. Private to you unless you share.",
        icon: "calendar",
        baseRoute: "/portal/calendar",
        requiredPermission: "calendar.use",
        enabled: true,
        navigation: [
            {
                label: "Calendar",
                items: [
                    { label: "Calendar", href: "/portal/calendar", icon: "calendar" },
                    { label: "Agenda", href: "/portal/calendar?view=agenda", icon: "agenda" },
                    { label: "Year planner", href: "/portal/calendar/year", icon: "year" },
                    { label: "Family planner", href: "/portal/calendar/family", icon: "family" },
                ],
            },
            {
                label: "Leave",
                items: [
                    { label: "Leave and balances", href: "/portal/calendar/leave", icon: "leave" },
                    { label: "Plan time off", href: "/portal/calendar/leave/planner", icon: "planner" },
                    { label: "Leave settings", href: "/portal/calendar/leave/settings", icon: "settings" },
                ],
            },
            {
                label: "Manage",
                items: [
                    { label: "Calendars and sharing", href: "/portal/calendar/calendars", icon: "shared" },
                    { label: "Subscriptions", href: "/portal/calendar/subscriptions", icon: "subscriptions" },
                    { label: "Holidays and school dates", href: "/portal/calendar/holidays", icon: "holidays" },
                    { label: "Settings, import and export", href: "/portal/calendar/settings", icon: "settings" },
                ],
            },
        ],
    },
    {
        id: "intelligence",
        name: "Daly Intelligence",
        summary: "AI settings, budgets and briefings.",
        description:
            "The portal's shared AI layer: daily briefings and weekly reviews from your calendar, the AI budget, and the settings Home & Assets and the Intelligence Centre use. Off until an owner switches it on.",
        icon: "intelligence",
        baseRoute: "/portal/intelligence",
        requiredPermission: "intelligence.use",
        enabled: true,
        navigation: [
            {
                label: "Intelligence",
                items: [
                    { label: "Overview", href: "/portal/intelligence", icon: "intelligence" },
                    { label: "Daily briefing", href: "/portal/intelligence/briefing", icon: "briefing" },
                    { label: "Weekly review", href: "/portal/intelligence/briefing/weekly", icon: "review" },
                ],
            },
            {
                label: "Application",
                items: [{ label: "AI settings", href: "/portal/intelligence/settings", icon: "settings" }],
            },
        ],
    },
    {
        id: "intelligence-centre",
        name: "Intelligence Centre",
        summary: "Public warnings, incidents, weather and hazards.",
        description:
            "Official warnings, incidents, fire danger, weather, rivers, roads, air quality and other public hazard information on a map, with private watch areas, alerts, briefings and wallboards. Not an official warning service.",
        icon: "centre",
        baseRoute: "/portal/intelligence-centre",
        requiredPermission: "centre.use",
        enabled: true,
        status: {
            flag: "intelligence_centre.ingestion",
            enabledLabel: "Collecting",
            disabledLabel: "Collection off",
        },
        navigation: [
            {
                label: "Situation",
                items: [
                    { label: "Overview", href: "/portal/intelligence-centre", icon: "centre" },
                    { label: "Live map", href: "/portal/intelligence-centre/map", icon: "map" },
                    { label: "What's changed", href: "/portal/intelligence-centre/changes", icon: "changes" },
                    { label: "Incidents and warnings", href: "/portal/intelligence-centre/records", icon: "incidents", active: "prefix" },
                    { label: "Hazards", href: "/portal/intelligence-centre/hazards/weather", icon: "hazards", active: "prefix" },
                ],
            },
            {
                label: "Analysis",
                items: [
                    { label: "Timelines", href: "/portal/intelligence-centre/timeline", icon: "situation" },
                    { label: "Replay", href: "/portal/intelligence-centre/replay", icon: "replay" },
                    { label: "Analytics", href: "/portal/intelligence-centre/analytics", icon: "analytics" },
                    { label: "Correlations", href: "/portal/intelligence-centre/correlations", icon: "correlations" },
                    { label: "History", href: "/portal/intelligence-centre/history", icon: "history" },
                    { label: "Briefings", href: "/portal/intelligence-centre/briefings", icon: "briefing" },
                    { label: "Reports", href: "/portal/intelligence-centre/reports", icon: "reports", active: "prefix" },
                    { label: "Assistant", href: "/portal/intelligence-centre/assistant", icon: "assistant" },
                ],
            },
            {
                label: "Manage",
                items: [
                    { label: "Watch areas", href: "/portal/intelligence-centre/watches", icon: "watch" },
                    { label: "Monitoring rules", href: "/portal/intelligence-centre/rules", icon: "rules" },
                    { label: "Wallboards", href: "/portal/intelligence-centre/wallboards", icon: "wallboard", active: "prefix" },
                    { label: "Sources", href: "/portal/intelligence-centre/sources", icon: "sources" },
                    { label: "Settings", href: "/portal/intelligence-centre/settings", icon: "settings" },
                ],
            },
        ],
    },
    {
        id: "assets",
        name: "Home & Assets",
        summary: "What we own, its upkeep, warranties and insurance.",
        description:
            "Everything we own, maintain, insure or will need to replace: vehicles and trailers, the home and rentals, servicing and repairs, warranties, insurance, receipts and manuals, values and QR labels. Private to you unless you share.",
        icon: "assets",
        baseRoute: "/portal/assets",
        requiredPermission: "assets.use",
        enabled: true,
        navigation: [
            {
                label: "Home & Assets",
                items: [
                    { label: "Overview", href: "/portal/assets", icon: "assets" },
                    { label: "All assets", href: "/portal/assets/all", icon: "knowledge" },
                    { label: "Vehicles & trailers", href: "/portal/assets/vehicles", icon: "vehicles" },
                    { label: "Home & property", href: "/portal/assets/property", icon: "property", active: "prefix" },
                ],
            },
            {
                label: "Keep on top of",
                items: [
                    { label: "Maintenance", href: "/portal/assets/maintenance", icon: "maintenance" },
                    { label: "Insurance", href: "/portal/assets/insurance", icon: "insurance" },
                    { label: "Warranties", href: "/portal/assets/warranties", icon: "warranty" },
                    { label: "Documents", href: "/portal/assets/documents", icon: "documents" },
                ],
            },
            {
                label: "Application",
                items: [
                    { label: "Capture and scan", href: "/portal/assets/capture", icon: "scan", active: "prefix" },
                    { label: "Reports and export", href: "/portal/assets/reports", icon: "reports", active: "prefix" },
                    { label: "Settings", href: "/portal/assets/settings", icon: "settings" },
                ],
            },
        ],
    },
] as const satisfies readonly PortalApplication[];

export const applicationById = (id: ApplicationId): PortalApplication | undefined => APPLICATIONS.find((application) => application.id === id);

export const applicationForPath = (path: string): PortalApplication | undefined =>
    APPLICATIONS.find((application) => path === application.baseRoute || path.startsWith(`${application.baseRoute}/`));

export const canAccessApplication = (user: { permissions: readonly Permission[] }, application: PortalApplication): boolean =>
    application.enabled && user.permissions.includes(application.requiredPermission);

export const availableApplications = (user: { permissions: readonly Permission[] }): PortalApplication[] =>
    APPLICATIONS.filter((application) => canAccessApplication(user, application));
