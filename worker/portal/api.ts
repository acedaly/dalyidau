// JSON API for the portal (/api/portal/*). Every route declares the permission it needs and, where
// relevant, the module flag that must be on. Authentication has already happened by the time a
// handler runs; the router only adds authorisation, CSRF checks and error mapping.
import { z } from "zod";
import { type FlagKey, isFlagKey } from "../../src/shared/portal/flags";
import type { Permission } from "../../src/shared/portal/permissions";
import type { PortalUser, SettingsKey } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { invitationLinksConfigured, invitationUrl } from "../wedding/invitations";
import { deleteMedia, listMedia, updateMedia, uploadMedia } from "../wedding/media";
import { can } from "./auth";
import { cateringSummary } from "./catering";
import {
    audiencePreview,
    cancelScheduledMessage,
    deleteDraft,
    deliveryAvailable,
    getMessage,
    listMessages,
    mergeRows,
    prepareMessage,
    previewMessage,
    sendMessage,
} from "./comms";
import { csvResponse, toCsv } from "./csv";
import { getLayout, resetLayout, saveLayout } from "./dashboard";
import { audit, auditStatement, newRsvpCode, nowIso } from "./db";
import { ENTITY_DEFS, type EntityDef, NotFoundError, createEntity, deleteEntity, getEntity, householdDef, listEntities, updateEntity } from "./entities";
import { EXPORTS, fullJsonExport } from "./exports";
import { loadFlags, setFlag } from "./flags";
import { bulkUpdateGuests, createGuest, deleteGuest, getGuest, listGuests, setGuestRsvp, updateGuest } from "./guests";
import { HttpError, checkCrossSite, checkMutation, errorResponse, json, readJson } from "./http";
import { importGuests } from "./import";
import { applyRetention, deleteHousehold, erase, listDeleted, restore, retentionPreview } from "./privacy";
import { listAudit } from "./queries";
import { archiveQuestion, listQuestions, questionSummaries, saveQuestion } from "./rsvp-questions";
import { assignSeats, deleteSnapshot, listSnapshots, restoreSnapshot, saveSnapshot, seatingState, seatingTableDef } from "./seating";
import { getSettings, saveSettings } from "./settings";
import { computeStats } from "./stats";
import { listUsers, removeUser, saveUser } from "./users";

