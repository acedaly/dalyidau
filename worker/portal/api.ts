// JSON API for the portal (/api/portal/*). Every route declares the permission it needs and, where
// relevant, the module flag that must be on. Authentication has already happened by the time a
// handler runs; the router only adds authorisation, CSRF checks and error mapping.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { z } from "zod";
import { type FlagKey, isFlagKey } from "../../src/shared/portal/flags";
import type { Permission } from "../../src/shared/portal/permissions";
import { formatMobile, normaliseMobile } from "../../src/shared/portal/phone";
import type { PortalUser, SettingsKey } from "../../src/shared/portal/types";
import { amplenoteStatus } from "../amplenote/api";
import { disconnect as disconnectAmplenote, restConfigured, startConnect } from "../amplenote/client";
import { extractMetadata } from "../amplenote/metadata";
import { postId as amplenotePostId, reconcile as reconcileAmplenote } from "../amplenote/publisher";
import { handleAssetsApi } from "../assets/api";
import { handleCalendarApi } from "../calendar/api";
import { archiveCapacities, undoReplacement } from "../capacities/archive";
import { handleCentreApi } from "../centre/api";
import { emailProvider, htmlForText, providerStatus, safeFilename, smsProvider, validateProviderConnection } from "../comms/providers";
import type { Env } from "../env";
import { handleIntelligenceApi } from "../intelligence/api";
import { handleKnowledgeApi } from "../knowledge/api";
import { applyMigration, listMigrationRuns, previewMigration, revertMigration } from "../migration/dalyhub";
import { handleTasksApi } from "../tasks/api";
import { handleTodayApi } from "../today/api";
import { invitationLinksConfigured, invitationUrl } from "../wedding/invitations";
import { deleteMedia, listMedia, updateMedia, uploadMedia } from "../wedding/media";
import { can } from "./auth";
import { printableCards } from "./cards";
import { cateringSummary } from "./catering";
import {
    audiencePreview,
    cancelScheduledMessage,
    deleteDraft,
    deliveryAvailable,
    getMessage,
    listMessages,
    listSmsThreads,
    mergeRows,
    messageInvitationPdf,
    planPreview,
    preflight,
    prepareMessage,
    previewMessage,
    retryFailed,
    scheduleMessage,
    sendMessage,
    sendSmsReply,
    sendTest,
    smsConversation,
} from "./comms";
import { csvResponse, toCsv } from "./csv";
import { getLayout, resetLayout, saveLayout } from "./dashboard";
import { audit, auditStatement, newRsvpCode, nowIso } from "./db";
import { ENTITY_DEFS, type EntityDef, NotFoundError, createEntity, deleteEntity, getEntity, householdDef, listEntities, updateEntity } from "./entities";
import { EXPORTS, fullJsonExport } from "./exports";
import { isEnabled, loadFlags, setFlag } from "./flags";
import { bulkUpdateGuests, createGuest, deleteGuest, getGuest, listGuests, setGuestRsvp, updateGuest } from "./guests";
import { bulkUpdateHouseholds, generateInvitations, listHouseholdRows } from "./households";
import { HttpError, checkCrossSite, checkMutation, errorResponse, json, readJson } from "./http";
import { MAX_IMPORT_BYTES, commitImport, getImportReport, importReportCsv, listImports, planImport } from "./import";
import { generateStudioInvitations, invitationPreviews, printableInvitations } from "./invitation-studio";
import { applyMobileReview, mobileReview } from "./mobile-review";
import { applyRetention, deleteHousehold, erase, listDeleted, restore, retentionPreview } from "./privacy";
import { listAudit } from "./queries";
import { CREDENTIAL_PERMISSION, hideCredentials } from "./redact";
import { archiveQuestion, listQuestions, questionSummaries, saveQuestion } from "./rsvp-questions";
import { assignSeats, deleteSnapshot, listSnapshots, restoreSnapshot, saveSnapshot, seatingState, seatingTableDef } from "./seating";
import { getSettings, saveSettings } from "./settings";
import { computeStats } from "./stats";
import { prepareStudioDrafts } from "./studio-drafts";
import { listThankYouNotes, saveThankYouNote } from "./thank-you";
import { householdTimeline } from "./timeline";
import { saveTravelManually, travelOverview } from "./travel";
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
    studio: "wedding.comms.edit",
    // Who may receive test sends, so only owners and admins may change it.
    comms: "portal.settings.manage",
    privacy: "portal.data.erase",
    catering: "wedding.planning.edit",
    website_draft: "wedding.website.edit",
    wedding: "portal.settings.manage",
    invitation: "wedding.comms.edit",
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

