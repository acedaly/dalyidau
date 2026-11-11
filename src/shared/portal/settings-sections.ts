// Portal settings: its sections, who sees each one, and which part of the portal each feature
// switch belongs to. The worker uses the same table to decide which section a URL may open, so a
// section someone can't see falls back to General rather than rendering empty.
//
// Feature switches are stored once (feature_flags, defaults in ./flags) and changed in one place,
// Administration → Features. Other pages only show their state and link there.
import { type ApplicationId, applicationById, canAccessApplication } from "./applications";
import { FLAG_DEFINITIONS, FLAG_KEYS, type FlagKey } from "./flags";
import type { Permission } from "./permissions";

export const PORTAL_SETTINGS_TABS = ["general", "access", "features", "website", "security", "privacy"] as const;
export type PortalSettingsTab = (typeof PORTAL_SETTINGS_TABS)[number];

export interface PortalSettingsSection {
    label: string;
    description: string;
    /** Shown only to people who can open at least one of these applications. */
    applications?: readonly ApplicationId[];
    permission?: Permission;
}

export const PORTAL_SETTINGS_SECTIONS: Record<PortalSettingsTab, PortalSettingsSection> = {
    general: { label: "General", description: "Who you're signed in as." },
    access: { label: "Users and permissions", description: "Roles, what each role can open, and the people who can sign in." },
    features: { label: "Features", description: "Switches that turn parts of the site and the wedding admin on or off for everyone. Every change is audited." },
    website: {
        label: "Capacities archive",
        description: "The blog's articles from Capacities: whether Capacities sync is on, and the copy of every article kept in Cloudflare.",
        permission: "portal.settings.manage",
    },
    security: { label: "Integrations and security", description: "Sign-in, email and SMS providers and the audit log." },
    privacy: { label: "Privacy", description: "Deleted guest records and retention.", permission: "wedding.guests.edit" },
};

export const isPortalSettingsTab = (value: unknown): value is PortalSettingsTab =>
    typeof value === "string" && (PORTAL_SETTINGS_TABS as readonly string[]).includes(value);

export const portalSettingsPath = (tab: PortalSettingsTab) => (tab === "general" ? "/portal/settings" : `/portal/settings/${tab}`);

export const canSeeSettingsTab = (user: { permissions: readonly Permission[] }, tab: PortalSettingsTab): boolean => {
    const section = PORTAL_SETTINGS_SECTIONS[tab];
    if (section.permission && !user.permissions.includes(section.permission)) return false;
    if (!section.applications) return true;
    return section.applications.some((id) => {
        const application = applicationById(id);
        return !!application && canAccessApplication(user, application);
    });
};

export const visibleSettingsTabs = (user: { permissions: readonly Permission[] }) => PORTAL_SETTINGS_TABS.filter((tab) => canSeeSettingsTab(user, tab));

/** Old settings addresses, kept working for bookmarks and links already shared. */
export const SETTINGS_REDIRECTS: Record<string, string> = {
    "/portal/settings/people": "/portal/settings/access",
    "/portal/settings/fields": "/portal/wedding/settings/fields",
    "/portal/wedding/settings/features": "/portal/settings/features#features-wedding",
    // Retired applications' sections went with them (docs/DECOMMISSION_KNOWLEDGE_TASKS.md, DECOMMISSION_PORTAL_APPS.md).
    "/portal/settings/knowledge": "/portal/settings",
    "/portal/settings/tasks": "/portal/settings",
    "/portal/settings/calendar": "/portal/settings",
    "/portal/settings/intelligence": "/portal/settings",
};

// --- Feature switches by area ----------------------------------------------------------------------

export const FEATURE_AREAS = ["wedding", "website"] as const;
export type FeatureArea = (typeof FEATURE_AREAS)[number];

/** An area belongs to an application, or (for the public website, which isn't one) needs a permission. */
export type FeatureAreaDetails = { label: string; description: string } & ({ application: ApplicationId } | { permission: Permission });

export const FEATURE_AREA_DETAILS: Record<FeatureArea, FeatureAreaDetails> = {
    wedding: {
        label: "Wedding",
        description: "The public website and Save the Date page, native RSVP, guest email and SMS, and which wedding modules are on.",
        application: "wedding",
    },
    website: {
        label: "Website",
        description: "The projects-first homepage, and whether the blog keeps in sync with Capacities (details in Administration → Capacities archive).",
        permission: "portal.settings.manage",
    },
};

/** Whether someone sees an area's switches: they can open its application, or hold its permission. */
export const canSeeFeatureArea = (user: { permissions: readonly Permission[] }, area: FeatureArea): boolean => {
    const details = FEATURE_AREA_DETAILS[area];
    if ("permission" in details) return user.permissions.includes(details.permission);
    const application = applicationById(details.application);
    return !!application && canAccessApplication(user, application);
};

/** Every switch belongs to exactly one area; adding a switch without placing it here won't compile. */
export const FLAG_AREAS: Record<FlagKey, FeatureArea> = {
    "wedding.site.public": "wedding",
    "wedding.save_the_date.public": "wedding",
    "rsvp.native": "wedding",
    "communications.delivery": "wedding",
    "communications.sms": "wedding",
    "module.communications": "wedding",
    "module.planning": "wedding",
    "module.budget": "wedding",
    "website.capacities.sync": "website",
    "website.projects_home": "website",
};

export const flagsInArea = (area: FeatureArea): FlagKey[] => FLAG_KEYS.filter((key) => FLAG_AREAS[key] === area);

/** The switch groups within an area (e.g. Website, RSVP), in definition order. */
export const flagGroupsInArea = (area: FeatureArea) => [...new Set(flagsInArea(area).map((key) => FLAG_DEFINITIONS[key].group))];

export const featuresHref = (area?: FeatureArea) => `/portal/settings/features${area ? `#features-${area}` : ""}`;
