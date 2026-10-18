// Daly Intelligence tools for the MCP gateway (docs/INTELLIGENCE.md, docs/MCP.md).
//
// They call the same functions as the portal's Intelligence API, as the person the Access token
// proves. Reads cost no inference except semantic search (one embedding, within the person's
// budget). The writes only ever do what the person could do in the portal:
//   intelligence_capture_text and intelligence_request_analysis queue a capture for analysis,
//     which proposes suggestions. Nothing is written to Tasks or Knowledge by them.
//   intelligence_approve_suggestion applies one suggestion the person has explicitly approved,
//     through the same checks as the Approve button. There's no bulk approval, no dismissing on
//     someone's behalf, no deleting, and no way to start background jobs except a capture.
import { z } from "zod";
import { approveSuggestion, listSuggestions, suggestionView } from "../intelligence/suggestions";
import { getBriefing } from "../intelligence/briefings";
import { createCapture, ownCapture } from "../intelligence/capture";
import { nudge } from "../intelligence/runner";
import { hybridSearch, relatedWithMeaning } from "../intelligence/semantic";
import { loadConfig } from "../intelligence/settings";
import { captureDetail, intelligenceStatus, listCaptures } from "../intelligence/views";
import { type ToolContext, type ToolDef, calendarDate, id, limit, portalUrl, requestId, tool } from "./shared";

const objectId = id("kob", "Knowledge object");
const spaceId = id("ksp", "Knowledge space");
const captureId = id("aic", "capture");
const suggestionId = id("ais", "suggestion");

const captureOut = (ctx: ToolContext, c: { id: string; title: string; source: string; status: string; pending: number; errorCode: string | null; job: { status: string; progress: unknown; errorCode: string | null } | null }) => ({
    id: c.id,
    title: c.title,
    source: c.source,
    status: c.status,
    pendingSuggestions: c.pending,
    errorCode: c.errorCode,
    job: c.job ? { status: c.job.status, progress: c.job.progress, errorCode: c.job.errorCode } : null,
    url: portalUrl(ctx, `/portal/intelligence/captures/${c.id}`),
});

// --- Reads ---------------------------------------------------------------------------------------

const semanticSearch = tool({
    name: "knowledge_semantic_search",
    write: false,
    permission: "knowledge.use",
    input: z.object({ query: z.string().trim().min(1).max(300), spaceId: spaceId.optional(), type: z.string().max(40).optional(), limit: limit(10, 25) }).strict(),
    run: async (ctx, input) => {
        const { config } = await loadConfig(ctx.db);
        const result = await hybridSearch(ctx.env, config, ctx.user, input.query, { spaceId: input.spaceId ?? null, typeId: input.type ?? null, limit: input.limit, site: ctx.site });
        return {
            data: {
                mode: result.mode,
                ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
                count: result.hits.length,
                results: result.hits.map((h) => ({ objectId: h.object.id, spaceId: h.object.spaceId, title: h.object.title || "Untitled", tags: h.object.tags, excerpt: h.excerpt, matchedBy: h.matchedBy, updatedAt: h.object.updatedAt, url: h.url })),
            },
        };
    },
});

const findRelated = tool({
    name: "knowledge_find_related",
    write: false,
    permission: "knowledge.use",
    input: z.object({ objectId }).strict(),
    run: async (ctx, input) => {
        const { config } = await loadConfig(ctx.db);
        const { related, semantic } = await relatedWithMeaning(ctx.env, config, ctx.user, input.objectId, ctx.site);
        return {
            data: {
                semantic,
                note: "Suggestions only: nothing has been linked. Possible duplicates are flagged, never merged.",
                related: related.map((r) => ({ objectId: r.object.id, title: r.object.title || "Untitled", reasons: r.reasons, strength: r.strength, possibleDuplicate: r.possibleDuplicate, url: r.url })),
            },
        };
    },
});

const briefingOut = (view: Awaited<ReturnType<typeof getBriefing>>) => ({
    kind: view.kind,
    period: view.period,
    checked: view.checked,
    notChecked: view.notChecked,
    facts: view.sections.map((s) => ({ section: s.title, count: s.count, items: s.items })),
    recommendations: { status: view.recommendations.status, label: "AI suggestions, not facts", items: view.recommendations.items },
    changesSincePrevious: view.changesSincePrevious,
});

const dailyBriefing = tool({
    name: "intelligence_get_daily_briefing",
    write: false,
    permission: "intelligence.use",
    input: z.object({}).strict(),
    // Facts, plus recommendations only if the portal already prepared them for these facts: reading never triggers inference.
    run: async (ctx) => ({ data: briefingOut(await getBriefing(ctx.env, ctx.user, "daily", { site: ctx.site })) }),
});

const weeklyReview = tool({
    name: "intelligence_get_weekly_review",
    write: false,
    permission: "intelligence.use",
    input: z.object({ weekEnding: calendarDate.optional() }).strict(),
    run: async (ctx, input) => ({ data: briefingOut(await getBriefing(ctx.env, ctx.user, "weekly", { site: ctx.site, period: input.weekEnding })) }),
});

