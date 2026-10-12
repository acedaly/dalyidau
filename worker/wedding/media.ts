// Photos for the wedding website (hero image and gallery), stored in R2 under "wedding/".
// Uploads are checked by their actual bytes, not their claimed type: only JPEG, PNG and WebP are
// accepted (no SVG, which can carry script). Served from /wedding/media/<file>.
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { z } from "zod";
import type { WebsiteMedia } from "../../src/shared/portal/types";
import { imageDimensions } from "../lib/image";
import { auditStatement, newId, nowIso } from "../portal/db";
import { NotFoundError, ValidationError } from "../portal/entities";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const sniff = (bytes: Uint8Array): { type: string; ext: string } | null => {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { type: "image/png", ext: "png" };
    const text = (a: number, b: number) => String.fromCharCode(...bytes.slice(a, b));
    if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return { type: "image/webp", ext: "webp" };
    return null;
};

const toMedia = (r: Record<string, unknown>): WebsiteMedia => ({
    id: r.id as string,
    url: `/wedding/media/${String(r.r2_key).replace(/^wedding\//, "")}`,
    contentType: r.content_type as string,
    bytes: Number(r.bytes),
    width: (r.width as number | null) ?? null,
    height: (r.height as number | null) ?? null,
    alt: (r.alt as string) ?? "",
    caption: (r.caption as string | null) ?? null,
    inGallery: r.in_gallery === 1,
    sortOrder: Number(r.sort_order ?? 0),
});

export async function listMedia(db: D1Database): Promise<WebsiteMedia[]> {
    const rows = await db.prepare("SELECT * FROM website_media ORDER BY sort_order, created_at").all<Record<string, unknown>>();
    return rows.results.map(toMedia);
}

const uploadSchema = z.object({
    /** Base64 file contents (the portal reads the file in the browser). */
    data: z.string().max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 16),
    alt: z.string().trim().max(200).default(""),
});

export async function uploadMedia(db: D1Database, bucket: R2Bucket, input: unknown, actor: string): Promise<WebsiteMedia> {
    const { data, alt } = uploadSchema.parse(input);
    let bytes: Uint8Array;
    try {
        bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    } catch {
        throw new ValidationError("That file couldn't be read", "data");
    }
    if (bytes.length > MAX_UPLOAD_BYTES) throw new ValidationError("Photos can be up to 5 MB", "data");
    const kind = sniff(bytes);
    if (!kind) throw new ValidationError("Use a JPEG, PNG or WebP photo", "data");
    const size = imageDimensions(bytes, kind.type);
    const hex = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const key = `wedding/${hex}.${kind.ext}`;
    await bucket.put(key, bytes, { httpMetadata: { contentType: kind.type, cacheControl: "public, max-age=31536000, immutable" } });

    const id = newId("med");
    const now = nowIso();
    const order = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM website_media").first<{ n: number }>();
    await db.batch([
        db
            .prepare(
                "INSERT INTO website_media (id, r2_key, content_type, bytes, width, height, alt, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(id, key, kind.type, bytes.length, size?.width ?? null, size?.height ?? null, alt, order?.n ?? 10, now, now),
        auditStatement(db, { actor, action: "website.media.upload", entityType: "website_media", entityId: id, summary: "Uploaded a photo for the website" }),
    ]);
    return toMedia((await db.prepare("SELECT * FROM website_media WHERE id = ?").bind(id).first<Record<string, unknown>>())!);
}

const updateSchema = z.object({
    alt: z.string().trim().max(200).optional(),
    caption: z
        .string()
        .trim()
        .max(300)
        .transform((v) => v || null)
        .nullable()
        .optional(),
    inGallery: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
});

export async function updateMedia(db: D1Database, id: string, input: unknown, actor: string): Promise<WebsiteMedia> {
    const patch = updateSchema.parse(input);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.alt !== undefined) (sets.push("alt = ?"), values.push(patch.alt));
    if (patch.caption !== undefined) (sets.push("caption = ?"), values.push(patch.caption));
    if (patch.inGallery !== undefined) (sets.push("in_gallery = ?"), values.push(patch.inGallery ? 1 : 0));
    if (patch.sortOrder !== undefined) (sets.push("sort_order = ?"), values.push(patch.sortOrder));
    if (!sets.length) throw new ValidationError("Nothing to change", "id");
    const result = await db
        .prepare(`UPDATE website_media SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...values, nowIso(), id)
        .run();
    if (!result.meta.changes) throw new NotFoundError("Photo not found");
    await auditStatement(db, { actor, action: "website.media.update", entityType: "website_media", entityId: id, summary: "Updated a website photo" }).run();
    return toMedia((await db.prepare("SELECT * FROM website_media WHERE id = ?").bind(id).first<Record<string, unknown>>())!);
}

export async function deleteMedia(db: D1Database, bucket: R2Bucket, id: string, actor: string) {
    const row = await db.prepare("SELECT r2_key FROM website_media WHERE id = ?").bind(id).first<{ r2_key: string }>();
    if (!row) throw new NotFoundError("Photo not found");
    await db.batch([
        db.prepare("DELETE FROM website_media WHERE id = ?").bind(id),
        auditStatement(db, { actor, action: "website.media.delete", entityType: "website_media", entityId: id, summary: "Deleted a website photo" }),
    ]);
    await bucket.delete(row.r2_key);
}

/** Streams a photo. The caller decides whether the request may see it (published site or signed-in preview). */
export async function serveMedia(bucket: R2Bucket, file: string): Promise<Response> {
    if (!/^[a-f0-9]{24}\.(jpg|png|webp)$/.test(file)) return new Response("Not found", { status: 404 });
    const object = await bucket.get(`wedding/${file}`);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body as unknown as ReadableStream, {
        headers: {
            "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
            ETag: object.httpEtag,
            "Content-Disposition": "inline",
        },
    });
}
