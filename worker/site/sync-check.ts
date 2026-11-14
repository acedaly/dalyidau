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
            .prepare("SELECT id, slug, title, synced_at FROM posts WHERE source = 'payload'")
            .all<{ id: string; slug: string; title: string; synced_at: string | null }>(),
        siteDb
            .prepare(
                "SELECT key, value FROM meta WHERE substr(key, 1, 5) = 'page:' OR substr(key, 1, 8) = 'page-id:' OR substr(key, 1, 8) = 'project:' OR substr(key, 1, 11) = 'project-id:' OR key = ?",
            )
            .bind(SNAPSHOT.projects)
            .all<{ key: string; value: string }>(),
    ]);
    const items: DriftItem[] = [];
    const settled = (row: PayloadRow) => !(now.getTime() - time(row.updated_at) < SYNC_GRACE_MS);
    const live = (row: PayloadRow) => row._status === "published" && !row.deleted_at;

    // Posts: one row in the site's `posts` per published post, written at or after Payload's last save of it.
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
        } else if ((onSite.slug !== row.slug || !(time(onSite.synced_at) >= time(row.updated_at))) && settled(row)) items.push({ ...base, state: "stale" });
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
    const metaBy = new Map(meta.results.map((r) => [r.key, r.value]));
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
    const have = [...metaBy.keys()]
        .filter((k) => k.startsWith("project:"))
        .map((k) => k.slice(8))
        .sort();
    const projectListStale = listed.length !== have.length || listed.some((slug, i) => slug !== have[i]);

    return { checkedAt: now.toISOString(), items, projectListStale };
}

export const inStep = (report: DriftReport) => report.items.length === 0 && !report.projectListStale;

export const DRIFT_KEY = "site:sync-check";

/**
 * Runs the check from the Worker's cron and keeps the result where the admin can read it. A site out of
 * step is logged as an error (it shows in the Worker's logs and alerts); a check that couldn't run is logged
 * too and leaves the last result alone.
 */
export async function recordSiteDrift(payloadDb: D1Database | undefined, siteDb: D1Database, now = new Date()): Promise<DriftReport | null> {
    if (!payloadDb) return null;
    try {
        const report = await siteDrift(payloadDb, siteDb, now);
        await siteDb
            .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(DRIFT_KEY, JSON.stringify(report))
            .run();
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
        console.error(JSON.stringify({ event: "site_sync_check_failed", message: (error as Error).message }));
        return null;
    }
}
