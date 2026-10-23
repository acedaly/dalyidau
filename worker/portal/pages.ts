// Server-side loaders for portal pages. Each returns the data the page needs for its first render;
// after that the page talks to /api/portal directly.
import { type ApplicationId, applicationById, availableApplications, canAccessApplication } from "../../src/shared/portal/applications";
import type { Flags } from "../../src/shared/portal/flags";
import type { Permission } from "../../src/shared/portal/permissions";
import { PORTAL_SETTINGS_TABS, type PortalSettingsTab, canSeeSettingsTab } from "../../src/shared/portal/settings-sections";
import type { PortalRoute, PortalUser } from "../../src/shared/portal/types";
import type { TodayDashboard } from "../../src/shared/today/types";
import { amplenoteStatus } from "../amplenote/api";
import { todayAssets } from "../assets/dashboard";
import { type AssetsPage, loadAssetsPage } from "../assets/pages";
import { preferences as calendarPreferences } from "../calendar/access";
import { occurrencesInWindow } from "../calendar/events";
import { overlaysFor } from "../calendar/holidays";
import { loadLeave } from "../calendar/leave";
import { type CalendarPage, loadCalendarPage } from "../calendar/pages";
import { todayCentre } from "../centre/actions";
import { type CentrePage, loadCentrePage } from "../centre/pages";
import { providerStatus } from "../comms/providers";
import type { Env } from "../env";
import { loadFinancePage } from "../finance/pages";
import { loadIntelligencePage } from "../intelligence/pages";
import { todayDashboard } from "../today/dashboard";
import { loadPlanningHours } from "../today/window";
import { invitationLinksConfigured } from "../wedding/invitations";
import { listMedia } from "../wedding/media";
import { can } from "./auth";
import { cateringSummary } from "./catering";
import { deliveryAvailable, getMessage, listMessages, listSmsThreads } from "./comms";
import { getLayout } from "./dashboard";
import { budgetItemDef, customFieldDef, eventDef, householdDef, listEntities, supplierDef, taskDef, templateDef, timelineDef } from "./entities";
import { listGuests } from "./guests";
import { listHouseholdRows } from "./households";
import { HttpError } from "./http";
import { listImports } from "./import";
import { householdAddressing, listStudioHouseholds } from "./invitation-studio";
import { listDeleted, retentionPreview } from "./privacy";
import { distinctGuestValues, householdResponseCounts, householdResponses, listAudit, listSubmissions } from "./queries";
import { RETIRED_MESSAGE, isRetiredPage } from "./retired";
import { listQuestions, questionSummaries } from "./rsvp-questions";
import { seatingState, seatingTableDef } from "./seating";
import { getSettings } from "./settings";
import { computeStats } from "./stats";
import { travelOverview } from "./travel";
import { listUsers } from "./users";

export interface PortalPageResult {
    data: PortalRoute;
    status: number;
    title: string;
}

interface PageDef {
    pattern: RegExp;
    title: string;
    permission?: Permission;
    application?: ApplicationId;
    flag?: keyof Flags;
    load: (ctx: { env: Env; user: PortalUser; flags: Flags; url: URL; match: RegExpExecArray }) => Promise<PortalRoute | null>;
}

