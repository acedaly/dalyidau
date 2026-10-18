// Intelligent Capture: hand the portal some text, a document, a recording or a Knowledge object and
// get back suggestions to review. Nothing is written to Tasks or Knowledge here.
//
// Grounding rules, applied to everything a model returns (and tested):
//   * Every item must quote its evidence, and the quote must be found in the source. An item that
//     cites text the source doesn't contain is dropped: that's what an invented commitment looks like.
//   * Names the model attaches (an owner, a project, someone being waited on) are kept only if they
//     appear in the source too.
//   * Dates must be real calendar dates within a sensible range, and keep how certain they are
//     ("explicit", "inferred"). "none" means no date, whatever the model put in the date field.
//   * Ids are never taken from a model. Projects are matched against the person's own projects by
//     name; Knowledge links come from the existing related-content engine; both through the same
//     access checks as the portal.
import { z } from "zod";
import { estimateTextNeurons, estimateTokens } from "../../src/shared/intelligence/config";
import type { CaptureSource } from "../../src/shared/intelligence/types";
import { type SuggestionKind, type SuggestionPayload, payloadSchemas } from "../../src/shared/intelligence/types";
import { isCalendarDate } from "../../src/shared/knowledge/dates";
import type { PortalUser } from "../../src/shared/portal/types";
import { addDays } from "../../src/shared/tasks/dates";
import type { Env } from "../env";
import { ensurePersonalSpace, requireObject, requireSpace } from "../knowledge/access";
import { relatedObjects } from "../knowledge/related";
import { matchProject, normaliseName } from "../mcp/projects";
import { can } from "../portal/auth";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import { preferences, todayFor } from "../tasks/access";
import { listProjects } from "../tasks/projects";
import { type JobContext, PermanentFailure, type StepResult, enqueue, willFail } from "./jobs";
import { EXTRACT_SYSTEM, MEETING_SYSTEM, fence } from "./prompts";
import { generateJson } from "./provider";
import { availability, excludedObjects, loadConfig } from "./settings";
import { sha256 } from "./semantic";
import type { IntelligenceConfig } from "../../src/shared/intelligence/config";

// --- Model output ----------------------------------------------------------------------------------

const loose = z.string().max(2_000);
const item = z.object({
    kind: z.enum(["task", "follow_up", "decision", "fact"]),
    title: loose.optional(),
    statement: loose.optional(),
    dueDate: z.string().nullable().optional(),
    dueText: z.string().max(200).nullable().optional(),
    dateCertainty: z.enum(["explicit", "inferred", "none"]).optional(),
    decidedOn: z.string().nullable().optional(),
    priority: z.number().int().min(1).max(4).optional(),
    owner: z.string().max(120).nullable().optional(),
    waitingOn: z.string().max(120).nullable().optional(),
    project: z.string().max(120).nullable().optional(),
    evidence: z.string().max(1_000).nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
});

/** Items are validated one by one: a malformed item is dropped, the rest kept. */
export const extractionSchema = z.object({
    summary: z.string().max(6_000).default(""),
    tags: z.array(z.string().max(50)).max(20).default([]),
    items: z.array(z.unknown()).max(60).default([]),
    questions: z.array(z.string().max(300)).max(10).default([]),
});

export type ExtractedItem = z.output<typeof item>;

// --- Grounding -------------------------------------------------------------------------------------

const squash = (text: string) =>
    text
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/\s+/g, " ")
        .trim();

