// Shared attachments: files in R2 for every portal application, with retention rules.
//
//   permanent   Knowledge attachments. Kept until a person deletes one on purpose.
//   referenced  Task attachments. Kept while the task exists, then for a grace period.
//   temporary   Uploads for processing (recordings, documents). Purged a short, configurable time
//               after processing; failed ones are kept a little longer for investigation.
// A file marked `keep` is permanent and nothing automatic ever deletes it.
//
// Files are private. Keys live under "private/", which no public route serves (the blog's /media/
// route only accepts its own hashed names and the wedding site only "wedding/"). Downloads are
// checked against the file's owner or the Knowledge object or task it belongs to, and are sent as
// attachments with nosniff and a sandboxing CSP, so nothing uploaded is ever rendered or run.
//
// Uploads arrive in parts (base64 in JSON, like the wedding photos, because the portal API accepts
// only JSON) and are assembled with an R2 multipart upload, which gives progress and keeps each
// request small. The first part is checked by its actual bytes against what the name claims.
// Malware: files are never executed, rendered or served inline, and are only ever read back by the
// person they belong to (or members of the Knowledge space they were kept in). There is no virus
// scanner; that's the documented strategy for a private, single-household system.
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { z } from "zod";
import type { IntelligenceConfig } from "../../src/shared/intelligence/config";
import type { AttachmentView, StorageSummary } from "../../src/shared/intelligence/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { requireObject } from "../knowledge/access";
import { newId, nowIso, parseJson } from "../portal/db";
import { HttpError } from "../portal/http";
import { requireTask } from "../tasks/access";

/** R2 multipart parts must be at least 5 MiB, except the last. */
export const PART_BYTES = 6 * 1024 * 1024;
export const MAX_PARTS = 20;
const UPLOAD_ABANDONED_MS = 24 * 3_600_000;

export type FileKind =
    | { kind: "audio"; format: "mp3" | "wav" | "m4a" | "ogg" | "flac" | "webm" }
    | { kind: "document"; format: "pdf" | "docx" | "xlsx" | "pptx" | "text" | "markdown" | "csv" };

const AUDIO_EXTENSIONS: Record<string, "mp3" | "wav" | "m4a" | "ogg" | "flac" | "webm"> = {
    mp3: "mp3",
    wav: "wav",
    m4a: "m4a",
    mp4: "m4a",
    aac: "m4a",
    ogg: "ogg",
    oga: "ogg",
    opus: "ogg",
    flac: "flac",
    webm: "webm",
};
const DOCUMENT_EXTENSIONS: Record<string, "pdf" | "docx" | "xlsx" | "pptx" | "text" | "markdown" | "csv"> = {
    pdf: "pdf",
    docx: "docx",
    xlsx: "xlsx",
    pptx: "pptx",
    txt: "text",
    text: "text",
    md: "markdown",
    markdown: "markdown",
    csv: "csv",
};

export const CONTENT_TYPES: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    flac: "audio/flac",
    webm: "audio/webm",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    text: "text/plain",
    markdown: "text/markdown",
    csv: "text/csv",
};

const extension = (filename: string) => /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1].toLowerCase() ?? "";

/** What a file name claims to be, if it's a kind we accept for that purpose. */
export function claimedKind(filename: string, kind: "audio" | "document"): FileKind | null {
    const ext = extension(filename);
    if (kind === "audio" && AUDIO_EXTENSIONS[ext]) return { kind: "audio", format: AUDIO_EXTENSIONS[ext] };
    if (kind === "document" && DOCUMENT_EXTENSIONS[ext]) return { kind: "document", format: DOCUMENT_EXTENSIONS[ext] };
    return null;
}

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

/** Checks a file's first bytes against its claimed format. Returns a reason when they disagree. */
export function sniffMismatch(bytes: Uint8Array, claimed: FileKind): string | null {
    const ok = (() => {
        switch (claimed.format) {
            case "mp3":
                return ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
            case "wav":
                return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE";
            case "m4a":
                return ascii(bytes, 4, 8) === "ftyp";
            case "ogg":
                return ascii(bytes, 0, 4) === "OggS";
            case "flac":
                return ascii(bytes, 0, 4) === "fLaC";
            case "webm":
                return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
            case "pdf":
                return ascii(bytes, 0, 5) === "%PDF-";
            case "docx":
            case "xlsx":
            case "pptx":
                return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
            case "text":
            case "markdown":
            case "csv":
                return !bytes.subarray(0, 8192).includes(0);
        }
    })();
    return ok ? null : `That file's contents don't match a .${claimed.format === "text" || claimed.format === "markdown" ? "txt or .md" : claimed.format} file`;
}

