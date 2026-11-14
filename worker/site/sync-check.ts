// Is the public site showing what Payload says is published? (docs/AUDIT-2026-11.md, H3.)
//
// Payload saves a document in its own database and then its hooks copy the published version to the site's
// database. The two writes can't share a transaction, so the copy can fail after the save. Publishing is
// refused before the save when it can't succeed and the copy is retried when it fails, but the only proof
// that the two agree is to compare them. This does that with a handful of small reads, straight from both
// databases: it never starts Payload, so it is cheap enough for the Worker's cron, and it changes nothing.
import type { D1Database } from "@cloudflare/workers-types";
import { SNAPSHOT } from "./content";

export type DriftKind = "post" | "page" | "project";
export interface DriftItem {
    kind: DriftKind;
    /** Payload's id, or null when the site has something Payload has no document for. */
    id: number | string | null;
    /** The site's own id for it: a post's public id; otherwise the Payload id. */
    siteId: string;
    title: string;
    slug: string;
    /**
     * `missing`: published in Payload, not on the site. `stale`: on the site, but not the version Payload last
     * saved (or at another address). `extra`: on the site, but not published in Payload.
     */
    state: "missing" | "stale" | "extra";
}
export interface DriftReport {
    checkedAt: string;
    items: DriftItem[];
    /** True when the project list (cards, index, sitemap) doesn't match the published projects. */
    projectListStale: boolean;
}

/** A save this recent may still be on its way to the site: it isn't drift yet. */
export const SYNC_GRACE_MS = 2 * 60 * 1000;

type PayloadRow = {
    id: number;
    slug: string | null;
    title: string | null;
    updated_at: string;
    deleted_at: string | null;
    _status: string | null;
    public_id?: string | null;
    listed?: number | null;
};

