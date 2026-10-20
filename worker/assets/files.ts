// Photos and documents for assets, places and policies, in R2.
//
// Storage: every file is under "private/assets/<file id>/<random>", which no public route serves
// (the blog's /media/ route accepts only its own hashed names, the wedding site only "wedding/"),
// so nothing is reachable by guessing a URL. Files are read back only through
// /api/portal/assets/files/:id/content, after the same access checks as the record they belong
// to, with no-store, nosniff and a sandboxing CSP. Photos are shown inline (they're re-checked as
// images); every other file is a download, never rendered.
//
// Checks: the type comes from the file's first bytes, never its name or the browser's claim. Only
// JPEG, PNG and WebP images (no SVG, which can carry script), PDF, plain text, Word and Excel are
// accepted, within LIMITS. Office files are checked for decompression bombs before being stored.
// Location and camera metadata (EXIF, XMP, IPTC, text chunks) is removed from images before they're
// stored; photos are also resized in the browser first. There's no virus scanner: files are never
// executed, rendered as HTML or served to anyone outside the household, which is the documented
// strategy for this private system (as for Intelligence attachments).
//
// The same file added twice to the same record is recognised by its SHA-256 and not stored again.
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { z } from "zod";
import { type AssetFileView, FILE_KINDS, LIMITS, PHOTO_TAGS } from "../../src/shared/assets/types";
import type { PortalUser } from "../../src/shared/portal/types";
import { zipBombReason } from "../intelligence/attachments";
import { imageDimensions } from "../lib/image";
import { newId, nowIso } from "../portal/db";
import { HttpError } from "../portal/http";
import {
    LOCATION_VISIBLE,
    POLICY_VISIBLE,
    activity,
    assetPreferences,
    canEditLocation,
    canEditPolicy,
    notFound,
    refuse,
    requireAsset,
    requireLocation,
    requirePolicy,
    rightsOf,
    visibleAssets,
} from "./access";
import { setDefaultCover } from "./assets";
import { requireRecord } from "./maintenance";

// --- Recognising files ---------------------------------------------------------------------------

export type Sniffed = { type: string; ext: string; image: boolean };

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

/** What a file actually is, from its first bytes. Null for anything not accepted. */
export function sniff(bytes: Uint8Array): Sniffed | { rejected: string } | null {
    if (bytes.length < 4) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: "image/jpeg", ext: "jpg", image: true };
    if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") return { type: "image/png", ext: "png", image: true };
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return { type: "image/webp", ext: "webp", image: true };
    if (ascii(bytes, 0, 5) === "%PDF-") return { type: "application/pdf", ext: "pdf", image: false };
    if (ascii(bytes, 4, 8) === "ftyp" && /^(heic|heix|hevc|mif1|msf1|avif)/.test(ascii(bytes, 8, 12)))
        return {
            rejected: "HEIC and AVIF photos can't be stored yet. Choose the photo again from your Photos library (which converts it), or save it as JPEG.",
        };
    if (ascii(bytes, 0, 5) === "<?xml" || /<svg[\s>]/i.test(ascii(bytes, 0, Math.min(bytes.length, 512))))
        return { rejected: "SVG and XML files aren't accepted" };
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return { type: "application/zip", ext: "zip", image: false };
    // Plain text: no NUL bytes, decodes as UTF-8, and doesn't look like markup.
    const head = bytes.subarray(0, 8192);
    if (!head.includes(0)) {
        try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(head.length < bytes.length ? head.subarray(0, Math.max(0, head.length - 4)) : head);
            if (/^\s*<(?:!doctype|html|script)/i.test(text)) return { rejected: "HTML files aren't accepted" };
            return { type: "text/plain; charset=utf-8", ext: "txt", image: false };
        } catch {
            return null;
        }
    }
    return null;
}