interface Ctx {
    env: Env;
    request: Request;
    url: URL;
    user: PortalUser;
    params: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<Response>;

interface Route {
    method: string;
    pattern: RegExp;
    keys: string[];
    permission: Permission | ((ctx: Ctx) => Permission);
    flag?: FlagKey | ((ctx: Ctx) => FlagKey | undefined);
    handler: Handler;
}

const routes: Route[] = [];

const add = (method: string, path: string, permission: Route["permission"], handler: Handler, flag?: Route["flag"]) => {
    const keys: string[] = [];
    const pattern = new RegExp(
        `^${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
            keys.push(key);
            return "([^/]+)";
        })}$`,
    );
    routes.push({ method, pattern, keys, permission, handler, flag });
};

const SETTINGS_PERMISSIONS: Record<SettingsKey, Permission> = {
    privacy: "portal.data.erase",
    catering: "wedding.planning.edit",
    website_draft: "wedding.website.edit",
    wedding: "portal.settings.manage",
    website: "wedding.website.edit",
    // The RSVP link decides where guests are sent, so only owners and admins may change it.
    rsvp: "portal.settings.manage",
    budget: "wedding.budget.edit",
};
const isSettingsKey = (key: string): key is SettingsKey => key in SETTINGS_PERMISSIONS;

/** Collections served by the generic routes. */
const COLLECTIONS = { ...ENTITY_DEFS, "seating-tables": seatingTableDef } as unknown as Record<string, EntityDef<{ id: string }>>;

const collection = (ctx: Ctx) => {
    const def = COLLECTIONS[ctx.params.collection];
    if (!def) throw new HttpError(404, "not_found", "Unknown collection");
    // The generic routes don't need the concrete row type.
    return def;
};

// --- Session ------------------------------------------------------------------------------------

add("GET", "/api/portal/me", "wedding.view", async ({ env, user }) => json({ user, flags: await loadFlags(env.DB) }));

// --- Dashboard ----------------------------------------------------------------------------------

add("GET", "/api/portal/dashboard", "wedding.view", async ({ env, user }) => {
    const flags = await loadFlags(env.DB);
    const [stats, widgets] = await Promise.all([computeStats(env.DB, user, flags), getLayout(env.DB, user.email)]);
    return json({ stats, widgets });
});
add("PUT", "/api/portal/dashboard", "wedding.view", async ({ env, request, user }) => {
    const body = (await readJson(request)) as { widgets?: unknown; reset?: boolean };
    const widgets = body.reset ? await resetLayout(env.DB, user.email) : await saveLayout(env.DB, user.email, body.widgets);
    return json({ widgets });
});

// --- Settings, flags, people, audit ---------------------------------------------------------------

add(
    "PUT",
    "/api/portal/settings/:key",
    (ctx) => (isSettingsKey(ctx.params.key) ? SETTINGS_PERMISSIONS[ctx.params.key] : "portal.settings.manage"),
    async ({ env, request, user, params }) => {
        if (!isSettingsKey(params.key)) throw new HttpError(404, "not_found", "Unknown settings document");
        // The published website only ever changes by publishing the draft.
        if (params.key === "website") throw new HttpError(405, "method_not_allowed", "Edit the draft, then publish it");
        return json({ value: await saveSettings(env.DB, params.key, await readJson(request), user.email) });
    },
);

add("PUT", "/api/portal/flags/:key", "portal.settings.manage", async ({ env, request, user, params }) => {
    if (!isFlagKey(params.key)) throw new HttpError(404, "not_found", "Unknown feature");
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await readJson(request));
    await setFlag(env.DB, params.key, enabled, user.email);
    return json({ flags: await loadFlags(env.DB) });
});

add("GET", "/api/portal/users", "portal.users.manage", async ({ env }) => json({ users: await listUsers(env, env.DB) }));
add("POST", "/api/portal/users", "portal.users.manage", async ({ env, request, user }) =>
    json({ user: await saveUser(env, env.DB, await readJson(request), user.email) }),
);
add("DELETE", "/api/portal/users/:email", "portal.users.manage", async ({ env, user, params }) => {
    await removeUser(env, env.DB, decodeURIComponent(params.email), user.email);
    return json({ ok: true });
});

add("GET", "/api/portal/audit", "portal.audit.view", async ({ env, url }) => json(await listAudit(env.DB, url)));

// --- Exports --------------------------------------------------------------------------------------

add("GET", "/api/portal/export/all.json", "wedding.export", async ({ env, user }) => {
    const body = await fullJsonExport(env.DB);
    await audit(env.DB, {
        actor: user.email,
        action: "export.full",
        entityType: "export",
        entityId: "all",
        summary: "Exported all wedding portal data (JSON)",
    });
    return json(body, 200, {
        "Content-Disposition": `attachment; filename="wedding-portal-${nowIso().slice(0, 10)}.json"`,
        "Content-Security-Policy": "default-src 'none'; sandbox",
    });
});

add(
    "GET",
    "/api/portal/export/:name",
    (ctx) => EXPORTS[ctx.params.name.replace(/\.csv$/, "")]?.permission ?? "wedding.export",
    async ({ env, user, params }) => {
        const name = params.name.replace(/\.csv$/, "");
        const def = EXPORTS[name];
        if (!def) throw new HttpError(404, "not_found", "Unknown export");
        const body = await def.build(env.DB);
        // Exports contain personal details, so who took one is recorded.
        await audit(env.DB, {
            actor: user.email,
            action: `export.${name}`,
            entityType: "export",
            entityId: name,
            summary: `Exported ${def.label.toLowerCase()} (CSV)`,
        });
        return csvResponse(`wedding-${name}-${nowIso().slice(0, 10)}.csv`, body);
    },
    (ctx) => EXPORTS[ctx.params.name.replace(/\.csv$/, "")]?.flag,
);

// --- Guests ---------------------------------------------------------------------------------------

