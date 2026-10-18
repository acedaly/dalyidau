// Server-side loaders for portal pages. Each returns the data the page needs for its first render;
// after that the page talks to /api/portal directly.
import { type ApplicationId, applicationById, availableApplications, canAccessApplication } from "../../src/shared/portal/applications";
import type { Flags } from "../../src/shared/portal/flags";
import type { Permission } from "../../src/shared/portal/permissions";
import { PORTAL_SETTINGS_TABS, type PortalSettingsTab, canSeeSettingsTab } from "../../src/shared/portal/settings-sections";
import type { PortalRoute, PortalUser } from "../../src/shared/portal/types";
import { type CalendarPage, loadCalendarPage } from "../calendar/pages";
import { providerStatus } from "../comms/providers";
import type { Env } from "../env";
import { loadIntelligencePage } from "../intelligence/pages";
import { loadKnowledgePage } from "../knowledge/pages";
import { type TasksPage, loadTasksPage } from "../tasks/pages";
import { invitationLinksConfigured } from "../wedding/invitations";
import { listMedia } from "../wedding/media";
import { can } from "./auth";
import { cateringSummary } from "./catering";
import { deliveryAvailable, getMessage, listMessages, listSmsThreads } from "./comms";
import { getLayout } from "./dashboard";
import { budgetItemDef, customFieldDef, eventDef, householdDef, listEntities, supplierDef, taskDef, templateDef, timelineDef } from "./entities";
import { listGuests } from "./guests";
import { listHouseholdRows } from "./households";
import { listImports } from "./import";
import { householdAddressing, listStudioHouseholds } from "./invitation-studio";
import { listDeleted, retentionPreview } from "./privacy";
import { distinctGuestValues, householdResponseCounts, householdResponses, listAudit, listSubmissions } from "./queries";
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
            const [users, privacy, deleted, retention] = await Promise.all([
                can(user, "portal.users.manage") ? listUsers(env, env.DB) : Promise.resolve(null),
                getSettings(env.DB, "privacy"),
                can(user, "wedding.guests.edit") ? listDeleted(env.DB) : Promise.resolve(null),
                can(user, "portal.data.erase") ? retentionPreview(env.DB) : Promise.resolve(null),
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
            return { route: "portal-settings", tab, users, privacy: deleted ? { settings: privacy, deleted, retention } : null, integrations };
        },
    },
    // Daly Knowledge. The application's permission is checked here; space membership in the loaders.
    {
        pattern: /^\/portal\/knowledge$/,
        title: "Knowledge",
        application: "knowledge",
        load: ({ env, user, url }) => loadKnowledgePage(env, user, url, "home"),
    },
    {
        pattern: /^\/portal\/knowledge\/(inbox|all|archive|trash)$/,
        title: "Knowledge",
        application: "knowledge",
        load: ({ env, user, url, match }) => loadKnowledgePage(env, user, url, "list", match[1]),
    },
    {
        pattern: /^\/portal\/knowledge\/o\/(kob_[a-z0-9]{14})$/,
        title: "Knowledge",
        application: "knowledge",
        load: ({ env, user, url, match }) => loadKnowledgePage(env, user, url, "object", match[1]),
    },
    {
        pattern: /^\/portal\/knowledge\/daily(?:\/(\d{4}-\d{2}-\d{2}))?$/,
        title: "Daily note",
        application: "knowledge",
        load: ({ env, user, url, match }) => loadKnowledgePage(env, user, url, "daily", match[1]),
    },
    {
        pattern: /^\/portal\/knowledge\/c\/(kcl_[a-z0-9]{14})$/,
        title: "Collection",
        application: "knowledge",
        load: ({ env, user, url, match }) => loadKnowledgePage(env, user, url, "collection", match[1]),
    },
    {
        pattern: /^\/portal\/knowledge\/templates\/(ktp_[a-z0-9]{14})$/,
        title: "Template",
        application: "knowledge",
        load: ({ env, user, url, match }) => loadKnowledgePage(env, user, url, "template", match[1]),
    },
    {
        pattern: /^\/portal\/knowledge\/(search|types|settings|collections|favourites|templates|discover)$/,
        title: "Knowledge",
        application: "knowledge",
        load: ({ env, user, url, match }) =>
            loadKnowledgePage(env, user, url, match[1] as "search" | "types" | "settings" | "collections" | "favourites" | "templates" | "discover"),
    },
    // Daly Tasks. The application's permission is checked here; project membership in the loaders.
    {
        pattern: /^\/portal\/tasks$/,
        title: "Today",
        application: "tasks",
        load: ({ env, user, url }) => loadTasksPage(env, user, url, "home"),
    },
    {
        pattern:
            /^\/portal\/tasks\/(inbox|today|upcoming|overdue|mine|completed|projects|labels|filters|search|activity|settings|templates|dashboard|goals|routines|workload|reports)$/,
        title: "Tasks",
        application: "tasks",
        load: ({ env, user, url, match }) => loadTasksPage(env, user, url, match[1] as TasksPage),
    },
    {
        pattern: /^\/portal\/tasks\/p\/(tpj_[a-z0-9]{14})$/,
        title: "Project",
        application: "tasks",
        load: ({ env, user, url, match }) => loadTasksPage(env, user, url, "project", match[1]),
    },
    {
        pattern: /^\/portal\/tasks\/goals\/(tgl_[a-z0-9]{14})$/,
        title: "Goal",
        application: "tasks",
        load: ({ env, user, url, match }) => loadTasksPage(env, user, url, "goal", match[1]),
    },
    {
        pattern: /^\/portal\/tasks\/t\/(tsk_[a-z0-9]{14})$/,
        title: "Task",
        application: "tasks",
        load: ({ env, user, url, match }) => loadTasksPage(env, user, url, "task", match[1]),
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
    // Daly Intelligence. The application's permission is checked here; ownership and memberships in the loaders.
    {
        pattern: /^\/portal\/intelligence$/,
        title: "Intelligence",
        application: "intelligence",
        load: ({ env, user, url }) => loadIntelligencePage(env, user, url, "home"),
    },
    {
        pattern: /^\/portal\/intelligence\/(inbox|capture|meetings|settings)$/,
        title: "Intelligence",
        application: "intelligence",
        load: ({ env, user, url, match }) => loadIntelligencePage(env, user, url, match[1] as "inbox" | "capture" | "meetings" | "settings"),
    },
    {
        pattern: /^\/portal\/intelligence\/briefing(\/weekly)?$/,
        title: "Briefing",
        application: "intelligence",
        load: ({ env, user, url, match }) => loadIntelligencePage(env, user, url, match[1] ? "weekly" : "briefing"),
    },
    {
        pattern: /^\/portal\/intelligence\/captures\/(aic_[a-z0-9]{14})$/,
        title: "Capture",
        application: "intelligence",
        load: ({ env, user, url, match }) => loadIntelligencePage(env, user, url, "capture-detail", match[1]),
    },
    {
        pattern: /^\/portal\/audit$/,
        title: "Audit log",
        permission: "portal.audit.view",
        load: async ({ env, url }) => ({ route: "audit", ...(await listAudit(env.DB, url)) }),
    },
];

export async function loadPortalPage(path: string, url: URL, env: Env, user: PortalUser, flags: Flags): Promise<PortalPageResult> {
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