/**
 * Office files are ZIP archives: before anything decompresses one, its central directory is read
 * to refuse decompression bombs (huge or suspiciously compressible contents, ZIP64, too many entries).
 */
export function zipBombReason(bytes: Uint8Array, limits = { maxEntries: 2_000, maxTotal: 100_000_000, maxRatio: 200 }): string | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) return "That document isn't a complete Office file";
    const entries = view.getUint16(eocd + 10, true);
    const offset = view.getUint32(eocd + 16, true);
    if (entries === 0xffff || offset === 0xffffffff) return "Very large (ZIP64) Office files aren't supported";
    if (entries > limits.maxEntries) return "That document has too many parts to process safely";
    let total = 0;
    let compressed = 0;
    let p = offset;
    for (let n = 0; n < entries; n++) {
        if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) return "That document's structure is damaged";
        compressed += view.getUint32(p + 20, true);
        total += view.getUint32(p + 24, true);
        p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    if (total > limits.maxTotal) return "That document expands to more than can be processed safely";
    if (compressed > 0 && total / compressed > limits.maxRatio) return "That document is compressed suspiciously well and wasn't processed";
    return null;
}

/** Page count from the PDF's own page objects. Compressed object streams can hide them, so 0 means unknown. */
export function pdfFacts(bytes: Uint8Array): { pages: number; encrypted: boolean } {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { pages: (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length, encrypted: /\/Encrypt\s/.test(text) };
}

// --- Rows ------------------------------------------------------------------------------------------

export interface AttachmentRow {
    id: string;
    owner_email: string;
    purpose: "knowledge" | "task" | "processing";
    space_id: string | null;
    object_id: string | null;
    task_id: string | null;
    capture_id: string | null;
    r2_key: string;
    filename: string;
    content_type: string;
    bytes: number;
    sha256: string | null;
    retention: "permanent" | "referenced" | "temporary";
    keep: number;
    status: AttachmentView["status"];
    upload_id: string | null;
    parts: string | null;
    purge_after: string | null;
    created_at: string;
    updated_at: string;
}

export const toAttachmentView = (r: AttachmentRow): AttachmentView => ({
    id: r.id,
    filename: r.filename,
    contentType: r.content_type,
    bytes: r.bytes,
    purpose: r.purpose,
    retention: r.retention,
    keep: !!r.keep,
    status: r.status,
    purgeAfter: r.purge_after,
    objectId: r.object_id,
    createdAt: r.created_at,
});

export const getAttachment = (db: D1Database, id: string) => db.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first<AttachmentRow>();

/** An attachment the caller may read: their own, or one kept on a Knowledge object or task they can see. */
export async function readableAttachment(db: D1Database, user: PortalUser, id: string): Promise<AttachmentRow> {
    const row = await getAttachment(db, id);
    if (!row || row.status === "deleted") throw new HttpError(404, "not_found", "Not found");
    if (row.owner_email === user.email) return row;
    if (row.purpose === "knowledge" && row.object_id) {
        await requireObject(db, user, row.object_id);
        return row;
    }
    if (row.purpose === "task" && row.task_id) {
        await requireTask(db, user, row.task_id);
        return row;
    }
    throw new HttpError(404, "not_found", "Not found");
}

const ownAttachment = async (db: D1Database, user: PortalUser, id: string) => {
    const row = await db.prepare("SELECT * FROM attachments WHERE id = ? AND owner_email = ?").bind(id, user.email).first<AttachmentRow>();
    if (!row || row.status === "deleted") throw new HttpError(404, "not_found", "Not found");
    return row;
};

// --- Upload ----------------------------------------------------------------------------------------

const startInput = z
    .object({
        filename: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .transform((v) => v.replace(/[/\\]/g, "_")),
        bytes: z.number().int().min(1),
        kind: z.enum(["audio", "document"]),
    })
    .strict();

export async function startUpload(db: D1Database, bucket: R2Bucket, config: IntelligenceConfig, user: PortalUser, input: unknown) {
    const body = startInput.parse(input);
    const claimed = claimedKind(body.filename, body.kind);
    if (!claimed)
        throw new HttpError(
            422,
            "validation",
            body.kind === "audio"
                ? "Use an MP3, M4A, WAV, OGG, FLAC or WebM recording"
                : "Use a PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), text or Markdown file",
        );
    const max = body.kind === "audio" ? config.limits.maxAudioBytes : config.limits.maxDocumentBytes;
    if (body.bytes > max) throw new HttpError(413, "too_large", `Files can be up to ${Math.floor(max / 1_000_000)} MB`);
    if (body.bytes > PART_BYTES * MAX_PARTS) throw new HttpError(413, "too_large", "That file is too large to upload");
    const id = newId("att");
    const random = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const key = `private/attachments/${id}/${random}`;
    const contentType = CONTENT_TYPES[claimed.format];
    const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType, contentDisposition: "attachment" } });
    const now = nowIso();
    await db
        .prepare(
            `INSERT INTO attachments (id, owner_email, purpose, r2_key, filename, content_type, bytes, retention, status, upload_id, parts, created_at, updated_at)
             VALUES (?, ?, 'processing', ?, ?, ?, ?, 'temporary', 'uploading', ?, '{}', ?, ?)`,
        )
        .bind(id, user.email, key, body.filename, contentType, body.bytes, upload.uploadId, now, now)
        .run();
    return { id, partBytes: PART_BYTES, parts: Math.ceil(body.bytes / PART_BYTES), format: claimed.format };
}