add("GET", "/api/portal/wedding/guests", "wedding.view", async ({ env }) => json({ guests: await listGuests(env.DB) }));
add("POST", "/api/portal/wedding/guests", "wedding.guests.edit", async ({ env, request, user }) =>
    json({ guest: await createGuest(env.DB, await readJson(request), user.email) }, 201),
);
add("POST", "/api/portal/wedding/guests/bulk", "wedding.guests.edit", async ({ env, request, user }) => {
    const body = await readJson(request);
    // Bulk RSVP changes need the RSVP permission as well.
    if ((body as { action?: string }).action === "set-rsvp" && !can(user, "wedding.rsvp.edit")) throw new HttpError(403, "forbidden", "You can't change RSVPs");
    return json({ ...(await bulkUpdateGuests(env.DB, body, user.email)), guests: await listGuests(env.DB) });
});
add("POST", "/api/portal/wedding/guests/import", "wedding.guests.edit", async ({ env, request, user }) => {
    const body = z
        .object({ csv: z.string().max(1_000_000), dryRun: z.boolean().default(true), rsvpSource: z.enum(["import", "sayido"]).default("import") })
        .parse(await readJson(request));
    const wedding = await getSettings(env.DB, "wedding");
    const result = await importGuests(env.DB, body.csv, {
        dryRun: body.dryRun,
        actor: user.email,
        partnerNames: [wedding.partnerOne, wedding.partnerTwo],
        rsvpSource: body.rsvpSource,
    });
    return json({ result, guests: body.dryRun ? undefined : await listGuests(env.DB) });
});
add("GET", "/api/portal/wedding/guests/:id", "wedding.view", async ({ env, params }) => {
    const guest = await getGuest(env.DB, params.id);
    if (!guest) throw new NotFoundError("Guest not found");
    return json({ guest });
});
add("PATCH", "/api/portal/wedding/guests/:id", "wedding.guests.edit", async ({ env, request, user, params }) =>
    json({ guest: await updateGuest(env.DB, params.id, await readJson(request), user.email) }),
);
add("DELETE", "/api/portal/wedding/guests/:id", "wedding.guests.edit", async ({ env, user, params }) => {
    await deleteGuest(env.DB, params.id, user.email);
    return json({ ok: true });
});
add("PUT", "/api/portal/wedding/guests/:id/rsvp", "wedding.rsvp.edit", async ({ env, request, user, params }) =>
    json({ guest: await setGuestRsvp(env.DB, params.id, await readJson(request), user.email) }),
);

// --- Households -----------------------------------------------------------------------------------

add("POST", "/api/portal/wedding/households/:id/code", "wedding.guests.edit", async ({ env, user, params }) => {
    const before = await getEntity(env.DB, householdDef, params.id);
    if (!before) throw new NotFoundError("Household not found");
    const code = newRsvpCode();
    await env.DB.batch([
        env.DB.prepare("UPDATE households SET rsvp_code = ?, updated_at = ? WHERE id = ?").bind(code, nowIso(), params.id),
        auditStatement(env.DB, {
            actor: user.email,
            action: "household.code",
            entityType: "household",
            entityId: params.id,
            summary: `Issued a new RSVP code for “${before.name}” (the old one stops working)`,
        }),
    ]);
    return json({ household: await getEntity(env.DB, householdDef, params.id) });
});

add("POST", "/api/portal/wedding/households/:id/invitation", "wedding.guests.edit", async ({ env, request, user, params }) => {
    const before = await getEntity(env.DB, householdDef, params.id);
    if (!before) throw new NotFoundError("Household not found");
    const { action } = z.object({ action: z.enum(["rotate", "revoke", "restore"]) }).parse(await readJson(request));
    if ((action === "rotate" || action === "restore") && !invitationLinksConfigured(env))
        throw new HttpError(503, "not_configured", "RSVP_LINK_SECRET must contain at least 32 bytes before invitation links can be issued");
    const now = nowIso();
    const nextVersion = action === "rotate" ? before.inviteVersion + 1 : before.inviteVersion;
    const revokedAt = action === "revoke" ? now : null;
    await env.DB.batch([
        env.DB.prepare("UPDATE households SET invite_version = ?, invite_revoked_at = ?, updated_at = ? WHERE id = ?").bind(
            nextVersion,
            revokedAt,
            now,
            params.id,
        ),
        auditStatement(env.DB, {
            actor: user.email,
            action: `household.invitation.${action}`,
            entityType: "household",
            entityId: params.id,
            summary: `${action === "revoke" ? "Revoked" : action === "rotate" ? "Rotated" : "Restored"} invitation link for “${before.name}”`,
        }),
    ]);
    const household = await getEntity(env.DB, householdDef, params.id);
    return json({
        household: household
            ? { ...household, invitationUrl: household.inviteRevokedAt ? null : await invitationUrl(env, household.id, household.inviteVersion) }
            : null,
    });
});