/** Whether the quote (or, for a long one, its first 80 characters) is in the source. */
export const grounded = (source: string, quote: string | null | undefined) => {
    const q = squash(quote ?? "").replace(/^["'“]|["'”]$/g, "");
    if (q.length < 4) return false;
    return squash(source).includes(q.length > 80 ? q.slice(0, 80) : q);
};

const mentioned = (source: string, name: string | null | undefined) => (name && squash(source).includes(squash(name)) ? name.trim() : null);

/** A date the item can carry: real, and between a year ago and five years ahead. */
export function plausibleDate(value: string | null | undefined, today: string): string | null {
    if (!value || !isCalendarDate(value)) return null;
    return value >= addDays(today, -366) && value <= addDays(today, 5 * 366) ? value : null;
}

export interface DraftSuggestion {
    kind: SuggestionKind;
    payload: SuggestionPayload;
    reason: string | null;
    evidence: string | null;
    confidence: number | null;
    /** The project name a task suggestion should be filed under, resolved after projects are matched. */
    projectName?: string | null;
    /** For a task in a project suggestion (resolved to its id once created). */
    dependsOnKey?: string;
    key: string;
}

const keyOf = async (kind: string, text: string) => `${kind}:${(await sha256(normaliseName(text))).slice(0, 24)}`;

/** Turns validated model output into grounded drafts. Pure: no database. */
export async function draftsFrom(
    source: string,
    output: z.output<typeof extractionSchema>,
    context: { today: string; spaceId: string | null; captureKind: CaptureSource },
): Promise<{ drafts: DraftSuggestion[]; dropped: number }> {
    const drafts: DraftSuggestion[] = [];
    let dropped = 0;
    for (const raw of output.items) {
        const parsed = item.safeParse(raw);
        if (!parsed.success) {
            dropped++;
            continue;
        }
        const it = parsed.data;
        if (!grounded(source, it.evidence)) {
            dropped++;
            continue;
        }
        const evidence = (it.evidence ?? "").trim().slice(0, 300);
        const confidence = typeof it.confidence === "number" ? Math.round(it.confidence * 100) / 100 : null;
        const certainty = it.dateCertainty ?? "none";
        const dueDate = certainty === "none" ? null : plausibleDate(it.dueDate, context.today);
        const dueText = it.dueText ? mentioned(source, it.dueText) : null;
        if (it.kind === "task" || it.kind === "follow_up") {
            const titleText = (it.title ?? "").trim();
            if (!titleText) {
                dropped++;
                continue;
            }
            const owner = mentioned(source, it.owner);
            const projectName = mentioned(source, it.project);
            const payload =
                it.kind === "task"
                    ? payloadSchemas.task.safeParse({
                          title: titleText,
                          description: owner ? `Owner named in the source: ${owner}` : "",
                          dueDate,
                          dueText,
                          dateCertainty: dueDate ? certainty : "none",
                          priority: it.priority ?? 4,
                          owner,
                      })
                    : payloadSchemas.follow_up.safeParse({ title: titleText, waitingOn: mentioned(source, it.waitingOn), dueDate, dueText, dateCertainty: dueDate ? certainty : "none" });
            if (!payload.success) {
                dropped++;
                continue;
            }
            drafts.push({
                kind: it.kind,
                payload: payload.data,
                reason: it.kind === "task" ? "An action in the source" : "Something you're waiting on",
                evidence,
                confidence,
                projectName,
                key: await keyOf(it.kind, titleText),
            });
        } else if (it.kind === "decision" && context.spaceId) {
            const payload = payloadSchemas.decision.safeParse({ spaceId: context.spaceId, title: it.title ?? "", text: evidence, decidedOn: plausibleDate(it.decidedOn, context.today) });
            if (!payload.success) {
                dropped++;
                continue;
            }
            drafts.push({ kind: "decision", payload: payload.data, reason: "A decision recorded in the source", evidence, confidence, key: await keyOf("decision", it.title ?? "") });
        } else if (it.kind === "fact" && context.spaceId) {
            const payload = payloadSchemas.fact.safeParse({ statement: it.statement ?? it.title ?? "", spaceId: context.spaceId });
            if (!payload.success) {
                dropped++;
                continue;
            }
            drafts.push({ kind: "fact", payload: payload.data, reason: "A fact worth keeping", evidence, confidence, key: await keyOf("fact", payload.data.statement) });
        } else dropped++;
    }
    return { drafts, dropped };
}

// --- Captures --------------------------------------------------------------------------------------

export interface CaptureRow {
    id: string;
    email: string;
    space_id: string | null;
    source: CaptureSource;
    title: string;
    text: string | null;
    text_hash: string | null;
    source_object_id: string | null;
    attachment_id: string | null;
    status: "received" | "extracting" | "transcribing" | "analysing" | "ready" | "failed" | "cancelled";
    error_code: string | null;
    summary: string | null;
    language: string | null;
    request_key: string | null;
    created_at: string;
    updated_at: string;
    analysed_at: string | null;
}

export const ownCapture = async (env: Env, email: string, id: string) => {
    const row = await env.DB.prepare("SELECT * FROM ai_captures WHERE id = ? AND email = ?").bind(id, email).first<CaptureRow>();
    if (!row) throw new HttpError(404, "not_found", "Not found");
    return row;
};

const titleFrom = (text: string) =>
    (text.split(/\r?\n/).find((l) => l.trim()) ?? "Capture")
        .replace(/^#+\s*/, "")
        .trim()
        .slice(0, 120);

export const captureInput = z
    .object({
        source: z.enum(["text", "knowledge", "document", "audio", "mcp", "app"]),
        title: z.string().trim().max(300).optional(),
        text: z.string().max(200_000).optional(),
        objectId: z.string().regex(/^kob_[a-z0-9]{14}$/).optional(),
        attachmentId: z.string().regex(/^att_[a-z0-9]{14}$/).optional(),
        /** The Knowledge space suggestions should go to; the caller's personal space by default. */
        spaceId: z.string().regex(/^ksp_[a-z0-9]{14}$/).optional(),
        language: z.string().regex(/^[a-z]{2,3}$/).optional(),
        requestKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
    })
    .strict();

/** The capture's destination space: one the caller can edit, or none (task suggestions only). */
async function destinationSpace(env: Env, user: PortalUser, requested: string | undefined): Promise<string | null> {
    if (!can(user, "knowledge.use")) return null;
    if (requested) return (await requireSpace(env.DB, user, requested, "editor")).id;
    await ensurePersonalSpace(env.DB, user);
    const row = await env.DB.prepare("SELECT id FROM knowledge_spaces WHERE kind = 'personal' AND personal_owner = ?").bind(user.email).first<{ id: string }>();
    return row?.id ?? null;
}

export const analysisEstimate = (config: IntelligenceConfig, characters: number) => {
    const pieces = Math.max(1, Math.ceil(characters / config.limits.maxContextCharacters));
    const input = estimateTokens(Math.min(characters, pieces * config.limits.maxContextCharacters) + 3_000 * pieces);
    return Math.ceil(estimateTextNeurons(config.models.extract, input, 1_500 * pieces));
};

/**
 * Records a capture and queues its processing. Text and Knowledge captures go straight to analysis;
 * documents are extracted first and recordings transcribed first (meetings.ts, documents.ts).
 */
export async function createCapture(env: Env, user: PortalUser, input: unknown): Promise<{ captureId: string; jobId: string; replayed: boolean; needsApproval: boolean }> {
    const body = captureInput.parse(input);
    const { config } = await loadConfig(env.DB);
    const available = availability(env, config);
    const feature = body.source === "document" ? available.documents : body.source === "audio" ? available.meetings : available.capture;
    if (!config.features.enabled) throw new HttpError(409, "ai_off", "Intelligence is switched off.");
    if (!feature) throw new HttpError(409, "feature_off", "That kind of capture isn't switched on, or Workers AI isn't connected yet.");
    if (body.requestKey) {
        const earlier = await env.DB.prepare("SELECT id FROM ai_captures WHERE email = ? AND request_key = ?").bind(user.email, body.requestKey).first<{ id: string }>();
        if (earlier) {
            const job = await env.DB.prepare("SELECT id, status FROM ai_jobs WHERE subject_id = ? ORDER BY created_at DESC LIMIT 1").bind(earlier.id).first<{ id: string; status: string }>();
            return { captureId: earlier.id, jobId: job?.id ?? "", replayed: true, needsApproval: job?.status === "waiting_approval" };
        }
    }
    const spaceId = await destinationSpace(env, user, body.spaceId);
    let text: string | null = null;
    let title = body.title?.trim() || "";
    let sourceObjectId: string | null = null;
    let attachmentId: string | null = null;

    if (body.source === "knowledge") {
        if (!body.objectId) throw new HttpError(422, "validation", "Choose a Knowledge object");
        const access = await requireObject(env.DB, user, body.objectId);
        if (access.status === "trashed") throw new HttpError(404, "not_found", "Not found");
        if ((await excludedObjects(env.DB, [{ id: access.id, spaceId: access.space_id }])).size)
            throw new HttpError(422, "excluded", "That object, or its space, is excluded from AI processing.");
        const row = await env.DB.prepare("SELECT title, body_text FROM knowledge_objects WHERE id = ?").bind(access.id).first<{ title: string; body_text: string }>();
        text = `${row?.title ?? ""}\n\n${row?.body_text ?? ""}`.trim();
        title = title || row?.title || "Knowledge object";
        sourceObjectId = access.id;
    } else if (body.source === "document" || body.source === "audio") {
        if (!body.attachmentId) throw new HttpError(422, "validation", "Upload the file first");
        const row = await env.DB.prepare("SELECT id, filename, status, content_type FROM attachments WHERE id = ? AND owner_email = ?")
            .bind(body.attachmentId, user.email)
            .first<{ id: string; filename: string; status: string; content_type: string }>();
        if (!row || row.status !== "stored") throw new HttpError(422, "validation", "That upload isn't finished");
        if ((body.source === "audio") !== row.content_type.startsWith("audio/")) throw new HttpError(422, "validation", "That file is the wrong kind for this capture");
        attachmentId = row.id;
        title = title || row.filename;
    } else {
        text = (body.text ?? "").trim();
        if (!text) throw new HttpError(422, "validation", "Paste or type something to capture");
        title = title || titleFrom(text);
    }
    if (text && text.length > config.limits.maxCaptureCharacters)
        throw new HttpError(413, "too_large", `Captures can be up to ${config.limits.maxCaptureCharacters.toLocaleString("en-AU")} characters`);

    const id = newId("aic");
    const now = nowIso();
    const hash = text ? await sha256(text) : null;
    try {
        await env.DB.prepare(
            `INSERT INTO ai_captures (id, email, space_id, source, title, text, text_hash, source_object_id, attachment_id, status, language, request_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?)`,
        )
            .bind(id, user.email, spaceId, body.source, title.slice(0, 300), text, hash, sourceObjectId, attachmentId, body.language ?? null, body.requestKey ?? null, now, now)
            .run();
    } catch (error) {
        if (body.requestKey && /UNIQUE/.test(String((error as Error)?.message))) return createCapture(env, user, input);
        throw error;
    }
    if (attachmentId) await env.DB.prepare("UPDATE attachments SET capture_id = ? WHERE id = ?").bind(id, attachmentId).run();

    const kind = body.source === "audio" ? "meeting.transcribe" : body.source === "document" ? "document.extract" : "capture.analyse";
    const estimate = body.source === "audio" ? null : text ? analysisEstimate(config, text.length) : null;
    const needsApproval = estimate !== null && estimate > config.budgets.confirmAboveNeurons;
    const { job } = await enqueue(env.DB, { email: user.email, kind, subjectId: id, dedupeKey: `capture:${id}`, estimateNeurons: estimate, needsApproval });
    return { captureId: id, jobId: job.id, replayed: false, needsApproval };
}

// --- Analysis ------------------------------------------------------------------------------------

/** Names of the caller's projects they can add tasks to, for matching. */
async function writableProjects(env: Env, user: PortalUser, today: string) {
    if (!can(user, "tasks.use")) return [];
    return (await listProjects(env.DB, user.email, today)).filter((p) => !p.isInbox && p.status !== "archived" && p.role !== "viewer");
}

/**
 * Writes the drafts as pending suggestions. Tasks are filed under a matching existing project; a
 * project the source names that doesn't exist yet becomes one "New project" suggestion its tasks
 * depend on. Duplicates within the capture are skipped by the unique key, and a suggestion already
 * pending or applied for the same thing from another recent capture is skipped too.
 */
export async function saveSuggestions(env: Env, user: PortalUser, capture: CaptureRow, drafts: DraftSuggestion[], today: string) {
    const projects = await writableProjects(env, user, today);
    const newProjects = new Map<string, { id: string; name: string }>();
    const rows: { id: string; draft: DraftSuggestion; dependsOn: string | null }[] = [];
    for (const draft of drafts) {
        let dependsOn: string | null = null;
        if ((draft.kind === "task" || draft.kind === "follow_up") && draft.projectName && can(user, "tasks.use")) {
            const ranked = projects
                .map((p) => ({ p, match: matchProject(draft.projectName!, p) }))
                .filter((r) => r.match === "exact" || r.match === "similar")
                .sort((a, b) => (a.match === b.match ? 0 : a.match === "exact" ? -1 : 1));
            if (ranked[0]?.match === "exact" || ranked.length === 1) (draft.payload as SuggestionPayload<"task">).projectId = ranked[0].p.id;
            else {
                const key = normaliseName(draft.projectName);
                let project = newProjects.get(key);
                const dedupeKey = await keyOf("project", draft.projectName);
                // One pending "New project" per name: reuse one this or another capture already proposed.
                const pending = project
                    ? null
                    : await env.DB.prepare("SELECT id FROM ai_suggestions WHERE email = ? AND kind = 'project' AND status IN ('pending', 'applying') AND dedupe_key = ? ORDER BY created_at LIMIT 1")
                          .bind(user.email, dedupeKey)
                          .first<{ id: string }>();
                if (pending) {
                    project = { id: pending.id, name: draft.projectName };
                    newProjects.set(key, project);
                } else if (!project) {
                    project = { id: newId("ais"), name: draft.projectName };
                    newProjects.set(key, project);
                    rows.push({
                        id: project.id,
                        dependsOn: null,
                        draft: {
                            kind: "project",
                            payload: payloadSchemas.project.parse({ name: draft.projectName, similarProjectIds: ranked.slice(0, 5).map((r) => r.p.id) }),
                            reason: ranked.length ? "Named in the source; similar projects exist, so check before creating" : "Named in the source, and you don't have a project by that name",
                            evidence: draft.evidence,
                            confidence: draft.confidence,
                            key: dedupeKey,
                        },
                    });
                }
                (draft.payload as SuggestionPayload<"task">).projectSuggestionId = project.id;
                dependsOn = project.id;
            }
        }
        if (capture.source_object_id && (draft.kind === "task" || draft.kind === "follow_up"))
            (draft.payload as SuggestionPayload<"task">).knowledgeObjectIds = [capture.source_object_id];
        rows.push({ id: newId("ais"), draft, dependsOn });
    }

    const recent = new Set(
        (
            await env.DB.prepare(
                "SELECT dedupe_key FROM ai_suggestions WHERE email = ? AND status IN ('pending', 'applying', 'applied') AND created_at > ? AND capture_id IS NOT ?",
            )
                .bind(user.email, new Date(Date.now() - 30 * 86_400_000).toISOString(), capture.id)
                .all<{ dedupe_key: string }>()
        ).results.map((r) => r.dedupe_key),
    );
    const now = nowIso();
    const statements = rows
        // A new project is never skipped as a recent duplicate: tasks in this capture depend on it.
        .filter((r) => r.draft.kind === "project" || !recent.has(r.draft.key))
        .map((r) =>
            env.DB.prepare(
                `INSERT OR IGNORE INTO ai_suggestions (id, email, capture_id, kind, status, payload, reason, evidence, confidence, depends_on, dedupe_key, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(r.id, user.email, capture.id, r.draft.kind, JSON.stringify(r.draft.payload), r.draft.reason, r.draft.evidence, r.draft.confidence, r.dependsOn, r.draft.key, now, now),
        );
    for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
    return statements.length;
}

/** The suggestions about the capture itself: save it as a note or meeting record, tag or link its source object. */
async function recordDrafts(env: Env, user: PortalUser, capture: CaptureRow, output: z.output<typeof extractionSchema>): Promise<DraftSuggestion[]> {
    const drafts: DraftSuggestion[] = [];
    const tags = [...new Set(output.tags.map((t) => t.toLowerCase().replace(/^#/, "").trim()).filter((t) => t && t.length <= 50))].slice(0, 5);
    if (capture.source_object_id) {
        const existing = (
            await env.DB.prepare("SELECT t.name FROM knowledge_object_tags ot JOIN knowledge_tags t ON t.id = ot.tag_id WHERE ot.object_id = ?").bind(capture.source_object_id).all<{ name: string }>()
        ).results.map((r) => r.name.toLowerCase());
        const fresh = tags.filter((t) => !existing.includes(t));
        if (fresh.length)
            drafts.push({ kind: "tags", payload: payloadSchemas.tags.parse({ objectId: capture.source_object_id, tags: fresh }), reason: "Topics in this note", evidence: null, confidence: null, key: `tags:${capture.source_object_id}:${fresh.join(",")}` });
        // Links come from the existing, explainable related-content engine: nothing a model made up.
        const access = await requireObject(env.DB, user, capture.source_object_id);
        for (const related of (await relatedObjects(env.DB, access.id, access.space_id, 5)).filter((r) => r.strength === "strong").slice(0, 3))
            drafts.push({
                kind: "link",
                payload: payloadSchemas.link.parse({ sourceObjectId: access.id, targetObjectId: related.object.id }),
                reason: related.reasons.join("; "),
                evidence: null,
                confidence: null,
                key: `link:${access.id}:${related.object.id}`,
            });
        return drafts;
    }
    if (!capture.space_id) return drafts;
    if (capture.source === "audio")
        drafts.push({
            kind: "meeting_note",
            payload: payloadSchemas.meeting_note.parse({ spaceId: capture.space_id, title: capture.title, summary: output.summary, tags }),
            reason: "Keep this meeting in Knowledge with its summary and transcript",
            evidence: null,
            confidence: null,
            key: `record:${capture.id}`,
        });
    else
        drafts.push({
            kind: "knowledge_object",
            payload: payloadSchemas.knowledge_object.parse({
                spaceId: capture.space_id,
                typeSlug: capture.source === "document" ? "resource" : "page",
                title: capture.title,
                text: (capture.text ?? "").slice(0, 20_000),
                tags,
            }),
            reason: capture.source === "document" ? "Keep this document's text (and the file) in Knowledge" : "Keep what you captured as a note",
            evidence: null,
            confidence: null,
            key: `record:${capture.id}`,
        });
    return drafts;
}

/** Pieces of at most `max` characters, split at paragraph ends where possible. */
export function pieces(text: string, max: number): string[] {
    const out: string[] = [];
    let rest = text;
    while (rest.length > max) {
        const cut = Math.max(rest.lastIndexOf("\n", max), rest.lastIndexOf(". ", max) + 1);
        const at = cut > max * 0.5 ? cut : max;
        out.push(rest.slice(0, at));
        rest = rest.slice(at);
    }
    if (rest.trim()) out.push(rest);
    return out.slice(0, 8);
}

/** The job step for capture.analyse (and the last steps of meetings and documents). */
export async function analyseStep(ctx: JobContext, capture: CaptureRow): Promise<StepResult> {
    const { env, config, user, job } = ctx;
    if (!capture.text?.trim()) throw new PermanentFailure("no_text");
    const progress = (job.progress ? JSON.parse(job.progress) : {}) as { piece?: number; summaries?: string[]; tags?: string[]; questions?: string[] };
    const parts = pieces(capture.text, config.limits.maxContextCharacters);
    const index = progress.piece ?? 0;
    if (index === 0) await env.DB.prepare("UPDATE ai_captures SET status = 'analysing', updated_at = ? WHERE id = ?").bind(nowIso(), capture.id).run();
    const prefs = await preferences(env.DB, user.email);
    const today = await todayFor(env.DB, user.email);
    const meeting = capture.source === "audio";
    const { value } = await generateJson(
        { env, config, email: user.email, spaceId: capture.space_id, feature: meeting ? "meetings" : capture.source === "document" ? "documents" : "capture", jobId: job.id },
        {
            role: meeting && parts.length === 1 ? "synthesis" : "extract",
            system: meeting ? MEETING_SYSTEM(today, prefs.timeZone, false) : EXTRACT_SYSTEM(today, prefs.timeZone),
            prompt: `${parts.length > 1 ? `Part ${index + 1} of ${parts.length}.\n` : ""}${fence(meeting ? "transcript" : "note", parts[index], config.limits.maxContextCharacters)}`,
            maxTokens: 1_500,
            schema: extractionSchema,
        },
    );
    const { drafts } = await draftsFrom(capture.text, value, { today, spaceId: capture.space_id, captureKind: capture.source });
    await saveSuggestions(env, user, capture, drafts, today);
    const summaries = [...(progress.summaries ?? []), value.summary.trim()].filter(Boolean);
    const tags = [...new Set([...(progress.tags ?? []), ...value.tags])].slice(0, 10);
    const questions = [...(progress.questions ?? []), ...value.questions].slice(0, 5);
    if (index + 1 < parts.length) return { status: "more", progress: { step: "analysing", done: index + 1, total: parts.length, piece: index + 1, summaries, tags, questions } };

    const summary = [summaries.join("\n\n"), questions.length ? `Questions to consider:\n${questions.map((q) => `- ${q}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
    await saveSuggestions(env, user, capture, await recordDrafts(env, user, capture, { summary: summaries.join("\n\n"), tags, items: [], questions }), today);
    await env.DB.prepare("UPDATE ai_captures SET status = 'ready', summary = ?, error_code = NULL, analysed_at = ?, updated_at = ? WHERE id = ?")
        .bind(summary.slice(0, 20_000), nowIso(), nowIso(), capture.id)
        .run();
    return { status: "done" };
}

export async function captureJob(ctx: JobContext): Promise<StepResult> {
    const capture = await ownCapture(ctx.env, ctx.user.email, ctx.job.subject_id).catch(() => null);
    if (!capture || capture.status === "cancelled") return { status: "done" };
    try {
        return await analyseStep(ctx, capture);
    } catch (error) {
        if (willFail(ctx.job, error)) await markFailed(ctx.env, capture.id, error);
        throw error;
    }
}

/** Records a capture failure (the job decides whether to retry; a retry sets it going again). */
export async function markFailed(env: Env, captureId: string, error: unknown) {
    const code = error instanceof PermanentFailure ? error.code : error instanceof HttpError ? error.code : "unexpected";
    await env.DB.prepare("UPDATE ai_captures SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?").bind(code.slice(0, 40), nowIso(), captureId).run();
}
