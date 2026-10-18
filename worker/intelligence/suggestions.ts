// The AI Suggestions Inbox: one person's proposed actions, and what happens when they decide.
//
// Only the person a suggestion belongs to can see, edit, approve or dismiss it; anyone else gets
// "not found". Approving applies it through the portal's own functions (createTask, createProject,
// createObject, updateObject, addRelation) as that person, so every rule and every audit trail is
// exactly the portal's. Every id in the payload is re-checked at that moment, whatever the
// suggestion said when it was made.
//
// Applying is exactly-once:
//   1. pending → applying, under the suggestion's version (a double click or two tabs: one wins);
//   2. the write carries the suggestion id as its retry key (a task's or project's client id, a
//      Knowledge object's source id), so a retry after a crash returns the first record;
//   3. applying → applied with the record it produced.
// A claim left in `applying` for over two minutes (a request that died) can be taken over, and step
// 2 makes that safe. A refusal the person can fix (an archived project, a name already in use)
// goes back to pending with the reason; anything else is `failed` and can be approved again.
import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";
import { type CaptureSource, type SuggestionKind, type SuggestionPayload, type SuggestionView, payloadSchemas } from "../../src/shared/intelligence/types";
import { type DocNode, paragraphsFromText } from "../../src/shared/knowledge/content";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { requireObject, requireSpace } from "../knowledge/access";
import { KnowledgeConflict, addRelation, createObject, objectDetail, updateObject } from "../knowledge/objects";
import { listTypes } from "../knowledge/types";
import { normaliseName } from "../mcp/projects";
import { can } from "../portal/auth";
import { nowIso, parseJson, placeholders } from "../portal/db";
import { HttpError } from "../portal/http";
import { requireProject, todayFor } from "../tasks/access";
import { createProject, listProjects } from "../tasks/projects";
import { createTask } from "../tasks/tasks";
import { keepInKnowledge } from "./attachments";

export const INTELLIGENCE_SOURCE = "daly-intelligence";
const APPLYING_STALE_MS = 2 * 60_000;

export interface SuggestionRow {
    id: string;
    email: string;
    capture_id: string | null;
    kind: SuggestionKind;
    status: SuggestionView["status"];
    payload: string;
    reason: string | null;
    evidence: string | null;
    confidence: number | null;
    depends_on: string | null;
    dedupe_key: string;
    result_type: string | null;
    result_id: string | null;
    error_code: string | null;
    version: number;
    created_at: string;
    updated_at: string;
    decided_at: string | null;
}

const ownSuggestion = async (db: D1Database, email: string, id: string) => {
    const row = await db.prepare("SELECT * FROM ai_suggestions WHERE id = ? AND email = ?").bind(id, email).first<SuggestionRow>();
    if (!row) throw new HttpError(404, "not_found", "Not found");
    return row;
};

const resultUrl = (site: string, type: string, id: string) =>
    type === "task" ? `${site}/portal/tasks/t/${id}` : type === "task_project" ? `${site}/portal/tasks/p/${id}` : `${site}/portal/knowledge/o/${id}`;

// --- Reading ---------------------------------------------------------------------------------------

/** Names for the ids in these suggestions, through the reader's own access. Ids they can't see get no name. */
async function labelsFor(db: D1Database, user: PortalUser, rows: SuggestionRow[]): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const row of rows) {
        const payload = parseJson<Record<string, unknown>>(row.payload, {});
        for (const value of Object.values(payload)) {
            if (typeof value === "string" && /^(tpj|kob|ksp)_[a-z0-9]{14}$/.test(value)) ids.add(value);
            if (Array.isArray(value)) for (const v of value) if (typeof v === "string" && /^(tpj|kob)_[a-z0-9]{14}$/.test(v)) ids.add(v);
        }
    }
    const list = [...ids].slice(0, 90);
    const out = new Map<string, string>();
    if (!list.length) return out;
    const [projects, objects, spaces] = await db.batch([
        db
            .prepare(
                `SELECT p.id, CASE WHEN p.is_inbox = 1 THEN 'Inbox' ELSE p.name END AS name FROM task_projects p JOIN task_project_members m ON m.project_id = p.id AND m.email = ? WHERE p.id IN (${placeholders(list.length)})`,
            )
            .bind(user.email, ...list),
        db
            .prepare(
                `SELECT o.id, o.title AS name FROM knowledge_objects o JOIN knowledge_memberships m ON m.space_id = o.space_id AND m.email = ? WHERE o.status <> 'trashed' AND o.id IN (${placeholders(list.length)})`,
            )
            .bind(user.email, ...list),
        db
            .prepare(
                `SELECT s.id, s.name FROM knowledge_spaces s JOIN knowledge_memberships m ON m.space_id = s.id AND m.email = ? WHERE s.id IN (${placeholders(list.length)})`,
            )
            .bind(user.email, ...list),
    ]);
    for (const r of [...projects.results, ...objects.results, ...spaces.results] as { id: string; name: string }[]) out.set(r.id, r.name || "Untitled");
    return out;
}