const listOwnSuggestions = tool({
    name: "intelligence_list_suggestions",
    write: false,
    permission: "intelligence.use",
    input: z.object({ status: z.enum(["pending", "applied", "dismissed", "all"]).default("pending"), captureId: captureId.optional(), limit: limit(25, 100) }).strict(),
    run: async (ctx, input) => {
        const list = await listSuggestions(ctx.db, ctx.user, ctx.site, { filter: input.status, captureId: input.captureId, limit: input.limit + 1 });
        return {
            data: {
                count: Math.min(list.length, input.limit),
                truncated: list.length > input.limit,
                suggestions: list.slice(0, input.limit).map((s) => ({
                    id: s.id,
                    kind: s.kind,
                    status: s.status,
                    version: s.version,
                    proposal: s.payload,
                    names: s.labels,
                    reason: s.reason,
                    evidence: s.evidence,
                    confidence: s.confidence,
                    dependsOn: s.dependsOn,
                    capture: s.capture,
                    result: s.result,
                    url: portalUrl(ctx, "/portal/intelligence/inbox"),
                })),
            },
        };
    },
});

const processingStatus = tool({
    name: "intelligence_get_processing_status",
    write: false,
    permission: "intelligence.use",
    input: z.object({ captureId: captureId.optional() }).strict(),
    run: async (ctx, input) => {
        const status = await intelligenceStatus(ctx.env, ctx.user);
        if (input.captureId) {
            const detail = await captureDetail(ctx.env, ctx.user, input.captureId, ctx.site);
            return { data: { available: status.available, capture: captureOut(ctx, detail) } };
        }
        return { data: { available: status.available, circuitOpen: status.circuitOpen, captures: (await listCaptures(ctx.db, ctx.user, { limit: 15 })).map((c) => captureOut(ctx, c)) } };
    },
});

const getTranscript = tool({
    name: "meetings_get_transcript",
    write: false,
    permission: "intelligence.use",
    input: z.object({ captureId, maxCharacters: z.number().int().min(1_000).max(60_000).default(30_000) }).strict(),
    run: async (ctx, input) => {
        const detail = await captureDetail(ctx.env, ctx.user, input.captureId, ctx.site);
        if (!detail.transcript || detail.text === null) return { data: { captureId: detail.id, status: detail.status, available: false, reason: "No transcript yet" } };
        return {
            data: {
                captureId: detail.id,
                title: detail.title,
                language: detail.language,
                durationSeconds: detail.transcript.durationSeconds,
                speakers: "not identified (the transcription model doesn't separate speakers)",
                text: detail.text.slice(0, input.maxCharacters),
                truncated: detail.text.length > input.maxCharacters || detail.textTruncated,
                url: portalUrl(ctx, `/portal/intelligence/captures/${detail.id}`),
            },
        };
    },
});

// --- Writes --------------------------------------------------------------------------------------

const captured = async (ctx: ToolContext, result: Awaited<ReturnType<typeof createCapture>>) => {
    if (!result.needsApproval) nudge(ctx.env, ctx.exec, result.jobId);
    return {
        data: {
            captureId: result.captureId,
            jobId: result.jobId,
            replayed: result.replayed,
            ...(result.needsApproval ? { needsConfirmation: "This is large enough that the person must confirm the estimated cost in the portal before it runs." } : {}),
            next: "Suggestions appear for review shortly. Use intelligence_get_processing_status, then intelligence_list_suggestions. Nothing is created until a suggestion is approved.",
            url: portalUrl(ctx, `/portal/intelligence/captures/${result.captureId}`),
        },
        outcome: { entityType: "ai_capture" as const, entityId: result.captureId },
    };
};

const replayCapture = async (ctx: ToolContext, outcome: { entityId: string }) => {
    const capture = await ownCapture(ctx.env, ctx.user.email, outcome.entityId);
    return { data: { captureId: capture.id, replayed: true, status: capture.status, url: portalUrl(ctx, `/portal/intelligence/captures/${capture.id}`) } };
};

const captureText = tool({
    name: "intelligence_capture_text",
    write: true,
    permission: "intelligence.use",
    input: z.object({ text: z.string().trim().min(1).max(60_000), title: z.string().trim().max(300).optional(), spaceId: spaceId.optional(), requestId }).strict(),
    run: async (ctx, input) => captured(ctx, await createCapture(ctx.env, ctx.user, { source: "mcp", text: input.text, title: input.title, spaceId: input.spaceId, requestKey: input.requestId })),
    replay: replayCapture,
});

const requestAnalysis = tool({
    name: "intelligence_request_analysis",
    write: true,
    permission: "intelligence.use",
    input: z.object({ objectId, requestId }).strict(),
    run: async (ctx, input) => captured(ctx, await createCapture(ctx.env, ctx.user, { source: "knowledge", objectId: input.objectId, requestKey: input.requestId })),
    replay: replayCapture,
});

const approve = tool({
    name: "intelligence_approve_suggestion",
    write: true,
    permission: "intelligence.use",
    input: z.object({ suggestionId, version: z.number().int().min(1).optional(), requestId }).strict(),
    run: async (ctx, input) => {
        const s = await approveSuggestion(ctx.env, ctx.user, input.suggestionId, input.version ? { version: input.version } : {}, ctx.site);
        return { data: { suggestion: { id: s.id, kind: s.kind, status: s.status, result: s.result } }, outcome: { entityType: "ai_suggestion" as const, entityId: s.id } };
    },
    replay: async (ctx, outcome) => {
        const s = await suggestionView(ctx.db, ctx.user, outcome.entityId, ctx.site);
        return { data: { suggestion: { id: s.id, kind: s.kind, status: s.status, result: s.result }, replayed: true } };
    },
});

export const INTELLIGENCE_TOOLS: ToolDef[] = [semanticSearch, findRelated, dailyBriefing, weeklyReview, listOwnSuggestions, processingStatus, getTranscript, captureText, requestAnalysis, approve];