add("DELETE", "/api/portal/wedding/households/:id", "wedding.guests.edit", async ({ env, user, params }) => {
    await deleteHousehold(env.DB, params.id, user.email);
    return json({ ok: true });
});

// --- Privacy: deleted records, erasure, retention (docs/PRIVACY.md) ------------------------------

add("GET", "/api/portal/privacy/deleted", "wedding.guests.edit", async ({ env }) => json({ deleted: await listDeleted(env.DB) }));
add("POST", "/api/portal/privacy/restore", "wedding.guests.edit", async ({ env, request, user }) => {
    const { type, id } = z.object({ type: z.enum(["guest", "household"]), id: z.string().max(40) }).parse(await readJson(request));
    await restore(env.DB, type, id, user.email);
    return json({ deleted: await listDeleted(env.DB) });
});
add("POST", "/api/portal/privacy/erase", "portal.data.erase", async ({ env, request, user }) => {
    await erase(env.DB, await readJson(request), user.email);
    return json({ deleted: await listDeleted(env.DB) });
});
add("GET", "/api/portal/privacy/retention", "portal.data.erase", async ({ env }) => json({ preview: await retentionPreview(env.DB) }));
add("POST", "/api/portal/privacy/retention", "portal.data.erase", async ({ env, request, user }) => {
    const result = await applyRetention(env.DB, await readJson(request), user.email);
    return json({ ...result, preview: await retentionPreview(env.DB), deleted: await listDeleted(env.DB) });
});

// --- Website: draft, publishing and photos ------------------------------------------------------

add("POST", "/api/portal/wedding/website/publish", "wedding.website.edit", async ({ env, user }) => {
    const draft = await getSettings(env.DB, "website_draft");
    // The draft may refer to photos; make sure they still exist before it goes live.
    const media = await listMedia(env.DB);
    if (draft.heroImageId && !media.some((m) => m.id === draft.heroImageId))
        throw new HttpError(422, "validation", "The hero photo was deleted; choose another");
    const published = await saveSettings(env.DB, "website", draft, user.email);
    return json({ published });
});
add("POST", "/api/portal/wedding/website/discard", "wedding.website.edit", async ({ env, user }) => {
    const published = await getSettings(env.DB, "website");
    return json({ draft: await saveSettings(env.DB, "website_draft", published, user.email) });
});
add("GET", "/api/portal/wedding/media", "wedding.view", async ({ env }) => json({ media: await listMedia(env.DB) }));
add("POST", "/api/portal/wedding/media", "wedding.website.edit", async ({ env, request, user }) =>
    json({ media: await uploadMedia(env.DB, env.MEDIA, await readJson(request, 8_000_000), user.email) }, 201),
);
add("PATCH", "/api/portal/wedding/media/:id", "wedding.website.edit", async ({ env, request, user, params }) =>
    json({ media: await updateMedia(env.DB, params.id, await readJson(request), user.email) }),
);
add("DELETE", "/api/portal/wedding/media/:id", "wedding.website.edit", async ({ env, user, params }) => {
    await deleteMedia(env.DB, env.MEDIA, params.id, user.email);
    return json({ ok: true });
});

// --- Seating and catering ----------------------------------------------------------------------

