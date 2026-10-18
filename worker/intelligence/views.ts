// What the Intelligence pages and API return: captures with their jobs, transcripts and
// suggestions; the status panel. Everything is read joined to the caller's email, and Knowledge
// names through their membership.
import type { D1Database } from "@cloudflare/workers-types";
import type { CaptureDetail, CaptureSummary, IntelligenceShell, IntelligenceStatus, TranscriptSegment } from "../../src/shared/intelligence/types";
import type { PortalUser } from "../../src/shared/portal/types";
import type { Env } from "../env";
import { can } from "../portal/auth";
import { parseJson, placeholders } from "../portal/db";
import { getAttachment, toAttachmentView } from "./attachments";
import { type CaptureRow, ownCapture } from "./capture";
import { type JobRow, toJobView } from "./jobs";
import { indexStatus } from "./semantic";
import { loadConfig, statusFor } from "./settings";
import { listSuggestions, pendingCount } from "./suggestions";
import { circuitOpen } from "./usage";

const MAX_TEXT = 60_000;

export async function listCaptures(db: D1Database, user: PortalUser, options: { source?: "audio" | "other"; limit?: number } = {}): Promise<CaptureSummary[]> {
    const where = ["c.email = ?"];
    if (options.source === "audio") where.push("c.source = 'audio'");
    if (options.source === "other") where.push("c.source <> 'audio'");
    const rows = await db
        .prepare(
            `SELECT c.*, (SELECT COUNT(*) FROM ai_suggestions s WHERE s.capture_id = c.id AND s.status = 'pending') AS pending
             FROM ai_captures c WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC LIMIT ?`,
        )
        .bind(user.email, Math.min(options.limit ?? 50, 200))
        .all<CaptureRow & { pending: number }>();
    const ids = rows.results.map((r) => r.id);
    const jobs = new Map<string, JobRow>();
    if (ids.length) {
        const found = await db
            .prepare(`SELECT * FROM ai_jobs WHERE email = ? AND subject_id IN (${placeholders(ids.length)}) ORDER BY created_at`)
            .bind(user.email, ...ids)
            .all<JobRow>();
        for (const j of found.results) jobs.set(j.subject_id, j);
    }
    return rows.results.map((r) => toSummary(r, r.pending, jobs.get(r.id) ?? null));
}

const toSummary = (r: CaptureRow, pending: number, job: JobRow | null): CaptureSummary => ({
    id: r.id,
    title: r.title,
    source: r.source,
    status: r.status,
    errorCode: r.error_code,
    spaceId: r.space_id,
    pending,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    job: job ? toJobView(job) : null,
});

export async function captureDetail(env: Env, user: PortalUser, id: string, site: string): Promise<CaptureDetail> {
    const row = await ownCapture(env, user.email, id);
    const db = env.DB;
    const [job, transcript, parts, sourceObject] = await Promise.all([
        db.prepare("SELECT * FROM ai_jobs WHERE subject_id = ? AND email = ? ORDER BY created_at DESC LIMIT 1").bind(id, user.email).first<JobRow>(),
        db
            .prepare("SELECT * FROM ai_transcripts WHERE capture_id = ?")
            .bind(id)
            .first<{ model: string; language: string | null; duration_seconds: number | null; chunks_total: number; chunks_done: number }>(),
        db.prepare("SELECT segments FROM ai_transcript_parts WHERE capture_id = ? ORDER BY idx").bind(id).all<{ segments: string | null }>(),
        row.source_object_id
            ? db
                  .prepare(
                      "SELECT o.id, o.title FROM knowledge_objects o JOIN knowledge_memberships m ON m.space_id = o.space_id AND m.email = ? WHERE o.id = ?",
                  )
                  .bind(user.email, row.source_object_id)
                  .first<{ id: string; title: string }>()
            : Promise.resolve(null),
    ]);
    const attachment = row.attachment_id ? await getAttachment(db, row.attachment_id) : null;
    const suggestions = await listSuggestions(db, user, site, { filter: "all", captureId: id, limit: 200 });
    return {
        ...toSummary(row, suggestions.filter((s) => s.status === "pending").length, job),
        text: row.text ? row.text.slice(0, MAX_TEXT) : null,
        textTruncated: (row.text?.length ?? 0) > MAX_TEXT,
        summary: row.summary,
        language: row.language,
        sourceObject: sourceObject ? { id: sourceObject.id, title: sourceObject.title || "Untitled" } : null,
        attachment: attachment && attachment.owner_email === user.email ? toAttachmentView(attachment) : null,
        transcript: transcript
            ? {
                  model: transcript.model,
                  language: transcript.language,
                  durationSeconds: transcript.duration_seconds,
                  chunksDone: transcript.chunks_done,
                  chunksTotal: transcript.chunks_total,
                  segments: parts.results.flatMap((p) => parseJson<TranscriptSegment[]>(p.segments, [])).slice(0, 5_000),
              }
            : null,
        suggestions,
    };
}

export async function intelligenceStatus(env: Env, user: PortalUser): Promise<IntelligenceStatus> {
    const { config } = await loadConfig(env.DB);
    const spaces = can(user, "knowledge.use")
        ? (await env.DB.prepare("SELECT space_id FROM knowledge_memberships WHERE email = ?").bind(user.email).all<{ space_id: string }>()).results.map(
              (r) => r.space_id,
          )
        : [];
    const status = statusFor(env, config, false, null);
    return statusFor(
        env,
        config,
        await circuitOpen(env.DB),
        status.available.semantic || config.features.semanticSearch ? await indexStatus(env.DB, spaces) : null,
    );
}

export async function intelligenceShell(env: Env, user: PortalUser): Promise<IntelligenceShell> {
    return {
        status: await intelligenceStatus(env, user),
        pendingSuggestions: await pendingCount(env.DB, user.email),
        canManage: can(user, "portal.settings.manage"),
    };
}