/** An Office file, by the name it was given (the bytes only say "ZIP"). Anything else zipped is refused. */
const officeType = (filename: string) => {
    const ext = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1].toLowerCase();
    if (ext === "docx") return { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx", image: false };
    if (ext === "xlsx") return { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx", image: false };
    return null;
};

// --- Removing image metadata ---------------------------------------------------------------------

/** JPEG without APP1 (EXIF/XMP, including GPS), APP13 (IPTC) and comments. Image data is untouched. */
export function stripJpeg(bytes: Uint8Array): Uint8Array {
    const out: Uint8Array[] = [bytes.subarray(0, 2)];
    let p = 2;
    while (p + 4 <= bytes.length) {
        if (bytes[p] !== 0xff) return bytes; // Not a marker where one should be: keep the file as it was.
        const marker = bytes[p + 1];
        if (marker === 0xd9) break;
        if (marker === 0xda) {
            out.push(bytes.subarray(p));
            p = bytes.length;
            break;
        }
        if (marker >= 0xd0 && marker <= 0xd7) {
            out.push(bytes.subarray(p, p + 2));
            p += 2;
            continue;
        }
        const length = (bytes[p + 2] << 8) | bytes[p + 3];
        if (length < 2 || p + 2 + length > bytes.length) return bytes;
        const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
        if (!drop) out.push(bytes.subarray(p, p + 2 + length));
        p += 2 + length;
    }
    if (p < bytes.length) out.push(bytes.subarray(p));
    return concat(out);
}

/** PNG without text, EXIF and time chunks. */
export function stripPng(bytes: Uint8Array): Uint8Array {
    const out: Uint8Array[] = [bytes.subarray(0, 8)];
    let p = 8;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (p + 12 <= bytes.length) {
        const length = view.getUint32(p);
        const type = ascii(bytes, p + 4, p + 8);
        const end = p + 12 + length;
        if (end > bytes.length) return bytes;
        if (!["tEXt", "zTXt", "iTXt", "eXIf", "tIME"].includes(type)) out.push(bytes.subarray(p, end));
        p = end;
        if (type === "IEND") break;
    }
    return concat(out);
}

/** WebP without EXIF and XMP chunks (and their flags in VP8X). */
export function stripWebp(bytes: Uint8Array): Uint8Array {
    const chunks: Uint8Array[] = [];
    let p = 12;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (p + 8 <= bytes.length) {
        const type = ascii(bytes, p, p + 4);
        const size = view.getUint32(p + 4, true);
        const end = p + 8 + size + (size % 2);
        if (end > bytes.length + 1) return bytes;
        if (type !== "EXIF" && type !== "XMP ") {
            const chunk = bytes.slice(p, Math.min(end, bytes.length));
            // VP8X flags: 0x08 EXIF, 0x04 XMP.
            if (type === "VP8X" && chunk.length > 8) chunk[8] &= ~0x0c;
            chunks.push(chunk);
        }
        p = end;
    }
    const body = concat(chunks);
    const out = new Uint8Array(12 + body.length);
    out.set(bytes.subarray(0, 12));
    new DataView(out.buffer).setUint32(4, 4 + body.length, true);
    out.set(body, 12);
    return out;
}

const concat = (parts: Uint8Array[]) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
};

export const stripMetadata = (bytes: Uint8Array, type: string) =>
    type === "image/jpeg" ? stripJpeg(bytes) : type === "image/png" ? stripPng(bytes) : type === "image/webp" ? stripWebp(bytes) : bytes;

const fromBase64 = (data: string, max: number): Uint8Array => {
    let binary: string;
    try {
        binary = atob(data);
    } catch {
        throw new HttpError(422, "validation", "That file couldn't be read");
    }
    if (binary.length > max) throw new HttpError(413, "too_large", `Files can be up to ${Math.round(max / 1024 / 1024)} MB`);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
};

const sha256 = async (bytes: Uint8Array) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");

const randomPart = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

// --- Rows and access -----------------------------------------------------------------------------

