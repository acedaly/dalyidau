// Draft preview (docs/AUDIT-2026-11.md, H5): what a draft will look like on the site, before it's published.
//
// Payload builds the draft exactly as publishing would (the publishers' `preview` mode: same validation, same
// escaping renderer, nothing public written) and leaves the result here, in the site's database, under a
// private key. The site Worker then renders it with the same page components the public site uses, at
// /portal/preview/draft/…, for signed-in owners and admins only (never cached, never indexed). Its images sit
// under a private prefix in the bucket (PREVIEW_MEDIA_PREFIX) that only the same people can load.
//
// A preview is a snapshot of the last saved draft. It isn't the public site: no public route reads these keys.
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { Project, PublicPage } from "../../src/shared/site-content";
import { PREVIEW_MEDIA_PREFIX, type PreparedPost } from "../blog/payload-publisher";

export type PreviewKind = "page" | "project" | "post";
export type DraftPreview =
    | { kind: "page"; createdAt: string; published: boolean; data: PublicPage }
    | { kind: "project"; createdAt: string; published: boolean; data: Project }
    | { kind: "post"; createdAt: string; published: boolean; data: { slug: string; record: PreparedPost["record"] } };

/** A preview is for looking at now: after a day it's gone, and pressing Preview again makes a fresh one. */
export const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
/** Preview images are kept a little longer than previews, then removed. */
export const PREVIEW_MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const PREVIEW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const key = (kind: PreviewKind, id: string | number) => `preview:${kind}:${id}`;
export const previewPath = (kind: PreviewKind, id: string | number) => `/portal/preview/draft/${kind}/${id}`;

export async function storeDraftPreview(db: D1Database, preview: DraftPreview, id: string | number): Promise<void> {
    if (!PREVIEW_ID.test(String(id))) throw new Error("That document can't be previewed.");
    await db
        .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key(preview.kind, id), JSON.stringify(preview))
        .run();
}

/** The stored preview, or null when there isn't one, it's damaged or it's more than a day old. */
export async function loadDraftPreview(db: D1Database, kind: PreviewKind, id: string, now = new Date()): Promise<DraftPreview | null> {
    if (!PREVIEW_ID.test(id)) return null;
    const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key(kind, id)).first<{ value: string }>();
    if (!row) return null;
    try {
        const preview = JSON.parse(row.value) as DraftPreview;
        if (preview.kind !== kind || !preview.data || !(now.getTime() - Date.parse(preview.createdAt) < PREVIEW_TTL_MS)) return null;
        return preview;
    } catch {
        return null;
    }
}

/** Removes previews older than a day and their images older than a week. Run by the cron; failures are only logged. */
export async function cleanPreviews(db: D1Database, bucket: R2Bucket, now = new Date()): Promise<{ previews: number; images: number }> {
    const { results } = await db.prepare("SELECT key, value FROM meta WHERE substr(key, 1, 8) = 'preview:'").all<{ key: string; value: string }>();
    const stale = results.filter((r) => {
        try {
            return !(now.getTime() - Date.parse((JSON.parse(r.value) as { createdAt?: string }).createdAt ?? "") < PREVIEW_TTL_MS);
        } catch {
            return true;
        }
    });
    for (const r of stale) await db.prepare("DELETE FROM meta WHERE key = ?").bind(r.key).run();
    let images = 0;
    let cursor: string | undefined;
    do {
        const page = await bucket.list({ prefix: PREVIEW_MEDIA_PREFIX, cursor, limit: 500 });
        const old = page.objects.filter((o) => now.getTime() - o.uploaded.getTime() > PREVIEW_MEDIA_TTL_MS).map((o) => o.key);
        if (old.length) await bucket.delete(old);
        images += old.length;
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return { previews: stale.length, images };
}
