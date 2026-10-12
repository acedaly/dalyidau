// Application-level roles. Cloudflare Access decides who can reach /portal at all; these decide
// what each verified identity may do once inside. The worker enforces them on every API call, and
// the browser uses the same table only to hide controls the user cannot use.

export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
    "wedding.view",
    "wedding.guests.edit",
    "wedding.rsvp.edit",
    "wedding.comms.edit",
    "wedding.comms.send",
    "wedding.planning.edit",
    "wedding.budget.view",
    "wedding.budget.edit",
    "wedding.website.edit",
    "wedding.export",
    "portal.settings.manage",
    "portal.users.manage",
    "portal.audit.view",
    /** Permanent erasure of personal records and applying retention. Owners only. */
    "portal.data.erase",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
    owner: PERMISSIONS,
    admin: PERMISSIONS.filter((p) => p !== "portal.users.manage" && p !== "portal.data.erase"),
    editor: [
        "wedding.view",
        "wedding.guests.edit",
        "wedding.rsvp.edit",
        "wedding.comms.edit",
        "wedding.planning.edit",
        "wedding.website.edit",
        "portal.audit.view",
    ],
    viewer: ["wedding.view"],
};

export const ROLE_LABELS: Record<Role, { label: string; description: string }> = {
    owner: { label: "Owner", description: "Everything, including managing people and roles, and permanently erasing personal data." },
    admin: { label: "Admin", description: "Everything except managing people and roles, and permanent erasure." },
    editor: { label: "Editor", description: "Guests, RSVPs, planning and the website. No budget, sending or settings." },
    viewer: { label: "Viewer", description: "Read-only access to guests, RSVPs and planning." },
};

export const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);

export const permissionsFor = (role: Role): Permission[] => [...ROLE_PERMISSIONS[role]];