export interface FileRow {
    id: string;
    owner_email: string;
    asset_id: string | null;
    location_id: string | null;
    policy_id: string | null;
    maintenance_id: string | null;
    warranty_id: string | null;
    claim_id: string | null;
    kind: AssetFileView["kind"];
    photo_tag: AssetFileView["photoTag"];
    caption: string | null;
    filename: string;
    content_type: string;
    bytes: number;
    sha256: string;
    r2_key: string;
    thumb_key: string | null;
    width: number | null;
    height: number | null;
    status: "stored" | "deleted";
    created_at: string;
    asset_name?: string | null;
}

export const fileOut = (r: FileRow, email: string): AssetFileView => ({
    id: r.id,
    kind: r.kind,
    photoTag: r.photo_tag,
    caption: r.caption,
    filename: r.filename,
    contentType: r.content_type,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    hasThumb: !!r.thumb_key,
    assetId: r.asset_id,
    assetName: r.asset_name ?? null,
    locationId: r.location_id,
    policyId: r.policy_id,
    maintenanceId: r.maintenance_id,
    warrantyId: r.warranty_id,
    claimId: r.claim_id,
    uploadedBy: r.owner_email,
    mine: r.owner_email === email,
    createdAt: r.created_at,
});

/** A file the caller may open. Anything else is 404, including documents of an asset whose documents aren't shared with them. */
export async function requireFile(db: D1Database, user: PortalUser, id: string): Promise<FileRow> {
    const row = await db.prepare("SELECT * FROM asset_files WHERE id = ? AND status = 'stored'").bind(id).first<FileRow>();
    if (!row) throw notFound();
    if (row.asset_id) {
        const { rights } = await requireAsset(db, user, row.asset_id);
        if (row.kind !== "photo" && !rights.documents) throw notFound();
    } else if (row.location_id) await requireLocation(db, user, row.location_id);
    else if (row.policy_id) await requirePolicy(db, user, row.policy_id);
    else if (row.owner_email !== user.email) throw notFound();
    return row;
}

/** Whether the caller may add a file of this kind to this record (and tie it to a maintenance record, warranty or claim of it). */
async function checkTarget(db: D1Database, user: PortalUser, t: Target, kind: AssetFileView["kind"]) {
    const parents = [t.assetId, t.locationId, t.policyId].filter(Boolean).length;
    if (parents > 1) throw new HttpError(422, "validation", "A file belongs to one asset, place or policy");
    if ((t.maintenanceId || t.warrantyId || t.claimId) && !t.assetId && !t.locationId)
        throw new HttpError(422, "validation", "Choose the asset or place this belongs to");
    if (t.assetId) {
        const { rights } = await requireAsset(db, user, t.assetId);
        // Photos and work records can come from anyone who records maintenance; other documents need edit rights and document access.
        if (kind === "photo" || (t.maintenanceId && rights.maintain)) {
            if (!rights.maintain) throw refuse("maintain");
        } else if (!rights.edit) throw refuse("edit");
        if (kind !== "photo" && !rights.documents) throw refuse("documents");
        const count = await db.prepare("SELECT COUNT(*) AS n FROM asset_files WHERE asset_id = ? AND status = 'stored'").bind(t.assetId).first<{ n: number }>();
        if ((count?.n ?? 0) >= LIMITS.filesPerAsset) throw new HttpError(422, "limit", `An asset can have up to ${LIMITS.filesPerAsset} files`);
    }
    if (t.locationId) await requireLocation(db, user, t.locationId, true);
    if (t.policyId) await requirePolicy(db, user, t.policyId, true);
    if (t.maintenanceId) {
        const { row } = await requireRecord(db, user, t.maintenanceId, true);
        if ((row.asset_id ?? null) !== (t.assetId ?? null) || (row.location_id ?? null) !== (t.locationId ?? null))
            throw new HttpError(422, "validation", "That maintenance record belongs to something else");
    }
    for (const [column, value] of [
        ["asset_warranties", t.warrantyId],
        ["asset_claims", t.claimId],
    ] as const)
        if (value) {
            const owner = await db.prepare(`SELECT asset_id FROM ${column} WHERE id = ?`).bind(value).first<{ asset_id: string | null }>();
            if (!owner || owner.asset_id !== t.assetId) throw new HttpError(422, "validation", "That record belongs to another asset");
        }
}

