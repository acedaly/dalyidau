import type { FlagKey } from "./flags";
import type { Permission } from "./permissions";

export type ApplicationId = "wedding" | "knowledge" | "tasks";

export type ApplicationIcon = "wedding" | "knowledge" | "tasks";

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
    | "home"
    | "inbox"
    | "knowledge"
    | "search"
    | "types"
    | "archive"
    | "trash"
    | "daily"
    | "favourites"
    | "collections"
    | "templates"
    | "discover"
    | "today"
    | "upcoming"
    | "overdue"
    | "completed"
    | "projects"
    | "shared"
    | "labels"
    | "filters"
    | "activity"
    | "project"
    | "mine"
    | "goals"
    | "routines"
    | "workload"
    | "reports";

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
        id: "knowledge",
        name: "Daly Knowledge",
        description: "Notes, people, projects, meetings and decisions, linked together and searchable. Private to you unless you share a space.",
        icon: "knowledge",
        baseRoute: "/portal/knowledge",
        requiredPermission: "knowledge.use",
        enabled: true,
        navigation: [
            {
                label: "Knowledge",
                items: [
                    { label: "Home", href: "/portal/knowledge", icon: "home" },
                    { label: "Today", href: "/portal/knowledge/daily", icon: "daily", active: "prefix" },
                    { label: "Inbox", href: "/portal/knowledge/inbox", icon: "inbox" },
                    { label: "Search", href: "/portal/knowledge/search", icon: "search" },
                ],
            },
            {
                label: "Library",
                items: [
                    { label: "All knowledge", href: "/portal/knowledge/all", icon: "knowledge" },
                    { label: "Favourites", href: "/portal/knowledge/favourites", icon: "favourites" },
                    { label: "Collections", href: "/portal/knowledge/collections", icon: "collections" },
                    { label: "Discover", href: "/portal/knowledge/discover", icon: "discover" },
                ],
            },
            {
                label: "Organise",
                items: [
                    { label: "Object types", href: "/portal/knowledge/types", icon: "types" },
                    { label: "Templates", href: "/portal/knowledge/templates", icon: "templates", active: "prefix" },
                    { label: "Archive", href: "/portal/knowledge/archive", icon: "archive" },
                    { label: "Trash", href: "/portal/knowledge/trash", icon: "trash" },
                ],
            },
            {
                label: "Application",
                items: [{ label: "Settings and export", href: "/portal/knowledge/settings", icon: "settings" }],
            },
        ],
    },
    {
        id: "tasks",
        name: "Daly Tasks",
        description:
            "Tasks, projects, goals and household routines, personal and shared, with a dashboard, reviews, reports and links to Knowledge. Private to you unless you share.",
        icon: "tasks",
        baseRoute: "/portal/tasks",
        requiredPermission: "tasks.use",
        enabled: true,
        navigation: [
            {
                label: "My tasks",
                items: [
                    { label: "Dashboard", href: "/portal/tasks/dashboard", icon: "dashboard" },
                    { label: "Inbox", href: "/portal/tasks/inbox", icon: "inbox" },
                    { label: "Today", href: "/portal/tasks/today", icon: "today" },
                    { label: "Upcoming", href: "/portal/tasks/upcoming", icon: "upcoming" },
                    { label: "All my tasks", href: "/portal/tasks/mine", icon: "mine" },
                    { label: "Overdue", href: "/portal/tasks/overdue", icon: "overdue" },
                    { label: "Completed", href: "/portal/tasks/completed", icon: "completed" },
                ],
            },
            {
                label: "Organise",
                items: [
                    { label: "My projects", href: "/portal/tasks/projects", icon: "projects" },
                    { label: "Shared projects", href: "/portal/tasks/projects?kind=shared", icon: "shared" },
                    { label: "Goals", href: "/portal/tasks/goals", icon: "goals" },
                    { label: "Routines", href: "/portal/tasks/routines", icon: "routines" },
                    { label: "Labels", href: "/portal/tasks/labels", icon: "labels" },
                    { label: "Filters", href: "/portal/tasks/filters", icon: "filters" },
                    { label: "Templates", href: "/portal/tasks/templates", icon: "templates" },
                ],
            },
            {
                label: "Plan and review",
                items: [
                    { label: "Workload", href: "/portal/tasks/workload", icon: "workload" },
                    { label: "Reports", href: "/portal/tasks/reports", icon: "reports" },
                ],
            },
            {
                label: "Application",
                items: [
                    { label: "Search", href: "/portal/tasks/search", icon: "search" },
                    { label: "Activity", href: "/portal/tasks/activity", icon: "activity" },
                    { label: "Settings and export", href: "/portal/tasks/settings", icon: "settings" },
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