add("GET", "/api/portal/wedding/seating", "wedding.view", async ({ env }) => json(await seatingState(env.DB)), "module.planning");
add(
    "PUT",
    "/api/portal/wedding/seating/assign",
    "wedding.planning.edit",
    async ({ env, request, user }) => {
        await assignSeats(env.DB, await readJson(request), user.email);
        return json(await seatingState(env.DB));
    },
    "module.planning",
);
add(
    "POST",
    "/api/portal/wedding/seating/snapshots",
    "wedding.planning.edit",
    async ({ env, request, user }) => json({ snapshots: await saveSnapshot(env.DB, await readJson(request), user.email) }, 201),
    "module.planning",
);
add(
    "POST",
    "/api/portal/wedding/seating/snapshots/:id/restore",
    "wedding.planning.edit",
    async ({ env, user, params }) => {
        await restoreSnapshot(env.DB, params.id, user.email);
        return json(await seatingState(env.DB));
    },
    "module.planning",
);
add(
    "DELETE",
    "/api/portal/wedding/seating/snapshots/:id",
    "wedding.planning.edit",
    async ({ env, user, params }) => {
        await deleteSnapshot(env.DB, params.id, user.email);
        return json({ snapshots: await listSnapshots(env.DB) });
    },
    "module.planning",
);
add("GET", "/api/portal/wedding/catering", "wedding.view", async ({ env }) => json(await cateringSummary(env.DB)), "module.planning");

// --- RSVP questions ------------------------------------------------------------------------------

add("GET", "/api/portal/wedding/rsvp-questions", "wedding.view", async ({ env }) =>
    json({ questions: await listQuestions(env.DB), summaries: await questionSummaries(env.DB) }),
);
add("POST", "/api/portal/wedding/rsvp-questions", "wedding.rsvp.edit", async ({ env, request, user }) =>
    json({ question: await saveQuestion(env.DB, null, await readJson(request), user.email) }, 201),
);
add("PATCH", "/api/portal/wedding/rsvp-questions/:id", "wedding.rsvp.edit", async ({ env, request, user, params }) =>
    json({ question: await saveQuestion(env.DB, params.id, await readJson(request), user.email) }),
);
add("DELETE", "/api/portal/wedding/rsvp-questions/:id", "wedding.rsvp.edit", async ({ env, user, params }) => {
    await archiveQuestion(env.DB, params.id, user.email);
    return json({ ok: true });
});

// --- Communications -------------------------------------------------------------------------------

add("GET", "/api/portal/wedding/messages", "wedding.view", async ({ env }) => json({ messages: await listMessages(env.DB) }), "module.communications");
add(
    "POST",
    "/api/portal/wedding/messages",
    "wedding.comms.edit",
    async ({ env, request, user }) => json({ message: await prepareMessage(env.DB, await readJson(request), user.email) }, 201),
    "module.communications",
);
add(
    "POST",
    "/api/portal/wedding/messages/audience",
    "wedding.view",
    async ({ env, request }) => json(await audiencePreview(env.DB, await readJson(request))),
    "module.communications",
);
add(
    "POST",
    "/api/portal/wedding/messages/preview",
    "wedding.view",
    async ({ env, request }) => {
        const body = z
            .object({ subject: z.string().max(200), body: z.string().max(20_000), guestId: z.string().max(40).nullable().optional() })
            .parse(await readJson(request));
        return json(await previewMessage(env, env.DB, body));
    },
    "module.communications",
);
add(
    "GET",
    "/api/portal/wedding/messages/:id",
    "wedding.view",
    async ({ env, params }) => {
        const found = await getMessage(env.DB, params.id);
        if (!found) throw new NotFoundError("Message not found");
        return json({ ...found, deliveryAvailable: await deliveryAvailable(env, env.DB) });
    },
    "module.communications",
);
add(
    "POST",
    "/api/portal/wedding/messages/:id/send",
    "wedding.comms.send",
    async ({ env, user, params }) => json({ message: await sendMessage(env, env.DB, params.id, user.email) }),
    "module.communications",
);
add(
    "POST",
    "/api/portal/wedding/messages/:id/unschedule",
    "wedding.comms.edit",
    async ({ env, user, params }) => json({ message: await cancelScheduledMessage(env.DB, params.id, user.email) }),
    "module.communications",
);
add(
    "DELETE",
    "/api/portal/wedding/messages/:id",
    "wedding.comms.edit",
    async ({ env, user, params }) => {
        await deleteDraft(env.DB, params.id, user.email);
        return json({ ok: true });
    },
    "module.communications",
);
add(
    "GET",
    "/api/portal/wedding/messages/:id/merge.csv",
    "wedding.export",
    async ({ env, user, params }) => {
        const rows = await mergeRows(env, env.DB, params.id);
        await audit(env.DB, {
            actor: user.email,
            action: "export.message",
            entityType: "message",
            entityId: params.id,
            summary: `Exported a mail-merge file for ${rows.length} recipients`,
        });
        return csvResponse(
            `message-${params.id}.csv`,
            toCsv(rows, [
                { header: "Name", value: (r) => r.name },
                { header: "Email", value: (r) => r.email },
                { header: "Subject", value: (r) => r.subject },
                { header: "Body", value: (r) => r.body },
                { header: "RSVP code", value: (r) => r.rsvpCode },
                { header: "RSVP link", value: (r) => r.rsvpLink },
            ]),
        );
    },
    "module.communications",
);

