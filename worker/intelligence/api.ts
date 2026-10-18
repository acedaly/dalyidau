// JSON API for Daly Intelligence (/api/portal/intelligence/*). The portal router has already
// verified the Access identity, the portal role and the same-origin rules. This router adds the
// "intelligence.use" permission; every handler then works only on the caller's own captures,
// suggestions, jobs and files, and on Knowledge and Tasks through their own memberships.
import type { ExecutionContext } from "@cloudflare/workers-types";
import { z } from "zod";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { requireSpace } from "../knowledge/access";
import { can } from "../portal/auth";
import { HttpError, json, readJson } from "../portal/http";
import {
    PART_BYTES,
    completeUpload,
    deleteAttachment,
    downloadAttachment,
    keepInKnowledge,
    keepWithTask,
    startUpload,
    storageSummary,
    toAttachmentView,
    uploadPart,
} from "./attachments";
import { getBriefing } from "./briefings";
import { createCapture, ownCapture } from "./capture";
import { approveJob, cancelJob, getJob, ownJob, retryJob, toJobView } from "./jobs";
import { nudge, runOwnJobNow } from "./runner";
import { hybridSearch, relatedWithMeaning, requestReindex, syncSemanticIndex } from "./semantic";
import { loadConfig, loadPreferences, saveConfig, savePreferences, setExclusion } from "./settings";
import { approveMany, approveSuggestion, dismissSuggestion, editSuggestion, listSuggestions } from "./suggestions";
import { usageSummary } from "./usage";
import { captureDetail, intelligenceStatus, listCaptures } from "./views";

interface Ctx {
    env: Env;
    request: Request;
    url: URL;
    user: PortalUser;
    params: Record<string, string>;
    site: string;
    exec?: Pick<ExecutionContext, "waitUntil">;
}

type Handler = (ctx: Ctx) => Promise<Response>;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
        `^/api/portal/intelligence${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
            keys.push(key);
            return "([^/]+)";
        })}$`,
    );
    routes.push({ method, pattern, keys, handler });
};

const requireManage = (user: PortalUser) => {
    if (!can(user, "portal.settings.manage")) throw new HttpError(403, "forbidden", "Only owners and admins can change Intelligence settings");
};
const requireKnowledge = (user: PortalUser) => {
    if (!can(user, "knowledge.use")) throw new HttpError(403, "forbidden", "You don't have access to Knowledge");
};

// --- Status, settings, preferences, usage ----------------------------------------------------------

add("GET", "/status", async ({ env, user }) => json({ status: await intelligenceStatus(env, user) }));

add("GET", "/settings", async ({ env }) => json(await loadConfig(env.DB)));
add("PUT", "/settings", async ({ env, request, user }) => {
    requireManage(user);
    const body = z
        .object({ version: z.number().int().min(0), config: z.unknown() })
        .strict()
        .parse(await readJson(request));
    return json(await saveConfig(env.DB, user, body.config, body.version));
});

add("GET", "/preferences", async ({ env, user }) => json(await loadPreferences(env.DB, user.email)));
add("PUT", "/preferences", async ({ env, request, user }) => {
    const body = z
        .object({ version: z.number().int().min(0), preferences: z.unknown() })
        .strict()
        .parse(await readJson(request));
    return json(await savePreferences(env.DB, user, body.preferences, body.version));
});

add("POST", "/exclusions", async ({ env, request, user }) => {
    requireKnowledge(user);
    const body = z
        .object({
            spaceId: z.string().regex(/^ksp_[a-z0-9]{14}$/),
            objectId: z
                .string()
                .regex(/^kob_[a-z0-9]{14}$/)
                .nullable()
                .optional(),
            excluded: z.boolean(),
        })
        .strict()
        .parse(await readJson(request));
    await setExclusion(env.DB, user, { spaceId: body.spaceId, objectId: body.objectId ?? null }, body.excluded);
    return json({ ok: true });
});

add("GET", "/usage", async ({ env, user }) => json({ usage: await usageSummary(env.DB, (await loadConfig(env.DB)).config, user.email) }));
add("GET", "/storage", async ({ env, user }) => json({ storage: await storageSummary(env.DB, user) }));