const partInput = z.object({ data: z.string().max(Math.ceil((PART_BYTES * 4) / 3) + 16) }).strict();

export async function uploadPart(db: D1Database, bucket: R2Bucket, user: PortalUser, id: string, partNumber: number, input: unknown) {
    const row = await ownAttachment(db, user, id);
    if (row.status !== "uploading" || !row.upload_id) throw new HttpError(409, "conflict", "That upload is already finished");
    const expected = Math.ceil(row.bytes / PART_BYTES);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > expected) throw new HttpError(422, "validation", "Unexpected part number");
    const { data } = partInput.parse(input);
    let bytes: Uint8Array;
    try {
        bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    } catch {
        throw new HttpError(422, "validation", "That part couldn't be read");
    }
    const size = partNumber < expected ? PART_BYTES : row.bytes - PART_BYTES * (expected - 1);
    if (bytes.length !== size) throw new HttpError(422, "validation", "That part is the wrong size");
    if (partNumber === 1) {
        const claimed = claimedKind(row.filename, row.content_type.startsWith("audio/") ? "audio" : "document")!;
        const mismatch = sniffMismatch(bytes, claimed);
        if (mismatch) {
            await abandon(db, bucket, row);
            throw new HttpError(422, "validation", mismatch);
        }
    }
    const part = await bucket.resumeMultipartUpload(row.r2_key, row.upload_id).uploadPart(partNumber, bytes);
    await db
        .prepare("UPDATE attachments SET parts = json_set(COALESCE(parts, '{}'), ?, ?), updated_at = ? WHERE id = ? AND status = 'uploading'")
        .bind(`$."${partNumber}"`, part.etag, nowIso(), id)
        .run();
    const parts = parseJson<Record<string, string>>((await getAttachment(db, id))?.parts ?? null, {});
    return { received: Object.keys(parts).length, of: expected };
}

async function abandon(db: D1Database, bucket: R2Bucket, row: AttachmentRow) {
    if (row.upload_id)
        await bucket
            .resumeMultipartUpload(row.r2_key, row.upload_id)
            .abort()
            .catch(() => undefined);
    await db.prepare("UPDATE attachments SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").bind(nowIso(), nowIso(), row.id).run();
}