interface Target {
    assetId?: string | null;
    locationId?: string | null;
    policyId?: string | null;
    maintenanceId?: string | null;
    warrantyId?: string | null;
    claimId?: string | null;
}

const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{14}$`));

const uploadInput = z
    .object({
        data: z.string().max(Math.ceil((LIMITS.maxFileBytes * 4) / 3) + 16),
        filename: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .transform((v) => v.replace(/[/\\\u0000-\u001f]/g, "_")),
        kind: z.enum(FILE_KINDS),
        photoTag: z.enum(PHOTO_TAGS).nullable().optional(),
        caption: z.string().trim().max(300).nullable().optional(),
        /** A small JPEG preview made in the browser (photos only). */
        thumb: z
            .string()
            .max(Math.ceil((LIMITS.maxThumbBytes * 4) / 3) + 16)
            .optional(),
        assetId: idOf("ast").nullable().optional(),
        locationId: idOf("alo").nullable().optional(),
        policyId: idOf("aip").nullable().optional(),
        maintenanceId: idOf("amr").nullable().optional(),
        warrantyId: idOf("awr").nullable().optional(),
        claimId: idOf("acl").nullable().optional(),
    })
    .strict();

export interface UploadResult {
    file: AssetFileView;
    /** It was already stored on this record: nothing new was added. */
    duplicate: boolean;
    /** The same file is also on other assets you can see. */
    alsoOn: { assetId: string; name: string }[];
}

export async function uploadFile(db: D1Database, bucket: R2Bucket, user: PortalUser, input: unknown): Promise<UploadResult> {
    const body = uploadInput.parse(input);
    await checkTarget(db, user, body, body.kind);
    const raw = fromBase64(body.data, body.kind === "photo" ? LIMITS.maxPhotoBytes : LIMITS.maxFileBytes);
    const found = sniff(raw);
    if (found && "rejected" in found) throw new HttpError(422, "validation", found.rejected);
    let kind = found;
    if (kind?.type === "application/zip") {
        kind = officeType(body.filename);
        if (!kind) throw new HttpError(422, "validation", "Zip archives aren't accepted. Word (.docx) and Excel (.xlsx) files are.");
        const bomb = zipBombReason(raw);
        if (bomb) throw new HttpError(422, "validation", bomb);
    }
    if (!kind) throw new HttpError(422, "validation", "Use a JPEG, PNG or WebP photo, a PDF, a text file, or a Word or Excel document");
    if (body.kind === "photo" && !kind.image) throw new HttpError(422, "validation", "A photo has to be a JPEG, PNG or WebP image");
    const bytes = stripMetadata(raw, kind.type);
    const hash = await sha256(bytes);

    // The same file on the same record: say so instead of storing it twice.
    const parent = body.assetId
        ? ["asset_id", body.assetId]
        : body.locationId
          ? ["location_id", body.locationId]
          : body.policyId
            ? ["policy_id", body.policyId]
            : null;
    const same = await db
        .prepare(
            parent
                ? `SELECT * FROM asset_files WHERE sha256 = ? AND status = 'stored' AND ${parent[0]} = ?`
                : "SELECT * FROM asset_files WHERE sha256 = ? AND status = 'stored' AND owner_email = ? AND asset_id IS NULL AND location_id IS NULL AND policy_id IS NULL",
        )
        .bind(hash, parent ? parent[1] : user.email)
        .first<FileRow>();
    const alsoOn = await duplicatesElsewhere(db, user, hash, body.assetId ?? null);
    if (same) return { file: fileOut(same, user.email), duplicate: true, alsoOn };

    let thumb: Uint8Array | null = null;
    if (body.thumb && kind.image) {
        thumb = fromBase64(body.thumb, LIMITS.maxThumbBytes);
        const t = sniff(thumb);
        if (!t || "rejected" in t || t.type !== "image/jpeg") throw new HttpError(422, "validation", "The preview has to be a JPEG");
        thumb = stripJpeg(thumb);
    }
    const id = newId("afl");
    const key = `private/assets/${id}/${randomPart()}`;
    const thumbKey = thumb ? `private/assets/${id}/${randomPart()}-t` : null;
    const size = kind.image ? imageDimensions(bytes, kind.type) : null;
    await bucket.put(key, bytes, { httpMetadata: { contentType: kind.type, contentDisposition: "attachment" } });
    if (thumb && thumbKey) await bucket.put(thumbKey, thumb, { httpMetadata: { contentType: "image/jpeg" } });
    const now = nowIso();
    const filename = body.filename.replace(/\.[A-Za-z0-9]{1,8}$/, "") + `.${kind.ext}`;
    try {
        await db.batch([
            db
                .prepare(
                    `INSERT INTO asset_files (id, owner_email, asset_id, location_id, policy_id, maintenance_id, warranty_id, claim_id, kind, photo_tag, caption, filename, content_type, bytes, sha256, r2_key, thumb_key, width, height, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    id,
                    user.email,
                    body.assetId ?? null,
                    body.locationId ?? null,
                    body.policyId ?? null,
                    body.maintenanceId ?? null,
                    body.warrantyId ?? null,
                    body.claimId ?? null,
                    body.kind,
                    body.kind === "photo" ? (body.photoTag ?? "general") : null,
                    body.caption ?? null,
                    filename,
                    kind.type,
                    bytes.length,
                    hash,
                    key,
                    thumbKey,
                    size?.width ?? null,
                    size?.height ?? null,
                    now,
                    now,
                ),
            activity(db, { actor: user.email, action: "file.upload", entityType: "file", entityId: id, assetId: body.assetId ?? null }),
        ]);
    } catch (error) {
        await bucket.delete([key, ...(thumbKey ? [thumbKey] : [])]);
        throw error;
    }
    if (body.assetId && body.kind === "photo") await setDefaultCover(db, body.assetId);
    const row = (await db.prepare("SELECT * FROM asset_files WHERE id = ?").bind(id).first<FileRow>())!;
    return { file: fileOut(row, user.email), duplicate: false, alsoOn };
}

