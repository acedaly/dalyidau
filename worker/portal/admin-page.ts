// The data for one wedding or administration screen shown inside Payload's admin (Phase 3: the portal's
// own pages are retired). Used by the combined Worker's /api/platform/wedding-page (poc/payload/platform/
// bridge.ts) and by the tests. Same sign-in, permission checks and credential redaction as the portal had.
import type { PortalPageData } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { authenticate, can } from "./auth";
import { loadFlags } from "./flags";
import { loadPortalPage } from "./pages";
import { CREDENTIAL_PERMISSION, hideCredentials } from "./redact";
import { getSettings } from "./settings";

/** The pages offered: wedding screens (message pages are /portal/wedding/communications/msg_…), settings sections and the audit log. */
export const ADMIN_PAGE = /^\/portal\/(?:wedding(?:\/[a-z0-9_-]+){0,3}|settings(?:\/[a-z]+)?|audit)$/;

export type AdminPageResult =
    | { ok: true; status: number; title: string; data: PortalPageData }
    | { ok: false; status: 401 | 403 | 404; error: "unauthenticated" | "forbidden" | "not_found" };

/** `page` is the portal path the screen was loaded from, with its query (the audit log's filters). */
export async function loadAdminPage(request: Request, env: Env, page: string): Promise<AdminPageResult> {
    const auth = await authenticate(request, env);
    // As portalApi: the reason is logged by authenticate, never returned.
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.status === 401 ? "unauthenticated" : "forbidden" };
    const pageUrl = new URL(page, new URL(request.url).origin);
    if (!ADMIN_PAGE.test(pageUrl.pathname) || !page.startsWith("/portal/")) return { ok: false, status: 404, error: "not_found" };
    const [flags, wedding] = await Promise.all([loadFlags(env.DB), getSettings(env.DB, "wedding")]);
    const result = await loadPortalPage(pageUrl.pathname, pageUrl, env, auth.user, flags);
    // Viewers never receive RSVP codes or signed links, in page data any more than from the API.
    const pageData = can(auth.user, CREDENTIAL_PERMISSION) ? result.data : hideCredentials(result.data);
    const data = { ...pageData, context: { user: auth.user, flags, wedding, environment: env.ENVIRONMENT } } as PortalPageData;
    return { ok: true, status: result.status, title: result.title, data };
}