const PAGES: PageDef[] = [
    {
        pattern: /^\/portal$/,
        title: "Applications",
        load: async ({ user }) => ({ route: "portal-home", applications: availableApplications(user).map((application) => application.id) }),
    },
    {
        pattern: /^\/portal\/wedding$/,
        title: "Dashboard",
        permission: "wedding.view",
        application: "wedding",
        load: async ({ env, user, flags }) => {
            const [stats, widgets] = await Promise.all([computeStats(env.DB, user, flags), getLayout(env.DB, user.email)]);
            return { route: "dashboard", stats, widgets };
        },
    },
    {
        pattern: /^\/portal\/wedding\/guests$/,
        title: "Guests",
        permission: "wedding.view",
        application: "wedding",
        load: async ({ env }) => {
            const [guests, households, events, customFields, catering, tables] = await Promise.all([
                listGuests(env.DB),
                listEntities(env.DB, householdDef),
                listEntities(env.DB, eventDef),
                listEntities(env.DB, customFieldDef),
                getSettings(env.DB, "catering"),
                listEntities(env.DB, seatingTableDef),
            ]);
            return {
                route: "guests",
                guests,
                households: households.map((h) => ({ id: h.id, name: h.name })),
                events,
                customFields,
                mealCategories: catering.categories,
                tables: tables.map((t) => ({ id: t.id, name: t.name, capacity: t.capacity })),
            };
        },
    },
    {
        pattern: /^\/portal\/wedding\/guests\/import$/,
        title: "Import guests",
        permission: "wedding.guests.edit",
        application: "wedding",
        load: async ({ env }) => {
            const [guests, households, imports] = await Promise.all([listGuests(env.DB), listEntities(env.DB, householdDef), listImports(env.DB)]);
            return {
                route: "guest-import",
                households: households.map((h) => ({ id: h.id, name: h.name, externalId: h.externalId })),
                guests: guests.map((g) => ({ id: g.id, name: `${g.firstName} ${g.lastName}`.trim(), householdName: g.householdName })),
                imports,
            };
        },
    },
    {
        pattern: /^\/portal\/wedding\/households$/,
        title: "Households",
        permission: "wedding.view",
        application: "wedding",
        load: async ({ env }) => {
            const [households, events, emailDelivery] = await Promise.all([
                listHouseholdRows(env),
                listEntities(env.DB, eventDef),
                deliveryAvailable(env, env.DB),
            ]);
            return {
                route: "households",
                households,
                events: events.map((event) => ({ id: event.id, name: event.name })),
                emailDelivery,
                canGenerateLinks: invitationLinksConfigured(env),
            };
        },
    },
    {
        pattern: /^\/portal\/wedding\/events$/,
        title: "Events",
        permission: "wedding.view",
        application: "wedding",
        load: async ({ env }) => ({ route: "events", events: await listEntities(env.DB, eventDef) }),
    },
    {
        pattern: /^\/portal\/wedding\/rsvps$/,
        title: "RSVPs",
        permission: "wedding.view",
        application: "wedding",
        load: async ({ env, user, flags }) => {
            const [events, stats, submissions, settings, households, questions, summaries, travel] = await Promise.all([
                listEntities(env.DB, eventDef),
                computeStats(env.DB, user, flags),
                listSubmissions(env.DB),
                getSettings(env.DB, "rsvp"),
                householdResponseCounts(env.DB),
                listQuestions(env.DB),
                questionSummaries(env.DB),
                travelOverview(env.DB),
            ]);
            return { route: "rsvps", events, stats, submissions, settings, households, questions, summaries, travel };
        },
    },
    {
        pattern: /^\/portal\/wedding\/invitations$/,
        title: "Invitation Studio",
        permission: "wedding.view",
        application: "wedding",
        load: async ({ env }) => {
            const [households, template] = await Promise.all([listStudioHouseholds(env.DB), getSettings(env.DB, "invitation")]);
            return { route: "invitation-studio", households, template, canGenerateLinks: invitationLinksConfigured(env) };
        },
    },
    {
        pattern: /^\/portal\/wedding\/communications\/providers$/,
        title: "Email & SMS providers",
        permission: "portal.settings.manage",
        application: "wedding",
        flag: "module.communications",
        load: async ({ env }) => ({
            route: "provider-settings",
            status: providerStatus(env),
            emailEnabled: await deliveryAvailable(env, env.DB, "email"),
            smsEnabled: await deliveryAvailable(env, env.DB, "sms"),
            comms: await getSettings(env.DB, "comms"),
        }),
    },
    {
        pattern: /^\/portal\/wedding\/communications$/,
        title: "Communications",
        permission: "wedding.view",
        application: "wedding",
        flag: "module.communications",
        load: async ({ env }) => {
            const [templates, messages, events, values, available, sms, unread, studio, homes, addressing, responses, sentBy, media] = await Promise.all([
                listEntities(env.DB, templateDef),
                listMessages(env.DB),
                listEntities(env.DB, eventDef),
                distinctGuestValues(env.DB),
                deliveryAvailable(env, env.DB),
                deliveryAvailable(env, env.DB, "sms"),
                env.DB.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE direction = 'inbound' AND read_at IS NULL").first<{ n: number }>(),
                getSettings(env.DB, "studio"),
                env.DB.prepare("SELECT id, name FROM households WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE").all<{ id: string; name: string }>(),
                householdAddressing(env.DB),
                householdResponses(env.DB),
                env.DB.prepare(
                    `SELECT m.category, COUNT(DISTINCT mr.household_id) AS n FROM message_recipients mr JOIN messages m ON m.id = mr.message_id
                     WHERE mr.status = 'sent' AND mr.household_id IS NOT NULL GROUP BY m.category`,
                ).all<{ category: string; n: number }>(),
                listMedia(env.DB),
            ]);
            const sent = new Map(sentBy.results.map((r) => [r.category, Number(r.n)]));
            return {
                route: "communications",
                templates,
                messages,
                events,
                groups: values.groups,
                tags: values.tags,
                deliveryAvailable: available,
                comms: { status: providerStatus(env), email: available, sms },
                unreadTexts: Number(unread?.n ?? 0),
                studio,
                campaignProgress: {
                    sent: {
                        save_the_date: sent.get("save_the_date") ?? 0,
                        invitation: sent.get("invitation") ?? 0,
                        reminder: sent.get("reminder") ?? 0,
                        final_details: sent.get("final_details") ?? 0,
                        thank_you: sent.get("thank_you") ?? 0,
                    },
                    households: [...responses.values()].filter((r) => r.status !== "not_invited").length,
                },
                households: homes.results.map((h) => ({
                    id: h.id,
                    name: h.name,
                    line: addressing.get(h.id)?.recipientLine || h.name,
                    status: responses.get(h.id)?.status ?? "not_invited",
                    attending: responses.get(h.id)?.attending ?? 0,
                })),
                photos: media.map((m) => ({ id: m.id, url: m.url, alt: m.alt })),
                guests: (
                    await env.DB.prepare(
                        "SELECT id, TRIM(first_name || ' ' || COALESCE(last_name, '')) AS name, household_id FROM guests WHERE deleted_at IS NULL ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE",
                    ).all<{ id: string; name: string; household_id: string | null }>()
                ).results.map((g) => ({ id: g.id, name: g.name, householdId: g.household_id })),
            };
        },
    },
    {
        pattern: /^\/portal\/wedding\/communications\/texts$/,
        title: "Text messages",
        // Conversations hold guests' own words: the communications permission, not just viewing.
        permission: "wedding.comms.edit",
        application: "wedding",
        flag: "module.communications",
        load: async ({ env }) => {
            const [threads, email, sms] = await Promise.all([listSmsThreads(env.DB), deliveryAvailable(env, env.DB), deliveryAvailable(env, env.DB, "sms")]);
            return { route: "texts", threads, status: providerStatus(env), emailAvailable: email, smsAvailable: sms };
        },
    },
    {
        pattern: /^\/portal\/wedding\/communications\/(msg_[a-z0-9]+)$/,
        title: "Message",
        permission: "wedding.view",
        application: "wedding",
        flag: "module.communications",
        load: async ({ env, match }) => {
            const found = await getMessage(env.DB, match[1]);
            if (!found) return null;
            return { route: "message", ...found, deliveryAvailable: await deliveryAvailable(env, env.DB, found.message.channel) };
        },
    },
    {
        pattern: /^\/portal\/wedding\/tasks$/,
        title: "Tasks",
        permission: "wedding.view",
        application: "wedding",
        flag: "module.planning",
        load: async ({ env }) => {
            const [tasks, users] = await Promise.all([listEntities(env.DB, taskDef), listUsers(env, env.DB)]);
            return { route: "tasks", tasks, assignees: users.filter((u) => u.active).map((u) => ({ email: u.email, name: u.name })) };
        },
    },
    {
        pattern: /^\/portal\/wedding\/timeline$/,
        title: "Timeline",
        permission: "wedding.view",
        application: "wedding",
        flag: "module.planning",
        load: async ({ env }) => ({ route: "timeline", items: await listEntities(env.DB, timelineDef) }),
    },
    {
        pattern: /^\/portal\/wedding\/seating$/,
        title: "Seating",
        permission: "wedding.view",
        application: "wedding",
        flag: "module.planning",
        load: async ({ env, user }) => ({ route: "seating", state: await seatingState(env.DB), canEdit: can(user, "wedding.planning.edit") }),
    },
    {
        pattern: /^\/portal\/wedding\/catering$/,
        title: "Catering",
        permission: "wedding.view",
        application: "wedding",
        flag: "module.planning",
        load: async ({ env }) => {
            const [summary, events] = await Promise.all([cateringSummary(env.DB), listEntities(env.DB, eventDef)]);
            return { route: "catering", summary, events: events.map((e) => ({ id: e.id, name: e.name })) };
        },
    },
    {
        pattern: /^\/portal\/wedding\/budget$/,
        title: "Budget",
        permission: "wedding.budget.view",
        application: "wedding",
        flag: "module.budget",
        load: async ({ env }) => {
            const [items, suppliers, settings] = await Promise.all([
                listEntities(env.DB, budgetItemDef),
                listEntities(env.DB, supplierDef),
                getSettings(env.DB, "budget"),
            ]);
            return { route: "budget", items, suppliers: suppliers.map((s) => ({ id: s.id, name: s.name })), settings };
        },
    },
    {
        pattern: /^\/portal\/wedding\/suppliers$/,
        title: "Suppliers",
        permission: "wedding.budget.view",
        application: "wedding",
        flag: "module.budget",
        load: async ({ env }) => ({ route: "suppliers", suppliers: await listEntities(env.DB, supplierDef) }),
    },
    {
        pattern: /^\/portal\/wedding\/website$/,
        title: "Website",
        permission: "wedding.view",
        application: "wedding",
        load: async ({ env }) => {
            const [content, published, media, events, rsvp] = await Promise.all([
                getSettings(env.DB, "website_draft"),
                getSettings(env.DB, "website"),
                listMedia(env.DB),
                listEntities(env.DB, eventDef),
                getSettings(env.DB, "rsvp"),
            ]);
            return { route: "website", content, published, media, events, rsvp };
        },
    },
    {
        pattern: /^\/portal\/wedding\/settings(?:\/(general|fields))?$/,
        title: "Wedding settings",
        permission: "wedding.view",
        application: "wedding",
        load: async ({ env, match }) => {
            const tab = (match[1] ?? "general") as "general" | "fields";
            return { route: "wedding-settings", tab, customFields: await listEntities(env.DB, customFieldDef) };
        },
    },
    {
        pattern: new RegExp(`^/portal/settings(?:/(${PORTAL_SETTINGS_TABS.join("|")}))?$`),
        title: "Portal settings",
        load: async ({ env, user, match }) => {
            const requested = (match[1] ?? "general") as PortalSettingsTab;
            const [users, privacy, deleted, retention, website] = await Promise.all([
                can(user, "portal.users.manage") ? listUsers(env, env.DB) : Promise.resolve(null),
                getSettings(env.DB, "privacy"),
                can(user, "wedding.guests.edit") ? listDeleted(env.DB) : Promise.resolve(null),
                can(user, "portal.data.erase") ? retentionPreview(env.DB) : Promise.resolve(null),
                can(user, "portal.settings.manage") ? amplenoteStatus(env) : Promise.resolve(null),
            ]);
            // A section this person can't see opens General instead, as before.
            const tab = canSeeSettingsTab(user, requested) ? requested : "general";
            const status = providerStatus(env);
            const integrations = can(user, "portal.settings.manage")
                ? {
                      email: status.email,
                      sms: status.sms,
                      webhooks: status.webhooks,
                      mcp: !!env.MCP_ACCESS_AUD,
                      calendarEncryption: !!env.CALENDAR_ENCRYPTION_KEY,
                  }
                : null;
            return { route: "portal-settings", tab, users, privacy: deleted ? { settings: privacy, deleted, retention } : null, integrations, website };
        },
    },
    // Daly Calendar. The application's permission is checked here; calendar membership in the loaders.
    {
        pattern: /^\/portal\/calendar$/,
        title: "Calendar",
        application: "calendar",
        load: ({ env, user, url, flags }) => loadCalendarPage(env, user, url, "view", flags),
    },
    {
        pattern: /^\/portal\/calendar\/(year|family|leave|calendars|subscriptions|holidays|settings)$/,
        title: "Calendar",
        application: "calendar",
        load: ({ env, user, url, match, flags }) => loadCalendarPage(env, user, url, match[1] as CalendarPage, flags),
    },
    {
        pattern: /^\/portal\/calendar\/leave\/(planner|settings)$/,
        title: "Leave",
        application: "calendar",
        load: ({ env, user, url, match, flags }) => loadCalendarPage(env, user, url, `leave-${match[1]}` as CalendarPage, flags),
    },
    // Daly Intelligence. The application's permission is checked here; everything in it is the caller's own.
    {
        pattern: /^\/portal\/intelligence$/,
        title: "Intelligence",
        application: "intelligence",
        load: ({ env, user }) => loadIntelligencePage(env, user, "home"),
    },
    {
        pattern: /^\/portal\/intelligence\/settings$/,
        title: "Intelligence",
        application: "intelligence",
        load: ({ env, user }) => loadIntelligencePage(env, user, "settings"),
    },
    {
        pattern: /^\/portal\/intelligence\/briefing(\/weekly)?$/,
        title: "Briefing",
        application: "intelligence",
        load: ({ env, user, match }) => loadIntelligencePage(env, user, match[1] ? "weekly" : "briefing"),
    },
    // Intelligence Centre. The application's permission is checked here; ownership of watch areas and wallboards in the loaders.
    {
        pattern: /^\/portal\/intelligence-centre$/,
        title: "Intelligence Centre",
        application: "intelligence-centre",
        load: ({ env, user, url }) => loadCentrePage(env, user, url, "overview"),
    },
    {
        pattern:
            /^\/portal\/intelligence-centre\/(map|records|history|briefings|watches|wallboards|sources|settings|changes|timeline|replay|analytics|correlations|rules|reports|assistant)$/,
        title: "Intelligence Centre",
        application: "intelligence-centre",
        load: ({ env, user, url, match }) => loadCentrePage(env, user, url, match[1] as CentrePage),
    },
    {
        pattern: /^\/portal\/intelligence-centre\/records\/(icr_[a-z0-9]{14})$/,
        title: "Record",
        application: "intelligence-centre",
        load: ({ env, user, url, match }) => loadCentrePage(env, user, url, "record", match[1]),
    },
    {
        pattern: /^\/portal\/intelligence-centre\/wallboards\/(icb_[a-z0-9]{14})$/,
        title: "Wallboard",
        application: "intelligence-centre",
        load: ({ env, user, url, match }) => loadCentrePage(env, user, url, "wallboard", match[1]),
    },
    {
        pattern: /^\/portal\/intelligence-centre\/reports\/(icp_[a-z0-9]{14})$/,
        title: "Situation report",
        application: "intelligence-centre",
        load: ({ env, user, url, match }) => loadCentrePage(env, user, url, "report", match[1]),
    },
    {
        pattern: /^\/portal\/intelligence-centre\/hazards\/(weather|fire-danger|flood|transport|environment|infrastructure)$/,
        title: "Hazards",
        application: "intelligence-centre",
        load: ({ env, user, url, match }) => loadCentrePage(env, user, url, "hazards", match[1]),
    },
    // Household Finance. The application's permission is checked here; each account's visibility in the loaders.
    {
        pattern: /^\/portal\/finance$/,
        title: "Household Finance",
        application: "finance",
        load: ({ env, user, url }) => loadFinancePage(env, user, url, "overview"),
    },
    {
        pattern: /^\/portal\/finance\/(transactions|accounts|import|settings)$/,
        title: "Household Finance",
        application: "finance",
        load: ({ env, user, url, match }) => loadFinancePage(env, user, url, match[1] as "transactions" | "accounts" | "import" | "settings"),
    },
    {
        pattern: /^\/portal\/finance\/accounts\/(fac_[a-z0-9]{14})$/,
        title: "Account",
        application: "finance",
        load: ({ env, user, url, match }) => loadFinancePage(env, user, url, "account", match[1]),
    },
    {
        pattern: /^\/portal\/finance\/import\/(fim_[a-z0-9]{14})$/,
        title: "Review import",
        application: "finance",
        load: ({ env, user, url, match }) => loadFinancePage(env, user, url, "import-review", match[1]),
    },
    // Home & Assets. The application's permission is checked here; each asset's own rights in the loaders.
    {
        pattern: /^\/portal\/assets$/,
        title: "Home & Assets",
        application: "assets",
        load: ({ env, user, url }) => loadAssetsPage(env, user, url, "overview"),
    },
    {
        pattern: /^\/portal\/assets\/(all|vehicles|property|maintenance|insurance|warranties|documents|reports|settings|capture|labels|search)$/,
        title: "Home & Assets",
        application: "assets",
        load: ({ env, user, url, match }) => loadAssetsPage(env, user, url, match[1] as AssetsPage),
    },
    {
        pattern: /^\/portal\/assets\/reports\/register$/,
        title: "Asset register",
        application: "assets",
        load: ({ env, user, url }) => loadAssetsPage(env, user, url, "register"),
    },
    {
        pattern: /^\/portal\/assets\/item\/(ast_[a-z0-9]{14})$/,
        title: "Asset",
        application: "assets",
        load: ({ env, user, url, match }) => loadAssetsPage(env, user, url, "item", match[1]),
    },
    {
        pattern: /^\/portal\/assets\/property\/(alo_[a-z0-9]{14})$/,
        title: "Place",
        application: "assets",
        load: ({ env, user, url, match }) => loadAssetsPage(env, user, url, "location", match[1]),
    },
    // Today: needs Calendar; everything is read through Calendar's own access.
    {
        pattern: /^\/portal\/today$/,
        title: "Today",
        permission: "calendar.use",
        load: async ({ env, user, url }) => {
            const dashboard = (await todayDashboard(env.DB, user, { date: url.searchParams.get("date") }).catch((error: unknown) => {
                // A malformed or far-off ?date= opens today instead.
                if (error instanceof HttpError && error.status === 400) return todayDashboard(env.DB, user, {});
                throw error;
            })) as TodayDashboard;
            const [planningHours, calendarPrefs, leave] = await Promise.all([
                loadPlanningHours(env.DB, user.email),
                calendarPreferences(env.DB, user.email),
                loadLeave(env.DB, user),
            ]);
            const { date } = dashboard;
            const [{ occurrences }, overlays] = await Promise.all([
                occurrencesInWindow(env.DB, user, { from: date, to: date, timeZone: dashboard.timeZone }),
                overlaysFor(env.DB, user, calendarPrefs, leave, date, date),
            ]);
            return {
                route: "today",
                dashboard,
                planningHours,
                occurrences,
                overlays,
                workingHoursStart: calendarPrefs.workingHours.start,
                // A failure here never stops Today from loading.
                centre: await todayCentre(env, user).catch(() => null),
                // Home & Assets: only what the person's own settings ask for; a failure never stops Today.
                assets: await todayAssets(env.DB, user).catch(() => null),
            };
        },
    },
    {
        pattern: /^\/portal\/audit$/,
        title: "Audit log",
        permission: "portal.audit.view",
        load: async ({ env, url }) => ({ route: "audit", ...(await listAudit(env.DB, url)) }),
    },
];