export async function suggestionViews(db: D1Database, user: PortalUser, rows: SuggestionRow[], site: string): Promise<SuggestionView[]> {
    const labels = await labelsFor(db, user, rows);
    const captureIds = [...new Set(rows.map((r) => r.capture_id).filter(Boolean))] as string[];
    const captures = new Map<string, { id: string; title: string; source: string }>();
    for (let i = 0; i < captureIds.length; i += 90) {
        const part = captureIds.slice(i, i + 90);
        const found = await db
            .prepare(`SELECT id, title, source FROM ai_captures WHERE email = ? AND id IN (${placeholders(part.length)})`)
            .bind(user.email, ...part)
            .all<{ id: string; title: string; source: string }>();
        for (const c of found.results) captures.set(c.id, c);
    }
    return rows.map((r) => {
        const payload = parseJson<SuggestionPayload>(r.payload, {} as SuggestionPayload);
        const own: Record<string, string> = {};
        for (const value of Object.values(payload as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? v : [v])))
            if (typeof value === "string" && labels.has(value)) own[value] = labels.get(value)!;
        const capture = r.capture_id ? captures.get(r.capture_id) : undefined;
        return {
            id: r.id,
            kind: r.kind,
            status: r.status,
            payload,
            reason: r.reason,
            evidence: r.evidence,
            confidence: r.confidence,
            dependsOn: r.depends_on,
            capture: capture ? { id: capture.id, title: capture.title, source: capture.source as CaptureSource } : null,
            labels: own,
            result: r.result_type && r.result_id ? { type: r.result_type, id: r.result_id, url: resultUrl(site, r.result_type, r.result_id) } : null,
            errorCode: r.error_code,
            version: r.version,
            createdAt: r.created_at,
            decidedAt: r.decided_at,
        };
    });
}

/** One of the caller's suggestions, as a view. Anyone else's is "not found". */
export const suggestionView = async (db: D1Database, user: PortalUser, id: string, site: string) =>
    (await suggestionViews(db, user, [await ownSuggestion(db, user.email, id)], site))[0];

export type SuggestionFilter = "pending" | "applied" | "dismissed" | "all";