const time = (value: string | null | undefined) => (value ? Date.parse(value) : NaN);
const parse = (value: string | undefined): Record<string, unknown> | null => {
    try {
        const parsed: unknown = value ? JSON.parse(value) : null;
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
};

/**
 * Compares Payload's published documents with the public site. `payloadDb` is Payload's database, `siteDb`
 * the site's. Throws if either can't be read: "couldn't check" must never look like "in step".
 */
export async function siteDrift(payloadDb: D1Database, siteDb: D1Database, now = new Date()): Promise<DriftReport> {
    const [posts, pages, projects, sitePosts, meta] = await Promise.all([
        payloadDb.prepare("SELECT id, slug, title, public_id, updated_at, deleted_at, _status FROM posts").all<PayloadRow>(),
        payloadDb.prepare("SELECT id, slug, title, updated_at, deleted_at, _status FROM pages").all<PayloadRow>(),
        payloadDb.prepare("SELECT id, slug, title, listed, updated_at, deleted_at, _status FROM projects").all<PayloadRow>(),
        siteDb
            .prepare("SELECT id, slug, title, source_updated_at FROM posts WHERE source = 'payload'")
            .all<{ id: string; slug: string; title: string; source_updated_at: string | null }>(),
        // Snapshots are read without their bodies: only what the comparison needs.
        siteDb
            .prepare(
                `SELECT key, CASE
                     WHEN key = ?1 OR substr(key, 1, 8) = 'page-id:' OR substr(key, 1, 11) = 'project-id:' THEN value
                     WHEN json_valid(value) THEN json_object('id', json_extract(value, '$.id'), 'updatedAt', json_extract(value, '$.updatedAt'), 'title', json_extract(value, '$.title'))
                     ELSE NULL END AS value
                 FROM meta
                 WHERE substr(key, 1, 5) = 'page:' OR substr(key, 1, 8) = 'page-id:' OR substr(key, 1, 8) = 'project:' OR substr(key, 1, 11) = 'project-id:' OR key = ?1`,
            )
            .bind(SNAPSHOT.projects)
            .all<{ key: string; value: string | null }>(),
    ]);
    const items: DriftItem[] = [];
    const settled = (row: PayloadRow) => !(now.getTime() - time(row.updated_at) < SYNC_GRACE_MS);
    const live = (row: PayloadRow) => row._status === "published" && !row.deleted_at;

    // Posts: one row in the site's `posts` per published post, made from Payload's last save of it.
    const sitePostById = new Map(sitePosts.results.map((r) => [r.id, r]));
    const expectedPostIds = new Set<string>();
    for (const row of posts.results) {
        const siteId = row.public_id || `payload:${row.id}`;
        if (!live(row)) continue;
        expectedPostIds.add(siteId);
        const onSite = sitePostById.get(siteId);
        const base = { kind: "post" as const, id: row.id, siteId, title: row.title ?? "", slug: row.slug ?? "" };
        if (!onSite) {
            if (settled(row)) items.push({ ...base, state: "missing" });
        }
        // The row records which Payload save it was made from: anything but that exact save is stale, whether
        // the site is behind or an older write landed late.
        else if ((onSite.slug !== row.slug || time(onSite.source_updated_at) !== time(row.updated_at)) && settled(row)) items.push({ ...base, state: "stale" });
    }
    const unsettledPosts = new Set(posts.results.filter((r) => !settled(r)).map((r) => r.public_id || `payload:${r.id}`));
    for (const row of sitePosts.results)
        if (!expectedPostIds.has(row.id) && !unsettledPosts.has(row.id))
            items.push({
                kind: "post",
                id: posts.results.find((p) => (p.public_id || `payload:${p.id}`) === row.id)?.id ?? null,
                siteId: row.id,
                title: row.title,
                slug: row.slug,
                state: "extra",
            });

    // Pages and projects: a snapshot per published item, carrying the updatedAt of the Payload save it was made from.
    const metaBy = new Map<string, string | undefined>(meta.results.map((r) => [r.key, r.value ?? undefined]));
    const snapshots = (kind: "page" | "project", rows: PayloadRow[], published: (row: PayloadRow) => boolean) => {
        const expected = new Set<string>();
        for (const row of rows) {
            if (!published(row)) continue;
            expected.add(String(row.id));
            const base = { kind, id: row.id, siteId: String(row.id), title: row.title ?? "", slug: row.slug ?? "" };
            const slugRaw = metaBy.get(`${kind}-id:${row.id}`);
            let slug: unknown = null;
            try {
                slug = slugRaw ? JSON.parse(slugRaw) : null;
            } catch {
                slug = null;
            }
            const snapshot = typeof slug === "string" ? parse(metaBy.get(`${kind}:${slug}`)) : null;
            if (!snapshot || String(snapshot.id) !== String(row.id)) {
                if (settled(row)) items.push({ ...base, state: "missing" });
            } else if ((slug !== row.slug || time(snapshot.updatedAt as string) !== time(row.updated_at)) && settled(row))
                items.push({ ...base, state: "stale" });
        }
        const unsettled = new Set(rows.filter((r) => !settled(r)).map((r) => String(r.id)));
        for (const [key, value] of metaBy) {
            if (!key.startsWith(`${kind}:`)) continue;
            const snapshot = parse(value);
            const id = snapshot?.id === undefined ? null : String(snapshot.id);
            if (id !== null && (expected.has(id) || unsettled.has(id))) continue;
            // The built-in About page and anything else without a Payload id isn't Payload's to account for.
            if (id === null) continue;
            items.push({
                kind,
                id: rows.some((r) => String(r.id) === id) ? Number(id) : null,
                siteId: id,
                title: String(snapshot?.title ?? ""),
                slug: key.slice(kind.length + 1),
                state: "extra",
            });
        }
    };
    snapshots("page", pages.results, live);
    snapshots("project", projects.results, (row) => live(row) && row.listed !== 0);

    // The project list must name exactly the published project snapshots.
    const listed = (() => {
        try {
            const list: unknown = JSON.parse(metaBy.get(SNAPSHOT.projects) ?? "[]");
            return Array.isArray(list) ? list.map((p) => String((p as { slug?: unknown })?.slug)).sort() : [];
        } catch {
            return ["?"];
        }
    })();
    // A damaged snapshot (read as nothing above) is in neither: the list is built without it.
    const have = [...metaBy.entries()]
        .filter(([k, v]) => k.startsWith("project:") && v !== undefined)
        .map(([k]) => k)
        .map((k) => k.slice(8))
        .sort();
    const projectListStale = listed.length !== have.length || listed.some((slug, i) => slug !== have[i]);

    return { checkedAt: now.toISOString(), items, projectListStale };
}

export const inStep = (report: DriftReport) => report.items.length === 0 && !report.projectListStale;

export const DRIFT_KEY = "site:sync-check";
export const STATUS_KEY = "site:sync-status";

/** What the dashboard shows about the checks themselves (the live comparison is separate). */
export interface SyncStatus {
    /** When the automatic check last ran to the end, and how many things it found out of step. */
    lastSuccessAt: string | null;
    outstanding: number | null;
    /** When a check last couldn't run, and why. */
    lastFailureAt: string | null;
    lastFailureMessage: string | null;
    /** The last time someone pressed Republish, and what happened to each kind of item. */
    lastRepair: { at: string; by: string | null; fixed: number; failed: number; leftAlone: number; inStep: boolean } | null;
    /** The last save whose copy to the site failed after every retry (Payload had it; the site didn't). */
    lastPublishFailure: { at: string; what: string; message: string } | null;
}
const NO_STATUS: SyncStatus = {
    lastSuccessAt: null,
    outstanding: null,
    lastFailureAt: null,
    lastFailureMessage: null,
    lastRepair: null,
    lastPublishFailure: null,
};

export const discrepancies = (report: DriftReport) => report.items.length + (report.projectListStale ? 1 : 0);

export async function readSyncStatus(db: D1Database): Promise<SyncStatus> {
    try {
        const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(STATUS_KEY).first<{ value: string }>();
        return { ...NO_STATUS, ...(row ? (JSON.parse(row.value) as Partial<SyncStatus>) : {}) };
    } catch {
        return NO_STATUS;
    }
}

/** Merges fields into the status in one statement, so the cron and a person pressing Republish can't lose each other's part. */
export async function noteSyncStatus(db: D1Database, patch: Partial<SyncStatus>): Promise<void> {
    await db
        .prepare(
            "INSERT INTO meta (key, value) VALUES (?1, json(?2)) ON CONFLICT(key) DO UPDATE SET value = json_patch(CASE WHEN json_valid(meta.value) THEN meta.value ELSE '{}' END, json(?2))",
        )
        .bind(STATUS_KEY, JSON.stringify(patch))
        .run();
}

/**
 * Runs the check from the Worker's cron and keeps the result where the admin can read it. A site out of
 * step is logged as an error (it shows in the Worker's logs and alerts); a check that couldn't run is logged
 * and recorded as a failure, and leaves the last result alone.
 */
export async function recordSiteDrift(payloadDb: D1Database | undefined, siteDb: D1Database, now = new Date()): Promise<DriftReport | null> {
    if (!payloadDb) return null;
    try {
        const report = await siteDrift(payloadDb, siteDb, now);
        await siteDb
            .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(DRIFT_KEY, JSON.stringify(report))
            .run();
        await noteSyncStatus(siteDb, { lastSuccessAt: report.checkedAt, outstanding: discrepancies(report) });
        if (!inStep(report))
            console.error(
                JSON.stringify({
                    event: "site_out_of_sync",
                    items: report.items.map((i) => `${i.kind}:${i.siteId}:${i.state}`),
                    projectListStale: report.projectListStale,
                }),
            );
        return report;
    } catch (error) {
        const message = (error as Error).message;
        // Before Payload has created its tables (a fresh database) there is nothing to compare: not an error.
        if (/no such table/i.test(message)) console.log(JSON.stringify({ event: "site_sync_check_skipped", message }));
        else {
            console.error(JSON.stringify({ event: "site_sync_check_failed", message }));
            await noteSyncStatus(siteDb, { lastFailureAt: now.toISOString(), lastFailureMessage: message.slice(0, 300) }).catch(() => undefined);
        }
        return null;
    }
}