export async function loadPortalPage(path: string, url: URL, env: Env, user: PortalUser, flags: Flags): Promise<PortalPageResult> {
    // Retired applications: a clear answer, never their records (./retired.ts).
    if (isRetiredPage(path)) return { data: { route: "forbidden", message: RETIRED_MESSAGE }, status: 410, title: "Retired" };
    for (const page of PAGES) {
        const match = page.pattern.exec(path);
        if (!match) continue;
        const application = page.application ? applicationById(page.application) : undefined;
        if (page.application && (!application || !canAccessApplication(user, application))) {
            return { data: { route: "forbidden", message: "You don't have access to this application." }, status: 403, title: "No access" };
        }
        if (page.permission && !can(user, page.permission)) {
            return { data: { route: "forbidden", message: "Your role doesn't include this part of the portal." }, status: 403, title: "No access" };
        }
        if (page.flag && !flags[page.flag]) {
            return {
                data: { route: "forbidden", message: "This module is switched off. An owner or admin can turn it on in Portal settings → Features." },
                status: 404,
                title: page.title,
            };
        }
        const data = await page.load({ env, user, flags, url, match });
        if (data) return { data, status: 200, title: page.title };
        break;
    }
    return { data: { route: "not-found", path }, status: 404, title: "Not found" };
}