// --- Website: Amplenote publishing (worker/amplenote, docs/AMPLENOTE.md) ---------------------------

add("GET", "/api/portal/website/amplenote", "portal.settings.manage", async ({ env }) => json({ status: await amplenoteStatus(env) }));

add("POST", "/api/portal/website/amplenote/connect", "portal.settings.manage", async ({ env, user }) => {
    if (!restConfigured(env)) throw new HttpError(409, "not_configured", "Set AMPLENOTE_CLIENT_ID and AMPLENOTE_TOKEN_KEY on the Worker first");
    const { url, cookie } = await startConnect(env, user.email);
    return json({ url }, 200, { "Set-Cookie": cookie });
});

add("POST", "/api/portal/website/amplenote/check", "portal.settings.manage", async ({ env, user }) => {
    const summary = await reconcileAmplenote(env, { trigger: "manual" });
    await audit(env.DB, {
        actor: user.email,
        action: "website.amplenote.check",
        entityType: "website",
        entityId: "amplenote",
        summary: `Checked Amplenote articles: ${summary.published} published, ${summary.updated} updated, ${summary.unpublished} unpublished`,
    });
    return json({ summary, status: await amplenoteStatus(env) });
});

add("POST", "/api/portal/website/amplenote/disconnect", "portal.settings.manage", async ({ env, user }) => {
    await disconnectAmplenote(env, user.email);
    return json({ status: await amplenoteStatus(env) });
});

// --- Website: retiring Capacities (worker/capacities/archive.ts, docs/CAPACITIES_RETIREMENT.md) -----

add("POST", "/api/portal/website/capacities/archive", "portal.settings.manage", async ({ env, user }) => {
    const capacities = await archiveCapacities(env, user.email);
    return json({ capacities, status: await amplenoteStatus(env) });
});

const noteUuid = (value: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(404, "not_found", "No such note");
    return value.toLowerCase();
};

/**
 * Approves moving a Capacities article's address to the Amplenote note that names it ("replaces:"),
 * then runs a check so it happens straight away. Only an address the note names, only an article
 * still published from Capacities, and only with Capacities sync off.
 */
add("POST", "/api/portal/website/amplenote/:uuid/replacement", "portal.settings.manage", async ({ env, user, params, request }) => {
    const uuid = noteUuid(params.uuid);
    const { slug } = z.object({ slug: z.string().min(1).max(96) }).parse(await readJson(request));
    const note = await env.DB.prepare("SELECT markdown FROM amplenote_articles WHERE uuid = ?").bind(uuid).first<{ markdown: string | null }>();
    if (!note?.markdown) throw new HttpError(404, "not_found", "That note hasn't been published from Amplenote");
    const wanted = extractMetadata(note.markdown).metadata.replaces;
    const target = wanted
        ? await env.DB.prepare(
              `SELECT slug FROM posts WHERE source = 'capacities' AND (slug = ?1 OR id = (SELECT post_id FROM slug_redirects WHERE from_slug = ?1))`,
          )
              .bind(wanted)
              .first<{ slug: string }>()
        : null;
    if (!target || target.slug !== slug)
        throw new HttpError(409, "conflict", "The note doesn't name that Capacities article any more. Check the note's Website section.");
    if (await isEnabled(env.DB, "website.capacities.sync"))
        throw new HttpError(409, "conflict", "Switch off Capacities sync in Portal settings → Features first");
    await env.DB.batch([
        env.DB.prepare("UPDATE amplenote_articles SET replace_slug = ?, replace_approved_by = ?, replace_approved_at = ?, updated_at = ? WHERE uuid = ?").bind(
            slug,
            user.email,
            nowIso(),
            nowIso(),
            uuid,
        ),
        auditStatement(env.DB, {
            actor: user.email,
            action: "website.capacities.replace",
            entityType: "website",
            entityId: uuid,
            summary: `Approved moving /blog/${slug} from Capacities to an Amplenote note`,
        }),
    ]);
    const summary = await reconcileAmplenote(env, { trigger: "manual" });
    return json({ summary, status: await amplenoteStatus(env) });
});

