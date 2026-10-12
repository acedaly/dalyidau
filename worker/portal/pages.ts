// Server-side loaders for portal pages. Each returns the data the page needs for its first render;
// after that the page talks to /api/portal directly.
import type { Flags } from "../../src/shared/portal/flags";
import type { Permission } from "../../src/shared/portal/permissions";
import type { PortalRoute, PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can } from "./auth";
import { deliveryAvailable, getMessage, listMessages } from "./comms";
import { getLayout } from "./dashboard";
import { budgetItemDef, customFieldDef, eventDef, householdDef, listEntities, supplierDef, taskDef, templateDef, timelineDef } from "./entities";
import { listGuests } from "./guests";
import { distinctGuestValues, householdResponseCounts, listAudit, listSubmissions } from "./queries";
import { getSettings } from "./settings";
import { computeStats } from "./stats";
import { listUsers } from "./users";

export interface PortalPageResult {
    data: PortalRoute;
    status: number;
    title: string;
}

interface PageDef {
    pattern: RegExp;
    title: string;
    permission: Permission;
    flag?: keyof Flags;
    load: (ctx: { env: Env; user: PortalUser; flags: Flags; url: URL; match: RegExpExecArray }) => Promise<PortalRoute | null>;
}

const PAGES: PageDef[] = [
    {
        pattern: /^\/portal\/wedding$/,
        title: "Dashboard",
        permission: "wedding.view",
        load: async ({ env, user, flags }) => {
            const [stats, widgets] = await Promise.all([computeStats(env.DB, user, flags), getLayout(env.DB, user.email)]);
            return { route: "dashboard", stats, widgets };
        },
    },
    {
        pattern: /^\/portal\/wedding\/guests$/,
        title: "Guests",
        permission: "wedding.view",
        load: async ({ env }) => {
            const [guests, households, events, customFields] = await Promise.all([
                listGuests(env.DB),
                listEntities(env.DB, householdDef),
                listEntities(env.DB, eventDef),
                listEntities(env.DB, customFieldDef),
            ]);
            return { route: "guests", guests, households: households.map((h) => ({ id: h.id, name: h.name })), events, customFields };
        },
    },
    {
        pattern: /^\/portal\/wedding\/households$/,
        title: "Households",
        permission: "wedding.view",
        load: async ({ env }) => ({ route: "households", households: await listEntities(env.DB, householdDef) }),
    },
    {
        pattern: /^\/portal\/wedding\/events$/,
        title: "Events",
        permission: "wedding.view",
        load: async ({ env }) => ({ route: "events", events: await listEntities(env.DB, eventDef) }),
    },
    {
        pattern: /^\/portal\/wedding\/rsvps$/,
        title: "RSVPs",
        permission: "wedding.view",
        load: async ({ env, user, flags }) => {
            const [events, stats, submissions, settings, households] = await Promise.all([
                listEntities(env.DB, eventDef),
                computeStats(env.DB, user, flags),
                listSubmissions(env.DB),
                getSettings(env.DB, "rsvp"),
                householdResponseCounts(env.DB),
            ]);
            return { route: "rsvps", events, stats, submissions, settings, households };
        },
    },
    {
        pattern: /^\/portal\/wedding\/communications$/,
        title: "Communications",
        permission: "wedding.view",
        flag: "module.communications",
        load: async ({ env }) => {
            const [templates, messages, events, values, available] = await Promise.all([
                listEntities(env.DB, templateDef),
                listMessages(env.DB),
                listEntities(env.DB, eventDef),
                distinctGuestValues(env.DB),
                deliveryAvailable(env, env.DB),
            ]);
            return { route: "communications", templates, messages, events, groups: values.groups, tags: values.tags, deliveryAvailable: available };
        },
    },
    {
        pattern: /^\/portal\/wedding\/communications\/(msg_[a-z0-9]+)$/,
        title: "Message",
        permission: "wedding.view",
        flag: "module.communications",
        load: async ({ env, match }) => {
            const found = await getMessage(env.DB, match[1]);
            if (!found) return null;
            return { route: "message", ...found, deliveryAvailable: await deliveryAvailable(env, env.DB) };
        },
    },
    {
        pattern: /^\/portal\/wedding\/tasks$/,
        title: "Tasks",
        permission: "wedding.view",
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
        flag: "module.planning",
        load: async ({ env }) => ({ route: "timeline", items: await listEntities(env.DB, timelineDef) }),
    },
    {
        pattern: /^\/portal\/wedding\/budget$/,
        title: "Budget",
        permission: "wedding.budget.view",
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
        flag: "module.budget",
        load: async ({ env }) => ({ route: "suppliers", suppliers: await listEntities(env.DB, supplierDef) }),
    },
    {
        pattern: /^\/portal\/wedding\/website$/,
        title: "Website",
        permission: "wedding.view",
        load: async ({ env }) => {
            const [content, events, rsvp] = await Promise.all([getSettings(env.DB, "website"), listEntities(env.DB, eventDef), getSettings(env.DB, "rsvp")]);
            return { route: "website", content, events, rsvp };
        },
    },
    {
        pattern: /^\/portal\/settings(?:\/(general|features|fields|people))?$/,
        title: "Settings",
        permission: "wedding.view",
        load: async ({ env, user, match }) => {
            const tab = (match[1] ?? "general") as "general" | "features" | "fields" | "people";
            const [customFields, users] = await Promise.all([
                listEntities(env.DB, customFieldDef),
                can(user, "portal.users.manage") ? listUsers(env, env.DB) : Promise.resolve(null),
            ]);
            return { route: "settings", tab, customFields, users };
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
    for (const page of PAGES) {
        const match = page.pattern.exec(path);
        if (!match) continue;
        if (!can(user, page.permission)) {
            return { data: { route: "forbidden", message: "Your role doesn't include this part of the portal." }, status: 403, title: "No access" };
        }
        if (page.flag && !flags[page.flag]) {
            return {
                data: { route: "forbidden", message: "This module is switched off. An owner or admin can turn it on in Settings → Features." },
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
