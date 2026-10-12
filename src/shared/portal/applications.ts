import type { FlagKey } from "./flags";
import type { Permission } from "./permissions";

export type ApplicationId = "wedding";

export type ApplicationIcon = "wedding";

export type NavigationIcon =
    | "dashboard"
    | "guests"
    | "households"
    | "rsvps"
    | "events"
    | "communications"
    | "website"
    | "seating"
    | "catering"
    | "tasks"
    | "timeline"
    | "budget"
    | "suppliers"
    | "settings";

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
                    {
                        label: "Communications",
                        href: "/portal/wedding/communications",
                        icon: "communications",
                        flag: "module.communications",
                        active: "prefix",
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
] as const satisfies readonly PortalApplication[];

export const applicationById = (id: ApplicationId): PortalApplication | undefined => APPLICATIONS.find((application) => application.id === id);

export const applicationForPath = (path: string): PortalApplication | undefined =>
    APPLICATIONS.find((application) => path === application.baseRoute || path.startsWith(`${application.baseRoute}/`));

export const canAccessApplication = (user: { permissions: readonly Permission[] }, application: PortalApplication): boolean =>
    application.enabled && user.permissions.includes(application.requiredPermission);

export const availableApplications = (user: { permissions: readonly Permission[] }): PortalApplication[] =>
    APPLICATIONS.filter((application) => canAccessApplication(user, application));