export async function listSuggestions(
    db: D1Database,
    user: PortalUser,
    site: string,
    options: { filter?: SuggestionFilter; captureId?: string; limit?: number } = {},
) {
    const where = ["email = ?"];
    const binds: unknown[] = [user.email];
    const filter = options.filter ?? "pending";
    if (filter === "pending") where.push("status IN ('pending', 'applying', 'failed')");
    else if (filter !== "all") {
        where.push("status = ?");
        binds.push(filter);
    }
    if (options.captureId) {
        where.push("capture_id = ?");
        binds.push(options.captureId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const rows = await db
        .prepare(`SELECT * FROM ai_suggestions WHERE ${where.join(" AND ")} ORDER BY CASE kind WHEN 'project' THEN 0 ELSE 1 END, created_at DESC LIMIT ?`)
        .bind(...binds, limit)
        .all<SuggestionRow>();
    return suggestionViews(db, user, rows.results, site);
}

export const pendingCount = async (db: D1Database, email: string) =>
    (await db.prepare("SELECT COUNT(*) AS n FROM ai_suggestions WHERE email = ? AND status = 'pending'").bind(email).first<{ n: number }>())?.n ?? 0;

// --- Checking ids ----------------------------------------------------------------------------------

/** Every id a payload names must be one the person can use for that purpose right now. */
async function checkPayload(db: D1Database, user: PortalUser, kind: SuggestionKind, payload: SuggestionPayload) {
    const p = payload as Record<string, unknown>;
    if (typeof p.projectId === "string") await requireProject(db, user, p.projectId, "editor");
    if (typeof p.spaceId === "string") await requireSpace(db, user, p.spaceId, "editor");
    for (const key of ["objectId", "sourceObjectId"] as const)
        if (typeof p[key] === "string") {
            const o = await requireObject(db, user, p[key] as string, kind === "fact" || kind === "tags" || kind === "link" ? "editor" : "viewer");
            if (o.status === "trashed") throw new HttpError(404, "not_found", "Not found");
        }
    if (typeof p.targetObjectId === "string") await requireObject(db, user, p.targetObjectId);
    for (const id of (p.knowledgeObjectIds as string[] | undefined) ?? []) await requireObject(db, user, id);
    if ((kind === "task" || kind === "follow_up" || kind === "project") && !can(user, "tasks.use"))
        throw new HttpError(403, "forbidden", "You don't have access to Tasks");
}

// --- Editing and dismissing --------------------------------------------------------------------------

const editInput = z.object({ version: z.number().int().min(1), payload: z.unknown() }).strict();

export async function editSuggestion(db: D1Database, user: PortalUser, id: string, input: unknown, site: string): Promise<SuggestionView> {
    const body = editInput.parse(input);
    const row = await ownSuggestion(db, user.email, id);
    if (!["pending", "failed"].includes(row.status)) throw new HttpError(409, "conflict", "Only a suggestion waiting for review can be edited");
    const payload = payloadSchemas[row.kind].parse(body.payload) as SuggestionPayload;
    // A task moved to a real project no longer waits for the proposed one.
    const dependsOn = (row.kind === "task" || row.kind === "follow_up") && (payload as SuggestionPayload<"task">).projectId ? null : row.depends_on;
    if (dependsOn === null && row.kind === "task") (payload as SuggestionPayload<"task">).projectSuggestionId = null;
    await checkPayload(db, user, row.kind, payload);
    const result = await db
        .prepare(
            "UPDATE ai_suggestions SET payload = ?, depends_on = ?, status = 'pending', error_code = NULL, version = version + 1, updated_at = ? WHERE id = ? AND email = ? AND version = ?",
        )
        .bind(JSON.stringify(payload), dependsOn, nowIso(), id, user.email, body.version)
        .run();
    if (!result.meta.changes) throw new HttpError(409, "conflict", "This suggestion changed in another tab. Reload to see it.");
    return (await suggestionViews(db, user, [await ownSuggestion(db, user.email, id)], site))[0];
}

export async function dismissSuggestion(db: D1Database, user: PortalUser, id: string) {
    await ownSuggestion(db, user.email, id);
    await db
        .prepare(
            "UPDATE ai_suggestions SET status = 'dismissed', version = version + 1, decided_at = ?, updated_at = ? WHERE id = ? AND email = ? AND status IN ('pending', 'failed')",
        )
        .bind(nowIso(), nowIso(), id, user.email)
        .run();
    // Tasks waiting on a dismissed project go to the Inbox instead, unless the person edits them.
    await db
        .prepare(
            "UPDATE ai_suggestions SET depends_on = NULL, payload = json_set(payload, '$.projectSuggestionId', NULL), version = version + 1, updated_at = ? WHERE email = ? AND depends_on = ? AND status = 'pending'",
        )
        .bind(nowIso(), user.email, id)
        .run();
}

// --- Applying --------------------------------------------------------------------------------------

export class SuggestionRefused extends HttpError {}

async function claim(db: D1Database, row: SuggestionRow, version: number | undefined) {
    const stale = new Date(Date.now() - APPLYING_STALE_MS).toISOString();
    const result = await db
        .prepare(
            `UPDATE ai_suggestions SET status = 'applying', version = version + 1, updated_at = ?
             WHERE id = ? AND email = ? AND (status IN ('pending', 'failed') OR (status = 'applying' AND updated_at < ?)) AND (? IS NULL OR version = ?)`,
        )
        .bind(nowIso(), row.id, row.email, stale, version ?? null, version ?? null)
        .run();
    return !!result.meta.changes;
}

const typeIdFor = async (db: D1Database, spaceId: string, slug: string) => {
    const types = await listTypes(db, spaceId);
    const found = types.find((t) => t.slug === slug && !t.archived) ?? types.find((t) => t.slug === "page" && !t.archived);
    if (!found) throw new HttpError(422, "validation", "That space has no type to put this in");
    return found;
};

const provenance = (site: string, row: SuggestionRow, title: string | null) =>
    row.capture_id
        ? `Suggested by Daly Intelligence from “${title ?? "a capture"}”: ${site}/portal/intelligence/captures/${row.capture_id}`
        : "Suggested by Daly Intelligence";

async function captureFacts(db: D1Database, email: string, captureId: string | null) {
    if (!captureId) return null;
    return db
        .prepare("SELECT id, title, text, attachment_id, source FROM ai_captures WHERE id = ? AND email = ?")
        .bind(captureId, email)
        .first<{ id: string; title: string; text: string | null; attachment_id: string | null; source: string }>();
}

/** The Knowledge note an approved record suggestion from the same capture made, for tasks to link to. */
async function captureNote(db: D1Database, user: PortalUser, row: SuggestionRow): Promise<string | null> {
    if (!row.capture_id) return null;
    const note = await db
        .prepare(
            "SELECT result_id FROM ai_suggestions WHERE capture_id = ? AND email = ? AND status = 'applied' AND kind IN ('knowledge_object', 'meeting_note') LIMIT 1",
        )
        .bind(row.capture_id, user.email)
        .first<{ result_id: string }>();
    if (!note?.result_id) return null;
    try {
        await requireObject(db, user, note.result_id);
        return note.result_id;
    } catch {
        return null;
    }
}

async function apply(env: Env, user: PortalUser, row: SuggestionRow, site: string): Promise<{ type: NonNullable<SuggestionRow["result_type"]>; id: string }> {
    const db = env.DB;
    const payload = payloadSchemas[row.kind].parse(parseJson(row.payload, {})) as SuggestionPayload;
    await checkPayload(db, user, row.kind, payload);
    const capture = await captureFacts(db, user.email, row.capture_id);
    const from = provenance(site, row, capture?.title ?? null);

    switch (row.kind) {
        case "task":
        case "follow_up": {
            const p = payload as SuggestionPayload<"task"> & SuggestionPayload<"follow_up">;
            let projectId = p.projectId;
            if (!projectId && p.projectSuggestionId) {
                const project = await db
                    .prepare("SELECT status, result_id FROM ai_suggestions WHERE id = ? AND email = ?")
                    .bind(p.projectSuggestionId, user.email)
                    .first<{ status: string; result_id: string | null }>();
                if (project?.status !== "applied" || !project.result_id)
                    throw new SuggestionRefused(422, "needs_project", "Approve the new project first, or edit this task to choose a project.");
                projectId = project.result_id;
            }
            const note = await captureNote(db, user, row);
            const knowledge = [...new Set([...(p.knowledgeObjectIds ?? []), ...(note ? [note] : [])])].slice(0, 5);
            const description = [
                row.kind === "task" ? p.description : p.waitingOn ? `Waiting on ${p.waitingOn}.` : "",
                p.dueText ? `Timing in the source: “${p.dueText}”${p.dateCertainty === "inferred" ? " (date worked out, check it)" : ""}.` : "",
                from,
            ]
                .filter(Boolean)
                .join("\n\n");
            const { task } = await createTask(db, user, {
                title: p.title,
                description,
                ...(projectId ? { projectId } : {}),
                dueDate: p.dueDate,
                priority: row.kind === "task" ? p.priority : 4,
                labels: row.kind === "follow_up" ? ["waiting", ...(p.labels ?? [])] : (p.labels ?? []),
                knowledge: can(user, "knowledge.use") ? knowledge : [],
                clientId: row.id,
            });
            return { type: "task", id: task.id };
        }
        case "project": {
            const p = payload as SuggestionPayload<"project">;
            const existing = (await listProjects(db, user.email, await todayFor(db, user.email))).filter(
                (x) => !x.isInbox && normaliseName(x.name) === normaliseName(p.name),
            );
            // A retry of this same approval finds its own project through the client id inside createProject.
            const own = await db
                .prepare("SELECT id FROM task_projects WHERE created_by = ? AND client_id = ?")
                .bind(user.email, row.id)
                .first<{ id: string }>();
            if (existing.length && !own)
                throw new SuggestionRefused(
                    422,
                    "duplicate",
                    `You already have a project called “${existing[0].name}”. Edit the tasks to use it, or rename this one.`,
                );
            const { id } = await createProject(db, user, {
                name: p.name,
                description: [p.description, from].filter(Boolean).join("\n\n").slice(0, 2_000),
                kind: p.kind,
                clientId: row.id,
            });
            return { type: "task_project", id };
        }
        case "knowledge_object":
        case "decision":
        case "meeting_note": {
            const p = payload as SuggestionPayload<"knowledge_object"> & SuggestionPayload<"decision"> & SuggestionPayload<"meeting_note">;
            const slug = row.kind === "decision" ? "decision" : row.kind === "meeting_note" ? "meeting" : p.typeSlug;
            const type = await typeIdFor(db, p.spaceId, slug);
            const keys = new Set(type.schema.properties.map((d) => d.key));
            const properties: Record<string, unknown> = {};
            if (row.kind === "decision") {
                if (keys.has("status")) properties.status = "decided";
                if (keys.has("decided_on") && p.decidedOn) properties.decided_on = p.decidedOn;
            }
            if (row.kind === "meeting_note" && keys.has("date") && p.date) properties.date = p.date;
            const heading = (text: string): DocNode => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
            const blocks: DocNode[] =
                row.kind === "meeting_note"
                    ? [
                          heading("Summary (generated)"),
                          ...paragraphsFromText(p.summary || "No summary."),
                          ...(p.includeTranscript && capture?.text
                              ? [heading("Transcript (source)"), ...paragraphsFromText(capture.text.slice(0, 200_000))]
                              : []),
                          ...paragraphsFromText(from),
                      ]
                    : [...paragraphsFromText(p.text || ""), ...paragraphsFromText(from)];
            const detail = await createObject(
                db,
                user,
                p.spaceId,
                { typeId: type.id, title: p.title, content: { type: "doc", content: blocks }, properties, tags: p.tags ?? [] },
                { source: { system: INTELLIGENCE_SOURCE, id: row.id } },
            );
            // A document captured and then kept as a note keeps its file, permanently, with the note.
            if (row.kind === "knowledge_object" && capture?.source === "document" && capture.attachment_id)
                await keepInKnowledge(db, user, capture.attachment_id, detail.object.id).catch(() => undefined);
            return { type: "knowledge_object", id: detail.object.id };
        }
        case "fact": {
            const p = payload as SuggestionPayload<"fact">;
            if (p.objectId) {
                await appendParagraphs(db, user, p.objectId, paragraphsFromText(p.statement));
                return { type: "knowledge_object", id: p.objectId };
            }
            if (!p.spaceId) throw new SuggestionRefused(422, "validation", "Choose where to keep this fact");
            const type = await typeIdFor(db, p.spaceId, "page");
            const detail = await createObject(
                db,
                user,
                p.spaceId,
                {
                    typeId: type.id,
                    title: p.statement.slice(0, 120),
                    content: { type: "doc", content: [...paragraphsFromText(p.statement), ...paragraphsFromText(from)] },
                    tags: [],
                },
                { source: { system: INTELLIGENCE_SOURCE, id: row.id } },
            );
            return { type: "knowledge_object", id: detail.object.id };
        }
        case "tags": {
            const p = payload as SuggestionPayload<"tags">;
            for (let attempt = 0; ; attempt++) {
                const current = await objectDetail(db, p.objectId);
                try {
                    await updateObject(db, user, p.objectId, { version: current.object.version, tags: [...new Set([...current.object.tags, ...p.tags])] });
                    return { type: "knowledge_tags", id: p.objectId };
                } catch (error) {
                    if (!(error instanceof KnowledgeConflict) || attempt >= 2) throw error;
                }
            }
        }
        case "link": {
            const p = payload as SuggestionPayload<"link">;
            await addRelation(db, user, p.sourceObjectId, { targetId: p.targetObjectId, relationType: p.relationType });
            return { type: "knowledge_relation", id: p.sourceObjectId };
        }
    }
}

/** Appends without overwriting anyone's edit: a concurrent save is retried on the newer version. */
async function appendParagraphs(db: D1Database, user: PortalUser, objectId: string, added: DocNode[]) {
    for (let attempt = 0; ; attempt++) {
        await requireObject(db, user, objectId, "editor");
        const current = await objectDetail(db, objectId);
        const doc = current.object.content as DocNode;
        try {
            return await updateObject(db, user, objectId, {
                version: current.object.version,
                content: { type: "doc", content: [...(doc.content ?? []), ...added] },
            });
        } catch (error) {
            if (!(error instanceof KnowledgeConflict) || attempt >= 2) throw error;
        }
    }
}

const approveInput = z.object({ version: z.number().int().min(1).optional() }).strict();

export async function approveSuggestion(env: Env, user: PortalUser, id: string, input: unknown, site: string): Promise<SuggestionView> {
    const { version } = approveInput.parse(input ?? {});
    const db = env.DB;
    const row = await ownSuggestion(db, user.email, id);
    if (row.status === "applied") return (await suggestionViews(db, user, [row], site))[0];
    if (row.status === "dismissed") throw new HttpError(409, "conflict", "This suggestion was dismissed");
    if (!(await claim(db, row, version))) {
        const now = await ownSuggestion(db, user.email, id);
        if (now.status === "applied") return (await suggestionViews(db, user, [now], site))[0];
        throw new HttpError(
            409,
            now.status === "applying" ? "in_progress" : "conflict",
            now.status === "applying" ? "This suggestion is being applied" : "This suggestion changed. Reload to see it.",
        );
    }
    try {
        const result = await apply(env, user, row, site);
        await db
            .prepare(
                "UPDATE ai_suggestions SET status = 'applied', result_type = ?, result_id = ?, error_code = NULL, version = version + 1, decided_at = ?, updated_at = ? WHERE id = ? AND email = ?",
            )
            .bind(result.type, result.id, nowIso(), nowIso(), id, user.email)
            .run();
        console.log(JSON.stringify({ event: "ai_suggestion_applied", kind: row.kind }));
    } catch (error) {
        const fixable = error instanceof HttpError && error.status >= 400 && error.status < 500;
        const code = error instanceof HttpError ? error.code : "unexpected";
        await db
            .prepare("UPDATE ai_suggestions SET status = ?, error_code = ?, version = version + 1, updated_at = ? WHERE id = ? AND email = ?")
            .bind(fixable ? "pending" : "failed", code.slice(0, 40), nowIso(), id, user.email)
            .run();
        throw error;
    }
    return (await suggestionViews(db, user, [await ownSuggestion(db, user.email, id)], site))[0];
}

const ORDER: Record<SuggestionKind, number> = {
    project: 0,
    knowledge_object: 1,
    meeting_note: 1,
    decision: 2,
    fact: 2,
    tags: 3,
    link: 3,
    task: 4,
    follow_up: 4,
};

/** Approves several, in an order that works: new projects and notes before the tasks that use them. */
export async function approveMany(env: Env, user: PortalUser, input: unknown, site: string) {
    const { ids } = z
        .object({
            ids: z
                .array(z.string().regex(/^ais_[a-z0-9]{14}$/))
                .min(1)
                .max(50),
        })
        .strict()
        .parse(input);
    const rows = await env.DB.prepare(`SELECT id, kind FROM ai_suggestions WHERE email = ? AND id IN (${placeholders(ids.length)})`)
        .bind(user.email, ...ids)
        .all<{ id: string; kind: SuggestionKind }>();
    const results: { id: string; ok: boolean; error?: { code: string; message: string } }[] = [];
    for (const row of [...rows.results].sort((a, b) => ORDER[a.kind] - ORDER[b.kind])) {
        try {
            await approveSuggestion(env, user, row.id, {}, site);
            results.push({ id: row.id, ok: true });
        } catch (error) {
            results.push({
                id: row.id,
                ok: false,
                error: {
                    code: error instanceof HttpError ? error.code : "unexpected",
                    message: error instanceof HttpError ? error.message : "Something went wrong",
                },
            });
        }
    }
    for (const id of ids) if (!rows.results.some((r) => r.id === id)) results.push({ id, ok: false, error: { code: "not_found", message: "Not found" } });
    return { results, approved: results.filter((r) => r.ok).length };
}
