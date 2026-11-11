// Where each retired /portal page lives in Payload's admin (docs/PAYLOAD-NEXT.md, Phase 3). Shared by
// the Worker (redirects for bookmarks and links already sent) and the Payload views (links inside the
// screens). Only human-facing pages map; /api/portal/* is the admin's API and is never redirected.
import { PORTAL_SETTINGS_TABS, SETTINGS_REDIRECTS } from "./settings-sections";

/** A path below /admin/wedding (without the leading slash): '' is the wedding dashboard. */
export const WEDDING_SCREEN =
    /^(?:|guests(?:\/import)?|households|events|rsvps|invitations|communications(?:\/providers|\/texts|\/msg_[a-z0-9]+)?|tasks|timeline|seating|catering|budget|suppliers|website|settings(?:\/general|\/fields)?)$/;

/** A path below /admin/administration: '' is General; `audit` is the audit log. */
export const ADMINISTRATION_SCREEN = new RegExp(`^(?:|${PORTAL_SETTINGS_TABS.filter((t) => t !== "general").join("|")}|audit)$`);

export const weddingAdminPath = (screen: string) => (screen ? `/admin/wedding/${screen}` : "/admin/wedding");
export const administrationPath = (screen: string) => (screen ? `/admin/administration/${screen}` : "/admin/administration");

/** The portal page (as its loader knows it) for an Administration screen. */
export const portalPathForAdministration = (screen: string) => (screen === "audit" ? "/portal/audit" : screen ? `/portal/settings/${screen}` : "/portal/settings");

/** The draft preview of the wedding website: a rendered wedding page, not admin chrome; it stays at this address. */
export const WEDDING_PREVIEW = /^\/portal\/wedding\/website\/preview(\/rsvp)?$/;

/**
 * The Payload address for an old portal address (path, plus its ?query and #fragment), or null when it
 * isn't a portal page. Unknown portal pages go to the admin's home rather than a 404, unless `strict`
 * (links inside screens: only real screens are rewritten, anything else is left as it is).
 */
export function adminPathForPortal(href: string, { strict = false }: { strict?: boolean } = {}): string | null {
    const m = /^(\/portal(?:\/[^?#]*)?)([?#].*)?$/.exec(href);
    if (!m) return null;
    let path = m[1].replace(/\/+$/, "") || "/portal";
    let rest = m[2] ?? "";
    const moved = Object.hasOwn(SETTINGS_REDIRECTS, path) ? SETTINGS_REDIRECTS[path] : null;
    if (moved) {
        const [p, f] = moved.split("#");
        path = p;
        if (f && !rest) rest = `#${f}`;
    }
    if (WEDDING_PREVIEW.test(path)) return null;
    if (path === "/portal/wedding") return weddingAdminPath("") + rest;
    if (path === "/portal" || path === "/portal/planner" || path.startsWith("/portal/planner/")) return strict ? null : weddingAdminPath("");
    const wedding = /^\/portal\/wedding\/(.+)$/.exec(path);
    if (wedding) return WEDDING_SCREEN.test(wedding[1]) ? weddingAdminPath(wedding[1]) + rest : strict ? null : weddingAdminPath("");
    if (path === "/portal/audit") return administrationPath("audit") + rest;
    const settings = /^\/portal\/settings(?:\/(.+))?$/.exec(path);
    if (settings) {
        const tab = settings[1] ?? "";
        if (ADMINISTRATION_SCREEN.test(tab) && tab !== "audit") return administrationPath(tab === "general" ? "" : tab) + rest;
        return strict ? null : administrationPath("");
    }
    return strict ? null : "/admin";
}