/** Assembles the parts. The stored file must be exactly the size declared at the start. */
export async function completeUpload(db: D1Database, bucket: R2Bucket, user: PortalUser, id: string): Promise<AttachmentRow> {
    const row = await ownAttachment(db, user, id);
    if (row.status !== "uploading" || !row.upload_id) return row;
    const parts = parseJson<Record<string, string>>(row.parts, {});
    const expected = Math.ceil(row.bytes / PART_BYTES);
    if (Object.keys(parts).length !== expected) throw new HttpError(409, "incomplete", `Received ${Object.keys(parts).length} of ${expected} parts`);
    const object = await bucket
        .resumeMultipartUpload(row.r2_key, row.upload_id)
        .complete(Array.from({ length: expected }, (_, i) => ({ partNumber: i + 1, etag: parts[String(i + 1)] })));
    if (object.size !== row.bytes) {
        await bucket.delete(row.r2_key);
        await abandon(db, bucket, row);
        throw new HttpError(422, "validation", "The upload didn't arrive intact. Try again.");
    }
    await db.prepare("UPDATE attachments SET status = 'stored', upload_id = NULL, parts = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
    return (await getAttachment(db, id))!;
}

export async function readAttachmentBytes(bucket: R2Bucket, row: AttachmentRow, range?: { offset: number; length: number }): Promise<Uint8Array> {
    const object = await bucket.get(row.r2_key, range ? { range } : undefined);
    if (!object) throw new HttpError(404, "not_found", "That file is no longer stored");
    return new Uint8Array(await object.arrayBuffer());
}

/** After processing: start the temporary retention clock (or the longer one for a failure). */
export async function settleProcessing(db: D1Database, config: IntelligenceConfig, id: string, ok: boolean) {
    const days = ok ? config.retention.temporaryDays : config.retention.failedDays;
    await db
        .prepare(
            `UPDATE attachments SET status = ?, purge_after = ?, updated_at = ? WHERE id = ? AND retention = 'temporary' AND keep = 0 AND status IN ('stored', 'processed', 'failed')`,
        )
        .bind(ok ? "processed" : "failed", new Date(Date.now() + days * 86_400_000).toISOString(), nowIso(), id)
        .run();
}

// --- Keeping, deleting, downloading --------------------------------------------------------------

/** Keeps an uploaded file permanently, attached to a Knowledge object the caller can edit. */
export async function keepInKnowledge(db: D1Database, user: PortalUser, id: string, objectId: string): Promise<AttachmentRow> {
    const row = await ownAttachment(db, user, id);
    if (row.status === "uploading") throw new HttpError(409, "conflict", "Finish the upload first");
    const object = await requireObject(db, user, objectId, "editor");
    await db
        .prepare(
            `UPDATE attachments SET purpose = 'knowledge', retention = 'permanent', keep = 1, space_id = ?, object_id = ?, purge_after = NULL,
                status = CASE WHEN status = 'failed' THEN 'stored' ELSE status END, updated_at = ? WHERE id = ?`,
        )
        .bind(object.space_id, object.id, nowIso(), id)
        .run();
    return (await getAttachment(db, id))!;
}

/** Keeps a file with a task (kept while the task exists). */
export async function keepWithTask(db: D1Database, user: PortalUser, id: string, taskId: string): Promise<AttachmentRow> {
    const row = await ownAttachment(db, user, id);
    if (row.status === "uploading") throw new HttpError(409, "conflict", "Finish the upload first");
    await requireTask(db, user, taskId, "editor");
    await db
        .prepare(
            "UPDATE attachments SET purpose = 'task', retention = 'referenced', keep = 0, task_id = ?, purge_after = NULL, updated_at = ? WHERE id = ? AND keep = 0",
        )
        .bind(taskId, nowIso(), id)
        .run();
    return (await getAttachment(db, id))!;
}

/** A person deleting a file on purpose. Permanent files need the typed confirmation, and only their owner or an editor of the object. */
export async function deleteAttachment(db: D1Database, bucket: R2Bucket, user: PortalUser, id: string, input: unknown) {
    const row = await readableAttachment(db, user, id);
    if (row.owner_email !== user.email) {
        if (row.purpose === "knowledge" && row.object_id) await requireObject(db, user, row.object_id, "editor");
        else throw new HttpError(404, "not_found", "Not found");
    }
    if (row.retention === "permanent" || row.keep) z.object({ confirm: z.literal("DELETE", "Type DELETE to confirm") }).parse(input ?? {});
    await bucket.delete(row.r2_key);
    await db.prepare("UPDATE attachments SET status = 'deleted', keep = 0, deleted_at = ?, updated_at = ? WHERE id = ?").bind(nowIso(), nowIso(), id).run();
}

export async function downloadAttachment(db: D1Database, bucket: R2Bucket, user: PortalUser, id: string): Promise<Response> {
    const row = await readableAttachment(db, user, id);
    if (row.status === "uploading") throw new HttpError(409, "conflict", "That upload isn't finished");
    const object = await bucket.get(row.r2_key);
    if (!object) throw new HttpError(404, "not_found", "That file is no longer stored");
    const safe = row.filename.replace(/[^A-Za-z0-9._ -]+/g, "_").slice(0, 120) || "file";
    return new Response(object.body as unknown as ReadableStream, {
        headers: {
            "Content-Type": row.content_type,
            "Content-Disposition": `attachment; filename="${safe}"`,
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
            "X-Robots-Tag": "noindex",
        },
    });
}

// --- Retention -------------------------------------------------------------------------------------

/**
 * One bounded retention pass (the cron). Deletes only temporary files past their date, abandoned
 * uploads and task files whose task has been gone for the grace period. Permanent and kept files
 * are excluded by the queries themselves, not by a check afterwards.
 */
export async function purgeExpired(
    db: D1Database,
    bucket: R2Bucket,
    config: IntelligenceConfig,
    limit = 100,
): Promise<{ purged: number; abandoned: number; orphaned: number }> {
    const now = nowIso();
    const due = await db
        .prepare(
            `SELECT * FROM attachments WHERE retention <> 'permanent' AND keep = 0 AND status IN ('processed', 'failed', 'stored') AND purge_after IS NOT NULL AND purge_after <= ? LIMIT ?`,
        )
        .bind(now, limit)
        .all<AttachmentRow>();
    for (const row of due.results) {
        await bucket.delete(row.r2_key);
        await db
            .prepare("UPDATE attachments SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ? AND keep = 0 AND retention <> 'permanent'")
            .bind(now, now, row.id)
            .run();
    }
    const stale = await db
        .prepare("SELECT * FROM attachments WHERE status = 'uploading' AND created_at < ? LIMIT ?")
        .bind(new Date(Date.now() - UPLOAD_ABANDONED_MS).toISOString(), limit)
        .all<AttachmentRow>();
    for (const row of stale.results) await abandon(db, bucket, row);
    // A task attachment whose task was deleted starts its grace period (recoverable until then).
    const orphaned = await db
        .prepare(
            `UPDATE attachments SET purge_after = ?, updated_at = ? WHERE retention = 'referenced' AND keep = 0 AND status <> 'deleted' AND purge_after IS NULL
               AND task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_items t WHERE t.id = attachments.task_id)`,
        )
        .bind(new Date(Date.now() + config.retention.unreferencedGraceDays * 86_400_000).toISOString(), now)
        .run();
    return { purged: due.results.length, abandoned: stale.results.length, orphaned: orphaned.meta.changes ?? 0 };
}

export async function storageSummary(db: D1Database, user: PortalUser): Promise<StorageSummary> {
    const [totals, due, mine] = await db.batch([
        // Account-wide counts and sizes only: no names, no owners.
        db.prepare(
            "SELECT purpose, retention, COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM attachments WHERE status <> 'deleted' GROUP BY purpose, retention",
        ),
        db
            .prepare(
                "SELECT COUNT(*) AS n FROM attachments WHERE status <> 'deleted' AND keep = 0 AND retention <> 'permanent' AND purge_after IS NOT NULL AND purge_after <= ?",
            )
            .bind(new Date(Date.now() + 86_400_000).toISOString()),
        db.prepare("SELECT * FROM attachments WHERE owner_email = ? AND status <> 'deleted' ORDER BY created_at DESC LIMIT 100").bind(user.email),
    ]);
    return {
        totals: totals.results as StorageSummary["totals"],
        purgeDue: (due.results[0] as { n: number } | undefined)?.n ?? 0,
        attachments: (mine.results as AttachmentRow[]).map(toAttachmentView),
    };
}