// --- Semantic search -------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
add("GET", "/search", async ({ env, url, user, site }) => {
    requireKnowledge(user);
    const q = (url.searchParams.get("q") ?? "").slice(0, 300);
    const status = url.searchParams.get("status");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const { config } = await loadConfig(env.DB);
    return json(
        await hybridSearch(env, config, user, q, {
            spaceId: url.searchParams.get("space"),
            typeId: url.searchParams.get("type") || null,
            tag: url.searchParams.get("tag") || null,
            status: status === "archived" || status === "any" ? status : "active",
            updatedFrom: from && DATE.test(from) ? from : null,
            updatedTo: to && DATE.test(to) ? to : null,
            limit: Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50),
            site,
        }),
    );
});

add("GET", "/objects/:id/related", async ({ env, user, params, site }) => {
    requireKnowledge(user);
    const { config } = await loadConfig(env.DB);
    return json(await relatedWithMeaning(env, config, user, params.id, site));
});

add("POST", "/semantic/sync", async ({ env, user }) => {
    requireManage(user);
    const { config } = await loadConfig(env.DB);
    return json({ report: await syncSemanticIndex(env, config) });
});

add("POST", "/semantic/reindex", async ({ env, request, user }) => {
    requireKnowledge(user);
    const { spaceId } = z
        .object({ spaceId: z.string().regex(/^ksp_[a-z0-9]{14}$/) })
        .strict()
        .parse(await readJson(request));
    await requireSpace(env.DB, user, spaceId, "owner");
    await requestReindex(env.DB, spaceId);
    return json({ ok: true });
});

// --- Captures --------------------------------------------------------------------------------------

add("POST", "/captures", async ({ env, request, user, exec }) => {
    const result = await createCapture(env, user, await readJson(request, 300_000));
    if (!result.needsApproval) nudge(env, exec, result.jobId);
    return json(result, result.replayed ? 200 : 201);
});
add("GET", "/captures", async ({ env, url, user }) => {
    const source = url.searchParams.get("source");
    return json({ captures: await listCaptures(env.DB, user, { source: source === "audio" || source === "other" ? source : undefined }) });
});
add("GET", "/captures/:id", async ({ env, user, params, site }) => json({ capture: await captureDetail(env, user, params.id, site) }));
add("GET", "/captures/:id/transcript", async ({ env, user, params, site }) => {
    const detail = await captureDetail(env, user, params.id, site);
    if (!detail.transcript) throw new HttpError(404, "not_found", "This capture has no transcript");
    return json({ text: detail.text, truncated: detail.textTruncated, transcript: detail.transcript });
});
add("POST", "/captures/:id/cancel", async ({ env, user, params }) => {
    const capture = await ownCapture(env, user.email, params.id);
    const job = await env.DB.prepare("SELECT id FROM ai_jobs WHERE subject_id = ? AND email = ? AND status IN ('queued', 'running', 'waiting_approval')")
        .bind(capture.id, user.email)
        .first<{ id: string }>();
    if (job) await cancelJob(env.DB, user.email, job.id);
    await env.DB.prepare("UPDATE ai_captures SET status = 'cancelled', updated_at = ? WHERE id = ? AND email = ? AND status NOT IN ('ready', 'failed')")
        .bind(new Date().toISOString(), capture.id, user.email)
        .run();
    return json({ ok: true });
});

// --- Suggestions -----------------------------------------------------------------------------------

add("GET", "/suggestions", async ({ env, url, user, site }) => {
    const filter = url.searchParams.get("filter");
    return json({
        suggestions: await listSuggestions(env.DB, user, site, {
            filter: filter === "applied" || filter === "dismissed" || filter === "all" ? filter : "pending",
            captureId: url.searchParams.get("capture") ?? undefined,
        }),
    });
});
add("POST", "/suggestions/approve", async ({ env, request, user, site }) => json(await approveMany(env, user, await readJson(request), site)));
add("PATCH", "/suggestions/:id", async ({ env, request, user, params, site }) =>
    json({ suggestion: await editSuggestion(env.DB, user, params.id, await readJson(request, 100_000), site) }),
);
add("POST", "/suggestions/:id/approve", async ({ env, request, user, params, site }) =>
    json({ suggestion: await approveSuggestion(env, user, params.id, await readJson(request), site) }),
);
add("POST", "/suggestions/:id/dismiss", async ({ env, user, params }) => {
    await dismissSuggestion(env.DB, user, params.id);
    return json({ ok: true });
});

// --- Jobs ------------------------------------------------------------------------------------------