async function duplicatesElsewhere(db: D1Database, user: PortalUser, hash: string, except: string | null) {
    const rows = await db
        .prepare("SELECT DISTINCT asset_id FROM asset_files WHERE sha256 = ? AND status = 'stored' AND asset_id IS NOT NULL AND asset_id IS NOT ? LIMIT 10")
        .bind(hash, except)
        .all<{ asset_id: string }>();
    const out: { assetId: string; name: string }[] = [];
    for (const r of rows.results) {
        const access = await requireAsset(db, user, r.asset_id).catch(() => null);
        if (access) out.push({ assetId: r.asset_id, name: access.row.name });
    }
    return out;
}

// --- Reading -------------------------------------------------------------------------------------

/** Files on one asset as the caller may see them: photos always, documents with the right. */
export async function filesForAsset(db: D1Database, user: PortalUser, assetId: string): Promise<{ files: AssetFileView[]; hidden: number }> {
    const { rights } = await requireAsset(db, user, assetId);
    const rows = await db
        .prepare("SELECT * FROM asset_files WHERE asset_id = ? AND status = 'stored' ORDER BY created_at DESC LIMIT 300")
        .bind(assetId)
        .all<FileRow>();
    const shown = rows.results.filter((r) => r.kind === "photo" || rights.documents);
    return { files: shown.map((r) => fileOut(r, user.email)), hidden: rows.results.length - shown.length };
}

export async function filesFor(db: D1Database, user: PortalUser, column: "location_id" | "policy_id" | "maintenance_id", id: string): Promise<AssetFileView[]> {
    const rows = await db
        .prepare(`SELECT * FROM asset_files WHERE ${column} = ? AND status = 'stored' ORDER BY created_at DESC LIMIT 300`)
        .bind(id)
        .all<FileRow>();
    const out: AssetFileView[] = [];
    for (const r of rows.results) if (await requireFile(db, user, r.id).catch(() => null)) out.push(fileOut(r, user.email));
    return out;
}