/** Withdraws an approval, or (once moved) puts the archived Capacities article back at its address. */
add("DELETE", "/api/portal/website/amplenote/:uuid/replacement", "portal.settings.manage", async ({ env, user, params }) => {
    const uuid = noteUuid(params.uuid);
    if (!(await undoReplacement(env, uuid, user.email, amplenotePostId(uuid)))) {
        const cleared = await env.DB.prepare(
            "UPDATE amplenote_articles SET replace_slug = NULL, replace_approved_by = NULL, replace_approved_at = NULL WHERE uuid = ? AND replace_slug IS NOT NULL RETURNING replace_slug",
        )
            .bind(uuid)
            .first();
        if (!cleared) throw new HttpError(404, "not_found", "Nothing to undo for that note");
        await audit(env.DB, {
            actor: user.email,
            action: "website.capacities.replace_cancel",
            entityType: "website",
            entityId: uuid,
            summary: "Withdrew approval to move a Capacities article to an Amplenote note",
        });
    }
    return json({ status: await amplenoteStatus(env) });
});

// --- Session ------------------------------------------------------------------------------------

add("GET", "/api/portal/me", "wedding.view", async ({ env, user }) => json({ user, flags: await loadFlags(env.DB) }));

add("POST", "/api/portal/wedding/providers/validate", "portal.settings.manage", async ({ env, request }) => {
    const { channel } = z.object({ channel: z.enum(["email", "sms"]) }).parse(await readJson(request));
    return json(await validateProviderConnection(env, channel));
});