add("GET", "/jobs/:id", async ({ env, user, params }) => json({ job: toJobView(await ownJob(env.DB, user.email, params.id)) }));
add("POST", "/jobs/:id/run", async ({ env, user, params }) => {
    await ownJob(env.DB, user.email, params.id);
    await runOwnJobNow(env, params.id);
    return json({ job: toJobView((await getJob(env.DB, params.id))!) });
});
add("POST", "/jobs/:id/cancel", async ({ env, user, params }) => json({ job: toJobView(await cancelJob(env.DB, user.email, params.id)) }));
add("POST", "/jobs/:id/retry", async ({ env, user, params, exec }) => {
    const job = await retryJob(env.DB, user.email, params.id);
    await env.DB.prepare("UPDATE ai_captures SET status = 'received', error_code = NULL WHERE id = ? AND email = ? AND status IN ('failed', 'cancelled')")
        .bind(job.subject_id, user.email)
        .run();
    nudge(env, exec, job.id);
    return json({ job: toJobView(job) });
});
add("POST", "/jobs/:id/approve", async ({ env, user, params, exec }) => {
    const job = await approveJob(env.DB, user.email, params.id);
    nudge(env, exec, job.id);
    return json({ job: toJobView(job) });
});

// --- Attachments -----------------------------------------------------------------------------------

add("POST", "/attachments", async ({ env, request, user }) => {
    const { config } = await loadConfig(env.DB);
    return json(await startUpload(env.DB, env.MEDIA, config, user, await readJson(request)), 201);
});
add("POST", "/attachments/:id/parts/:part", async ({ env, request, user, params }) =>
    json(await uploadPart(env.DB, env.MEDIA, user, params.id, Number(params.part), await readJson(request, Math.ceil((PART_BYTES * 4) / 3) + 1_000))),
);
add("POST", "/attachments/:id/complete", async ({ env, user, params }) =>
    json({ attachment: toAttachmentView(await completeUpload(env.DB, env.MEDIA, user, params.id)) }),
);
add("GET", "/attachments/:id/download", async ({ env, user, params }) => downloadAttachment(env.DB, env.MEDIA, user, params.id));
add("POST", "/attachments/:id/keep", async ({ env, request, user, params }) => {
    const body = z
        .object({
            objectId: z
                .string()
                .regex(/^kob_[a-z0-9]{14}$/)
                .optional(),
            taskId: z
                .string()
                .regex(/^tsk_[a-z0-9]{14}$/)
                .optional(),
        })
        .strict()
        .refine((b) => !!b.objectId !== !!b.taskId, "Choose a Knowledge object or a task")
        .parse(await readJson(request));
    const row = body.objectId ? await keepInKnowledge(env.DB, user, params.id, body.objectId) : await keepWithTask(env.DB, user, params.id, body.taskId!);
    return json({ attachment: toAttachmentView(row) });
});
add("POST", "/attachments/:id/delete", async ({ env, request, user, params }) => {
    await deleteAttachment(env.DB, env.MEDIA, user, params.id, await readJson(request));
    return json({ ok: true });
});

// --- Briefings -------------------------------------------------------------------------------------

const kindOf = (value: string) => {
    if (value !== "daily" && value !== "weekly") throw new HttpError(404, "not_found", "Not found");
    return value;
};
add("GET", "/briefings/:kind", async ({ env, user, params, site }) => json({ briefing: await getBriefing(env, user, kindOf(params.kind), { site }) }));
add("POST", "/briefings/:kind/recommend", async ({ env, user, params, site }) =>
    json({ briefing: await getBriefing(env, user, kindOf(params.kind), { site, recommend: true }) }),
);

// --- Dispatch --------------------------------------------------------------------------------------

export async function handleIntelligenceApi(request: Request, env: Env, user: PortalUser, exec?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
    if (!can(user, "intelligence.use")) throw new HttpError(403, "forbidden", "You don't have access to Intelligence");
    const url = new URL(request.url);
    const method = request.method === "HEAD" ? "GET" : request.method;
    let pathMatched = false;
    for (const route of routes) {
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
        return route.handler({ env, request, url, user, params, site: new URL(env.SITE_URL).origin, exec });
    }
    if (pathMatched) throw new HttpError(405, "method_not_allowed", "Method not allowed");
    throw new HttpError(404, "not_found", "Not found");
}