/** Every file the caller can open, newest first, and their own unfiled uploads (the capture inbox). */
export async function listFiles(db: D1Database, user: PortalUser, limit = 500): Promise<{ files: AssetFileView[]; inbox: AssetFileView[] }> {
    const assets = new Map((await visibleAssets(db, user, 5000)).map((a) => [a.id, a]));
    const rows = await db
        .prepare(
            `SELECT f.*, a.name AS asset_name FROM asset_files f LEFT JOIN assets a ON a.id = f.asset_id
             LEFT JOIN asset_locations l ON l.id = f.location_id LEFT JOIN asset_policies p ON p.id = f.policy_id
             WHERE f.status = 'stored' AND (f.asset_id IS NOT NULL OR (f.location_id IS NOT NULL AND ${LOCATION_VISIBLE}) OR (f.policy_id IS NOT NULL AND ${POLICY_VISIBLE})
                OR (f.owner_email = ?1 AND f.asset_id IS NULL AND f.location_id IS NULL AND f.policy_id IS NULL))
             ORDER BY f.created_at DESC LIMIT ${Math.min(limit, 2000)}`,
        )
        .bind(user.email)
        .all<FileRow>();
    const files: AssetFileView[] = [];
    const inbox: AssetFileView[] = [];
    for (const r of rows.results) {
        if (r.asset_id) {
            const a = assets.get(r.asset_id);
            if (!a || (r.kind !== "photo" && !rightsOf(a).documents)) continue;
            files.push(fileOut(r, user.email));
        } else if (r.location_id || r.policy_id) files.push(fileOut(r, user.email));
        else inbox.push(fileOut(r, user.email));
    }
    return { files, inbox };
}

const downloadHeaders = (type: string, filename: string, inline: boolean) => ({
    "Content-Type": type,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/[^A-Za-z0-9._ -]+/g, "_").slice(0, 120) || "file"}"`,
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Cross-Origin-Resource-Policy": "same-origin",
});

/** The file, after access checks. Images inline (so they can be shown), everything else as a download. */
export async function fileContent(db: D1Database, bucket: R2Bucket, user: PortalUser, id: string, thumb = false): Promise<Response> {
    const row = await requireFile(db, user, id);
    const key = thumb && row.thumb_key ? row.thumb_key : row.r2_key;
    const object = await bucket.get(key);
    if (!object) throw new HttpError(404, "not_found", "That file is no longer stored");
    const image = row.content_type.startsWith("image/");
    return new Response(object.body as unknown as ReadableStream, {
        headers: downloadHeaders(thumb && row.thumb_key ? "image/jpeg" : row.content_type, row.filename, image),
    });
}

/** Text from a file for AI processing, bounded. */
export async function fileBytes(bucket: R2Bucket, row: FileRow): Promise<Uint8Array> {
    const object = await bucket.get(row.r2_key);
    if (!object) throw new HttpError(404, "not_found", "That file is no longer stored");
    return new Uint8Array(await object.arrayBuffer());
}

// --- Changing ------------------------------------------------------------------------------------

const updateInput = z
    .object({
        caption: z.string().trim().max(300).nullable().optional(),
        kind: z.enum(FILE_KINDS).optional(),
        photoTag: z.enum(PHOTO_TAGS).nullable().optional(),
        assetId: idOf("ast").nullable().optional(),
        locationId: idOf("alo").nullable().optional(),
        policyId: idOf("aip").nullable().optional(),
        maintenanceId: idOf("amr").nullable().optional(),
        warrantyId: idOf("awr").nullable().optional(),
        claimId: idOf("acl").nullable().optional(),
    })
    .strict();