add("POST", "/api/portal/wedding/providers/test", "portal.settings.manage", async ({ env, request, user }) => {
    const body = z
        .object({
            channel: z.enum(["email", "sms"]),
            to: z.string().trim().max(254),
            confirm: z.literal("SEND TEST"),
        })
        .parse(await readJson(request));
    const now = nowIso();
    let provider = "";
    if (body.channel === "email") {
        if (!z.email().safeParse(body.to).success) throw new HttpError(422, "validation", "Enter a valid test email address");
        const adapter = emailProvider(env);
        if (!adapter) throw new HttpError(503, "not_configured", "The selected email provider is not configured");
        provider = adapter.name;
        await adapter.send({
            to: body.to,
            toName: "Wedding Planner test",
            subject: "Wedding Planner email test",
            text: "This controlled test confirms that Wedding Planner can send email. No guest invitation was sent.",
            html: htmlForText("This controlled test confirms that Wedding Planner can send email. No guest invitation was sent."),
            reference: `provider-test:${crypto.randomUUID()}`,
        });
    } else {
        const to = normaliseMobile(body.to);
        if (!to?.startsWith("+614")) throw new HttpError(422, "validation", "Use an approved Australian mobile, e.g. 0412 345 678");
        const adapter = smsProvider(env);
        if (!adapter || !env.SMS_FROM || !env.COMMS_WEBHOOK_SECRET)
            throw new HttpError(503, "not_configured", "ClickSend credentials, an approved sender and webhook validation must be configured first");
        provider = adapter.name;
        await adapter.send({
            to,
            body: "Wedding Planner controlled SMS test. No invitation was sent.",
            reference: `provider-test:${crypto.randomUUID()}`,
        });
    }
    await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO communication_provider_checks (channel, provider, tested_at, tested_by, result)
                 VALUES (?, ?, ?, ?, 'sent')
                 ON CONFLICT(channel) DO UPDATE SET provider = excluded.provider, tested_at = excluded.tested_at, tested_by = excluded.tested_by, result = excluded.result`,
        ).bind(body.channel, provider, now, user.email),
        auditStatement(env.DB, {
            actor: user.email,
            action: `provider.${body.channel}.test`,
            entityType: "communication_provider",
            entityId: body.channel,
            summary: `Sent a controlled ${body.channel} provider test via ${provider}`,
        }),
    ]);
    return json({ ok: true, provider });
});

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

// --- DalyHub migration (docs/DALYHUB_MIGRATION.md) ---------------------------------------------------
// Owners only, into their own records, and only while DALYHUB_MIGRATION is "on" (off by default).
// The audit log records counts and run ids, never titles.

const migration = (env: Env) => {
    if (env.DALYHUB_MIGRATION !== "on") throw new HttpError(404, "not_found", "Not found");
};
add("GET", "/api/portal/migrations/dalyhub/runs", "portal.settings.manage", async ({ env, user }) => {
    migration(env);
    return json({ runs: await listMigrationRuns(env.DB, user) });
});
add("POST", "/api/portal/migrations/dalyhub/preview", "portal.settings.manage", async ({ env, request, user }) => {
    migration(env);
    return json(await previewMigration(env.DB, user, await readJson(request, 8_000_000)));
});
add("POST", "/api/portal/migrations/dalyhub/apply", "portal.settings.manage", async ({ env, request, user }) => {
    migration(env);
    const result = await applyMigration(env.DB, user, await readJson(request, 8_000_000));
    await audit(env.DB, {
        actor: user.email,
        action: "dalyhub_migration.apply",
        entityType: "dalyhub_migration",
        entityId: result.runId,
        summary: `Imported ${result.created} DalyHub records`,
        changes: result,
    });
    return json(result);
});
add("POST", "/api/portal/migrations/dalyhub/runs/:id/revert", "portal.settings.manage", async ({ env, request, user, params }) => {
    migration(env);
    const result = await revertMigration(env.DB, user, params.id, await readJson(request));
    if (!result.dryRun)
        await audit(env.DB, {
            actor: user.email,
            action: "dalyhub_migration.revert",
            entityType: "dalyhub_migration",
            entityId: params.id,
            summary: `Reverted ${result.removed} DalyHub records, kept ${result.kept.length}`,
            changes: { removed: result.removed, kept: result.kept.length, alreadyGone: result.alreadyGone },
        });
    return json(result);
});

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
        const body = await def.build(env.DB, env);
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
// Import: preview (nothing written), then apply the reviewed plan. See worker/portal/import.ts.
// JSON escaping roughly doubles a quote-heavy CSV.
const IMPORT_REQUEST_BYTES = MAX_IMPORT_BYTES * 2 + 500_000;
const importPreviewSchema = z.object({ csv: z.string().max(MAX_IMPORT_BYTES), decisions: z.unknown().optional() });
const partnerNames = async (env: Env): Promise<[string, string]> => {
    const wedding = await getSettings(env.DB, "wedding");
    return [wedding.partnerOne, wedding.partnerTwo];
};
add("POST", "/api/portal/wedding/guests/import/preview", "wedding.guests.edit", async ({ env, request }) => {
    const body = importPreviewSchema.parse(await readJson(request, IMPORT_REQUEST_BYTES));
    const { plan } = await planImport(env.DB, body.csv, body.decisions, { partnerNames: await partnerNames(env) });
    return json({ plan });
});
add("POST", "/api/portal/wedding/guests/import", "wedding.guests.edit", async ({ env, request, user }) => {
    const report = await commitImport(env.DB, await readJson(request, IMPORT_REQUEST_BYTES), {
        actor: user.email,
        partnerNames: await partnerNames(env),
        canEditRsvps: can(user, "wedding.rsvp.edit"),
    });
    return json({ report, guests: await listGuests(env.DB) });
});
add("GET", "/api/portal/wedding/guests/imports", "wedding.guests.edit", async ({ env }) => json({ imports: await listImports(env.DB) }));
add("GET", "/api/portal/wedding/guests/imports/:id", "wedding.guests.edit", async ({ env, params }) => {
    const report = await getImportReport(env.DB, params.id);
    if (!report) throw new NotFoundError("Import not found");
    return json({ report });
});
// The report lists names and addresses, so downloading it is an export like any other.
add("GET", "/api/portal/wedding/guests/imports/:id/report.csv", "wedding.export", async ({ env, user, params }) => {
    const report = await getImportReport(env.DB, params.id);
    if (!report) throw new NotFoundError("Import not found");
    await audit(env.DB, {
        actor: user.email,
        action: "export.import_report",
        entityType: "export",
        entityId: report.id,
        summary: `Exported the report for the import of ${report.createdAt.slice(0, 10)} (CSV)`,
    });
    return csvResponse(`guest-import-${report.createdAt.slice(0, 10)}-${report.id}.csv`, importReportCsv(report));
});
// Legacy mobile numbers: a read-only preview, then only the ticked, confirmed changes.
add("GET", "/api/portal/wedding/mobile-numbers", "wedding.guests.edit", async ({ env }) => json(await mobileReview(env.DB)));
add("POST", "/api/portal/wedding/mobile-numbers", "wedding.guests.edit", async ({ env, request, user }) =>
    json({ ...(await applyMobileReview(env.DB, await readJson(request), user.email)), review: await mobileReview(env.DB) }),
);
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

// Courtesy bus and accommodation: the private overview, and a manual answer after a phone call.
add("GET", "/api/portal/wedding/travel", "wedding.view", async ({ env }) => json(await travelOverview(env.DB)));
add("PUT", "/api/portal/wedding/households/:id/travel", "wedding.rsvp.edit", async ({ env, request, user, params }) =>
    json({ travel: await saveTravelManually(env.DB, params.id, await readJson(request), user.email) }),
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

add("GET", "/api/portal/wedding/households/:id/timeline", "wedding.view", async ({ env, user, params }) =>
    json({ entries: await householdTimeline(env.DB, params.id, { includeReplies: user.permissions.includes("wedding.comms.edit") }) }),
);
add("GET", "/api/portal/wedding/households/overview", "wedding.view", async ({ env }) => json({ households: await listHouseholdRows(env) }));

// Bulk "generate invitations": marks the households' signed links ready. Sending is a separate,
// approved step in Communications; nothing here contacts a guest.
add("POST", "/api/portal/wedding/households/invitations", "wedding.guests.edit", async ({ env, request, user }) => {
    const result = await generateInvitations(env, await readJson(request), user.email);
    return json({ ...result, households: await listHouseholdRows(env) });
});

add("POST", "/api/portal/wedding/households/bulk", "wedding.guests.edit", async ({ env, request, user }) => {
    const result = await bulkUpdateHouseholds(env.DB, await readJson(request), user.email);
    return json({ ...result, households: await listHouseholdRows(env) });
});

// Builds every household's invitation with its signed link, code and QR: for those who prepare them.
add("POST", "/api/portal/wedding/invitations/preview", "wedding.comms.edit", async ({ env, request }) =>
    json({ previews: await invitationPreviews(env, await readJson(request)) }),
);
add("POST", "/api/portal/wedding/invitations/generate", "wedding.guests.edit", async ({ env, request, user }) =>
    json(await generateStudioInvitations(env, await readJson(request), user.email), 201),
);
// Prepare reviewable Communications drafts for the households selected in the Studio. Never sends.
add(
    "POST",
    "/api/portal/wedding/invitations/prepare",
    "wedding.comms.edit",
    async ({ env, request, user }) => {
        const result = await prepareStudioDrafts(env, env.DB, await readJson(request), user.email);
        if (result.conflicts.length || result.sent.length)
            return json(
                {
                    error: "conflict",
                    message: result.conflicts.length
                        ? "These households already have an unsent invitation draft. Open it, or deliberately replace it."
                        : "These households were already sent an invitation. Confirm that you want to prepare another invitation.",
                    conflicts: result.conflicts,
                    sent: result.sent,
                },
                409,
            );
        return json({ drafts: result.drafts }, 201);
    },
    "module.communications",
);
add("POST", "/api/portal/wedding/invitations/print.pdf", "wedding.export", async ({ env, request, user }) => {
    const pdf = await printableInvitations(env, await readJson(request));
    await audit(env.DB, {
        actor: user.email,
        action: "export.invitations.pdf",
        entityType: "invitation",
        summary: "Generated printable wedding invitations (PDF; nothing sent)",
    });
    return new Response(new Uint8Array(pdf).buffer, {
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": 'attachment; filename="wedding-invitations.pdf"',
            "Cache-Control": "no-store",
        },
    });
});

add("DELETE", "/api/portal/wedding/households/:id", "wedding.guests.edit", async ({ env, user, params }) => {
    await deleteHousehold(env.DB, params.id, user.email, "unassign");
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
    async ({ env, request, user }) => {
        const body = await readJson(request);
        // Scheduling is sending later, so it needs the send permission (editors prepare, they don't send).
        if (body && typeof body === "object" && (body as { scheduledAt?: unknown }).scheduledAt && !user.permissions.includes("wedding.comms.send"))
            throw new HttpError(403, "forbidden", "Only owners and admins can schedule messages");
        return json({ message: await prepareMessage(env, env.DB, body, user.email) }, 201);
    },
    "module.communications",
);
add(
    "POST",
    "/api/portal/wedding/messages/audience",
    "wedding.view",
    async ({ env, request }) => json(await audiencePreview(env, env.DB, await readJson(request))),
    "module.communications",
);
add(
    "POST",
    "/api/portal/wedding/messages/plan",
    "wedding.view",
    async ({ env, request }) => json(await planPreview(env, env.DB, await readJson(request))),
    "module.communications",
);
add(
    "POST",
    "/api/portal/wedding/messages/preview",
    // The rendered copy carries the household's signed link and code in the text itself.
    "wedding.comms.edit",
    async ({ env, request }) => json(await previewMessage(env, env.DB, await readJson(request))),
    "module.communications",
);
add(
    "GET",
    "/api/portal/wedding/messages/:id",
    "wedding.view",
    async ({ env, params }) => {
        const found = await getMessage(env.DB, params.id);
        if (!found) throw new NotFoundError("Message not found");
        return json({ ...found, deliveryAvailable: await deliveryAvailable(env, env.DB, found.message.channel) });
    },
    "module.communications",
);
add(
    "POST",
    "/api/portal/wedding/messages/:id/retry",
    "wedding.comms.send",
    async ({ env, user, params }) => json({ message: await retryFailed(env, env.DB, params.id, user.email) }),
    "module.communications",
);
add(
    "GET",
    "/api/portal/wedding/comms/status",
    "wedding.comms.edit",
    async ({ env }) =>
        json({
            providers: providerStatus(env),
            email: await deliveryAvailable(env, env.DB, "email"),
            sms: await deliveryAvailable(env, env.DB, "sms"),
        }),
    "module.communications",
);
// Text conversations hold guests' own words, so reading them needs the communications permission.
add("GET", "/api/portal/wedding/sms", "wedding.comms.edit", async ({ env }) => json({ threads: await listSmsThreads(env.DB) }), "module.communications");
add(
    "GET",
    "/api/portal/wedding/sms/:phone",
    "wedding.comms.edit",
    async ({ env, user, params }) => json(await smsConversation(env.DB, params.phone, user.email)),
    "module.communications",
);
add(
    "POST",
    "/api/portal/wedding/sms",
    "wedding.comms.send",
    async ({ env, request, user }) => json({ sms: await sendSmsReply(env, env.DB, await readJson(request), user.email) }, 201),
    "module.communications",
);
add(
    "POST",
    "/api/portal/wedding/messages/:id/send",
    "wedding.comms.send",
    async ({ env, request, user, params }) => json({ message: await sendMessage(env, env.DB, params.id, user.email, false, await readJson(request)) }),
    "module.communications",
);
// Printable Save the Date and Thank You cards: one A5 page per household. Printing isn't delivery.
add(
    "POST",
    "/api/portal/wedding/studio/cards.pdf",
    "wedding.export",
    async ({ env, request, user }) => {
        const body = await readJson(request);
        const pdf = await printableCards(env, env.DB, body);
        const kind = (body as { kind?: string }).kind === "thank_you" ? "thank-you" : "save-the-date";
        await audit(env.DB, {
            actor: user.email,
            action: `export.cards.${kind}`,
            entityType: "message",
            summary: `Generated printable ${kind === "thank-you" ? "thank-you" : "save-the-date"} cards (PDF; nothing sent)`,
        });
        return new Response(new Uint8Array(pdf).buffer, {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="${kind}-cards.pdf"`,
                "Cache-Control": "no-store",
            },
        });
    },
    "module.communications",
);
add(
    "GET",
    "/api/portal/wedding/thank-you-notes",
    "wedding.comms.edit",
    async ({ env }) => json({ notes: await listThankYouNotes(env.DB) }),
    "module.communications",
);
add(
    "PUT",
    "/api/portal/wedding/thank-you-notes/:id",
    "wedding.comms.edit",
    async ({ env, request, user, params }) => json(await saveThankYouNote(env.DB, params.id, await readJson(request), user.email)),
    "module.communications",
);
// The PDF a household's invitation email will carry, exactly as it will be attached.
add(
    "GET",
    "/api/portal/wedding/messages/:id/invitation.pdf",
    "wedding.export",
    async ({ env, request, params }) => {
        const query = new URL(request.url).searchParams;
        const pdf = await messageInvitationPdf(env, env.DB, params.id, query.get("household") ?? "", query.get("guest"));
        return new Response(new Uint8Array(pdf.bytes).buffer, {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="${safeFilename(pdf.filename)}"`,
                "Cache-Control": "no-store",
            },
        });
    },
    "module.communications",
);
// The send check: who a message would reach now, who's held back and why, and what to watch for.
add(
    "GET",
    "/api/portal/wedding/messages/:id/preflight",
    "wedding.view",
    async ({ env, params }) => json({ preflight: await preflight(env, env.DB, params.id) }),
    "module.communications",
);
add(
    "POST",
    "/api/portal/wedding/messages/:id/schedule",
    "wedding.comms.send",
    async ({ env, request, user, params }) => json({ message: await scheduleMessage(env, env.DB, params.id, await readJson(request), user.email) }),
    "module.communications",
);
// A controlled test, only ever to the owner-approved test recipients.
add(
    "POST",
    "/api/portal/wedding/messages/:id/test",
    "wedding.comms.send",
    async ({ env, request, user, params }) => json(await sendTest(env, env.DB, params.id, await readJson(request), user.email)),
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
                { header: "Mobile", value: (r) => formatMobile(r.phone) },
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

/** A JSON response with RSVP codes and signed links removed (see hideCredentials). Files are refused by permission instead. */
async function withoutCredentials(response: Response) {
    if (!(response.headers.get("Content-Type") ?? "").includes("application/json")) return response;
    const body = hideCredentials(await response.json());
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
}

export async function handlePortalApi(request: Request, env: Env, user: PortalUser, exec?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
    const url = new URL(request.url);
    try {
        checkCrossSite(request);
        checkMutation(request, env);
        // Knowledge has its own router: access there is by space membership, and its responses hold no RSVP credentials.
        if (url.pathname.startsWith("/api/portal/knowledge/")) return await handleKnowledgeApi(request, env, user);
        // So does Tasks: access there is by project membership.
        if (url.pathname.startsWith("/api/portal/tasks/")) return await handleTasksApi(request, env, user);
        // And Calendar: access there is by calendar membership, and leave is always the caller's own.
        if (url.pathname.startsWith("/api/portal/calendar/")) return await handleCalendarApi(request, env, user);
        // And Intelligence: everything there is the caller's own, or reached through their memberships.
        if (url.pathname.startsWith("/api/portal/intelligence/")) return await handleIntelligenceApi(request, env, user, exec);
        // And the Intelligence Centre: public records for everyone with centre.use; watch areas, alerts and wallboards per person.
        if (url.pathname.startsWith("/api/portal/centre/")) return await handleCentreApi(request, env, user, exec);
        // And Home & Assets: access there is per asset (owner, or what it's shared with you for).
        if (url.pathname.startsWith("/api/portal/assets/")) return await handleAssetsApi(request, env, user);
        // And Today: it needs Calendar and Tasks, and reads and changes everything through theirs.
        if (url.pathname === "/api/portal/today" || url.pathname.startsWith("/api/portal/today/")) return await handleTodayApi(request, env, user);
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
            const response = await route.handler(ctx);
            return can(user, CREDENTIAL_PERMISSION) ? response : await withoutCredentials(response);
        }
        if (pathMatched) throw new HttpError(405, "method_not_allowed", "Method not allowed");
        throw new HttpError(404, "not_found", "Not found");
    } catch (error) {
        return errorResponse(error, url.pathname);
    }
}