// --- Generic collections (households, events, tasks, …) -------------------------------------------
// Registered last so the specific routes above win.

const collectionPermission = (kind: "read" | "write") => (ctx: Ctx) => {
    const def = COLLECTIONS[ctx.params.collection];
    return def ? def[kind] : "portal.settings.manage";
};
const collectionFlag = (ctx: Ctx) => COLLECTIONS[ctx.params.collection]?.flag;

add(
    "GET",
    "/api/portal/wedding/:collection",
    collectionPermission("read"),
    async (ctx) => json({ items: await listEntities(ctx.env.DB, collection(ctx)) }),
    collectionFlag,
);
add(
    "POST",
    "/api/portal/wedding/:collection",
    collectionPermission("write"),
    async (ctx) => json({ item: await createEntity(ctx.env.DB, collection(ctx), await readJson(ctx.request), ctx.user.email) }, 201),
    collectionFlag,
);
add(
    "PATCH",
    "/api/portal/wedding/:collection/:id",
    collectionPermission("write"),
    async (ctx) => json({ item: await updateEntity(ctx.env.DB, collection(ctx), ctx.params.id, await readJson(ctx.request), ctx.user.email) }),
    collectionFlag,
);
add(
    "DELETE",
    "/api/portal/wedding/:collection/:id",
    collectionPermission("write"),
    async (ctx) => {
        // Records holding personal data have their own soft-delete route registered above.
        if (collection(ctx).softDelete) throw new HttpError(405, "method_not_allowed", "Use the dedicated delete route");
        await deleteEntity(ctx.env.DB, collection(ctx), ctx.params.id, ctx.user.email);
        return json({ ok: true });
    },
    collectionFlag,
);

// --- Dispatch -------------------------------------------------------------------------------------

export async function handlePortalApi(request: Request, env: Env, user: PortalUser): Promise<Response> {
    const url = new URL(request.url);
    try {
        checkCrossSite(request);
        checkMutation(request, env);
        const method = request.method === "HEAD" ? "GET" : request.method;
        let pathMatched = false;
        for (const route of routes) {
            const match = route.pattern.exec(url.pathname);
            if (!match) continue;
            pathMatched = true;
            if (route.method !== method) continue;
            const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
            const ctx: Ctx = { env, request, url, user, params };
            const permission = typeof route.permission === "function" ? route.permission(ctx) : route.permission;
            if (!can(user, permission)) throw new HttpError(403, "forbidden", "You don't have permission to do that");
            const flag = typeof route.flag === "function" ? route.flag(ctx) : route.flag;
            if (flag && !(await loadFlags(env.DB))[flag]) throw new HttpError(404, "module_off", "This module is switched off");
            return await route.handler(ctx);
        }
        if (pathMatched) throw new HttpError(405, "method_not_allowed", "Method not allowed");
        throw new HttpError(404, "not_found", "Not found");
    } catch (error) {
        return errorResponse(error, url.pathname);
    }
}