/** Whether the caller may change or remove a file: its uploader (still allowed to add it), or the record's owner. */
async function requireChangeable(db: D1Database, user: PortalUser, row: FileRow) {
    if (row.asset_id) {
        const { rights } = await requireAsset(db, user, row.asset_id);
        if (rights.manage) return;
        if (row.owner_email === user.email && (rights.edit || (rights.maintain && (row.kind === "photo" || row.maintenance_id)))) return;
        throw refuse("edit");
    }
    if (row.location_id) {
        const l = await requireLocation(db, user, row.location_id);
        if (l.owner_email === user.email || (row.owner_email === user.email && canEditLocation(l, user.email))) return;
        throw new HttpError(403, "forbidden", "You can't change this place's files");
    }
    if (row.policy_id) {
        const p = await requirePolicy(db, user, row.policy_id);
        if (p.owner_email === user.email || (row.owner_email === user.email && canEditPolicy(p, user.email))) return;
        throw new HttpError(403, "forbidden", "You can't change this policy's files");
    }
    if (row.owner_email !== user.email) throw notFound();
}

export async function updateFile(db: D1Database, user: PortalUser, id: string, input: unknown): Promise<AssetFileView> {
    const body = updateInput.parse(input);
    const row = await requireFile(db, user, id);
    await requireChangeable(db, user, row);
    const moving = ["assetId", "locationId", "policyId", "maintenanceId", "warrantyId", "claimId"].some(
        (k) => (body as Record<string, unknown>)[k] !== undefined,
    );
    const target: Target = {
        assetId: body.assetId === undefined ? row.asset_id : body.assetId,
        locationId: body.locationId === undefined ? row.location_id : body.locationId,
        policyId: body.policyId === undefined ? row.policy_id : body.policyId,
        maintenanceId: body.maintenanceId === undefined ? row.maintenance_id : body.maintenanceId,
        warrantyId: body.warrantyId === undefined ? row.warranty_id : body.warrantyId,
        claimId: body.claimId === undefined ? row.claim_id : body.claimId,
    };
    // A file moved to another record keeps only the links that make sense there.
    if (body.assetId !== undefined && body.assetId !== row.asset_id) {
        if (body.maintenanceId === undefined) target.maintenanceId = null;
        if (body.warrantyId === undefined) target.warrantyId = null;
        if (body.claimId === undefined) target.claimId = null;
    }
    const kind = body.kind ?? row.kind;
    if (kind === "photo" && !row.content_type.startsWith("image/")) throw new HttpError(422, "validation", "Only an image can be a photo");
    if (moving || body.kind) await checkTarget(db, user, target, kind);
    await db.batch([
        db
            .prepare(
                `UPDATE asset_files SET caption = ?, kind = ?, photo_tag = ?, asset_id = ?, location_id = ?, policy_id = ?, maintenance_id = ?, warranty_id = ?, claim_id = ?, updated_at = ? WHERE id = ?`,
            )
            .bind(
                body.caption === undefined ? row.caption : body.caption,
                kind,
                kind === "photo" ? (body.photoTag === undefined ? (row.photo_tag ?? "general") : (body.photoTag ?? "general")) : null,
                target.assetId ?? null,
                target.locationId ?? null,
                target.policyId ?? null,
                target.maintenanceId ?? null,
                target.warrantyId ?? null,
                target.claimId ?? null,
                nowIso(),
                id,
            ),
        activity(db, {
            actor: user.email,
            action: moving ? "file.move" : "file.update",
            entityType: "file",
            entityId: id,
            assetId: target.assetId ?? row.asset_id,
        }),
    ]);
    for (const a of new Set([row.asset_id, target.assetId].filter((x): x is string => !!x))) await setDefaultCover(db, a);
    return fileOut((await db.prepare("SELECT * FROM asset_files WHERE id = ?").bind(id).first<FileRow>())!, user.email);
}

/** Deleting on purpose: the stored file and its preview are removed from R2 straight away. */
export async function deleteFile(db: D1Database, bucket: R2Bucket, user: PortalUser, id: string): Promise<void> {
    const row = await requireFile(db, user, id);
    await requireChangeable(db, user, row);
    await bucket.delete([row.r2_key, ...(row.thumb_key ? [row.thumb_key] : [])]);
    await db.batch([
        db.prepare("UPDATE asset_files SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").bind(nowIso(), nowIso(), id),
        db.prepare("UPDATE assets SET cover_file_id = NULL WHERE cover_file_id = ?").bind(id),
        activity(db, { actor: user.email, action: "file.delete", entityType: "file", entityId: id, assetId: row.asset_id }),
    ]);
    if (row.asset_id) await setDefaultCover(db, row.asset_id);
}

export async function setCover(db: D1Database, user: PortalUser, assetId: string, fileId: string) {
    await requireAsset(db, user, assetId, "edit");
    const file = await db
        .prepare("SELECT id FROM asset_files WHERE id = ? AND asset_id = ? AND kind = 'photo' AND status = 'stored'")
        .bind(fileId, assetId)
        .first();
    if (!file) throw new HttpError(422, "validation", "Choose one of this asset's photos");
    await db.batch([
        db.prepare("UPDATE assets SET cover_file_id = ?, updated_at = ? WHERE id = ?").bind(fileId, nowIso(), assetId),
        activity(db, { actor: user.email, action: "asset.cover", entityType: "asset", entityId: assetId, assetId }),
    ]);
}

// --- Retention -----------------------------------------------------------------------------------

/**
 * Documents of the caller's own assets disposed of more than their chosen number of years ago,
 * listed for review. Nothing is deleted automatically: the person decides.
 */
export async function retentionDue(db: D1Database, user: PortalUser): Promise<AssetFileView[]> {
    const { preferences } = await assetPreferences(db, user.email);
    const years = preferences.retention.disposedYears;
    if (!years) return [];
    const cutoff = new Date(Date.now() - years * 365.25 * 86_400_000).toISOString().slice(0, 10);
    const rows = await db
        .prepare(
            `SELECT f.*, a.name AS asset_name FROM asset_files f JOIN assets a ON a.id = f.asset_id
             WHERE a.owner_email = ? AND a.deleted_at IS NULL AND a.disposed_on IS NOT NULL AND a.disposed_on < ? AND f.status = 'stored' ORDER BY a.disposed_on LIMIT 500`,
        )
        .bind(user.email, cutoff)
        .all<FileRow>();
    return rows.results.map((r) => fileOut(r, user.email));
}

/**
 * Bounded clean-up for the cron: files of assets deleted more than 30 days ago are removed from R2
 * and the asset rows are then removed for good. Restoring within 30 days keeps everything.
 */
export async function purgeDeletedAssets(db: D1Database, bucket: R2Bucket, limit = 50): Promise<{ files: number; assets: number }> {
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const files = await db
        .prepare(
            `SELECT f.id, f.r2_key, f.thumb_key FROM asset_files f JOIN assets a ON a.id = f.asset_id WHERE a.deleted_at IS NOT NULL AND a.deleted_at < ? AND f.status = 'stored' LIMIT ?`,
        )
        .bind(cutoff, limit)
        .all<{ id: string; r2_key: string; thumb_key: string | null }>();
    for (const f of files.results) {
        await bucket.delete([f.r2_key, ...(f.thumb_key ? [f.thumb_key] : [])]);
        await db.prepare("UPDATE asset_files SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?").bind(nowIso(), nowIso(), f.id).run();
    }
    let assets = 0;
    if (files.results.length < limit) {
        // Counted by id: D1's change count would also include the rows the delete cascades to.
        const gone = await db
            .prepare(
                `SELECT a.id FROM assets a WHERE a.deleted_at IS NOT NULL AND a.deleted_at < ?
                   AND NOT EXISTS (SELECT 1 FROM asset_files f WHERE f.asset_id = a.id AND f.status = 'stored') LIMIT ?`,
            )
            .bind(cutoff, limit)
            .all<{ id: string }>();
        for (const { id } of gone.results) await db.prepare("DELETE FROM assets WHERE id = ?").bind(id).run();
        assets = gone.results.length;
    }
    return { files: files.results.length, assets };
}
