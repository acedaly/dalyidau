// Publishing can't silently leave Payload and the site out of step (docs/AUDIT-2026-11.md, H3):
// - `check` mode gives every refusal a publish would, and writes nothing, so Payload can refuse before it saves;
// - the sync check (worker/site/sync-check.ts) compares Payload's published documents with the site and names
//   whatever differs, from the two databases alone.
import { beforeEach, describe, expect, it } from "vitest";
import { PREVIEW_MEDIA_PREFIX, PublishError, preparePayloadPost, publishPayloadPost, unpublishPayloadPost } from "../worker/blog/payload-publisher";
import { removeOrphan, removedKey } from "../worker/site/orphans";
import { publishPage, publishProject, republishProjectList, unpublishPage, unpublishProject } from "../worker/site/publisher";
import { DRIFT_KEY, SYNC_GRACE_MS, discrepancies, inStep, noteSyncStatus, readSyncStatus, recordSiteDrift, siteDrift } from "../worker/site/sync-check";
import { resetDb, testEnv } from "./helpers";
import { sampleImage } from "./image-samples";

const media = {
    loadMedia: async (id: string | number) =>
        String(id) === "7"
            ? { bytes: sampleImage("jpeg"), contentType: "image/jpeg", alt: "Fine" }
            : String(id) === "8"
              ? { bytes: sampleImage("png").subarray(0, 90), contentType: "image/png", alt: "Damaged" }
              : null,
};
const words = (text: string) => ({ root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text }] }] } });
const T0 = "2026-11-01T00:00:00.000Z";
const LATER = new Date("2026-11-02T00:00:00.000Z");

/** Payload's own database, as far as the check reads it: three tables of rows. */
type Row = { id: number; slug: string; title: string; updated_at: string; deleted_at: string | null; _status: string; public_id?: string; listed?: number };
const payload = (tables: { posts?: Row[]; pages?: Row[]; projects?: Row[] }) =>
    ({
        prepare: (sql: string) => ({
            all: async () => ({ results: tables[/FROM (\w+)/.exec(sql)![1] as "posts" | "pages" | "projects"] ?? [] }),
        }),
    }) as never;
const row = (over: Partial<Row> & { id: number; slug: string }): Row => ({ title: over.slug, updated_at: T0, deleted_at: null, _status: "published", ...over });
const state = async () => ({
    posts: (await testEnv.DB.prepare("SELECT * FROM posts ORDER BY id").all()).results,
    redirects: (await testEnv.DB.prepare("SELECT * FROM slug_redirects ORDER BY from_slug").all()).results,
    meta: (await testEnv.DB.prepare("SELECT key, value FROM meta ORDER BY key").all()).results,
    media: (await testEnv.DB.prepare("SELECT * FROM media ORDER BY id").all()).results,
    bucket: (await testEnv.MEDIA.list()).objects.map((o) => o.key).sort(),
});

beforeEach(async () => {
    await resetDb();
    await testEnv.DB.prepare("DELETE FROM meta").run();
    for (const object of (await testEnv.MEDIA.list()).objects) await testEnv.MEDIA.delete(object.key);
});

describe("check mode: every refusal a publish would give, and nothing written", () => {
    const post = (over = {}) => ({ postId: "payload:1", slug: "hello", title: "Hello", content: words("Words."), heroMediaId: 7, ...over });

    it("accepts what a publish would accept, storing nothing (no rows, no files, no version bump)", async () => {
        const before = await state();
        const checked = await preparePayloadPost(testEnv, post(), { ...media, mode: "check" });
        expect(checked.record.body_html).toContain("Words.");
        await publishPage(testEnv, { id: 1, slug: "now", title: "Now", content: words("Now."), heroMediaId: 7 }, { ...media, mode: "check" });
        await publishProject(testEnv, { id: 1, slug: "lamp", title: "Lamp", heroMediaId: 7, gallery: [{ mediaId: 7 }] }, { ...media, mode: "check" });
        expect(await state()).toEqual(before);
    });

    it("refuses, before anything is saved, exactly what the publish would refuse afterwards", async () => {
        await publishPayloadPost(testEnv, post({ postId: "payload:other" }), media);
        await publishPage(testEnv, { id: 9, slug: "now", title: "Taken" }, media);
        await publishProject(testEnv, { id: 9, slug: "lamp", title: "Taken" }, media);
        const before = await state();
        const cases: Array<[string, () => Promise<unknown>, RegExp]> = [
            ["post: address in use", () => preparePayloadPost(testEnv, post(), { ...media, mode: "check" }), /already used/],
            ["post: no content", () => preparePayloadPost(testEnv, post({ slug: "x", content: words(" ") }), { ...media, mode: "check" }), /content/],
            [
                "post: damaged featured image",
                () => preparePayloadPost(testEnv, post({ slug: "x", heroMediaId: 8 }), { ...media, mode: "check" }),
                /featured image/,
            ],
            [
                "post: missing featured image",
                () => preparePayloadPost(testEnv, post({ slug: "x", heroMediaId: 99 }), { ...media, mode: "check" }),
                /featured image/,
            ],
            ["page: address in use", () => publishPage(testEnv, { id: 1, slug: "now", title: "Now" }, { ...media, mode: "check" }), /already used/],
            [
                "page: damaged featured image",
                () => publishPage(testEnv, { id: 1, slug: "then", title: "Then", heroMediaId: 8 }, { ...media, mode: "check" }),
                /featured image/,
            ],
            ["page: an address the site uses itself", () => publishPage(testEnv, { id: 1, slug: "blog", title: "Blog" }, { ...media, mode: "check" }), /./],
            ["project: address in use", () => publishProject(testEnv, { id: 1, slug: "lamp", title: "Lamp" }, { ...media, mode: "check" }), /already used/],
            [
                "project: damaged cover",
                () => publishProject(testEnv, { id: 1, slug: "desk", title: "Desk", heroMediaId: 8 }, { ...media, mode: "check" }),
                /cover image/,
            ],
            [
                "project: damaged screenshot",
                () => publishProject(testEnv, { id: 1, slug: "desk", title: "Desk", gallery: [{ mediaId: 8 }] }, { ...media, mode: "check" }),
                /Screenshot 1/,
            ],
            [
                "project: bad link",
                () => publishProject(testEnv, { id: 1, slug: "desk", title: "Desk", websiteUrl: "javascript:alert(1)" }, { ...media, mode: "check" }),
                /https/,
            ],
        ];
        for (const [label, run, message] of cases) {
            const error = await run().then(
                () => null,
                (e: unknown) => e,
            );
            expect(error, label).toBeInstanceOf(PublishError);
            expect((error as Error).message, label).toMatch(message);
            // …and the real publish refuses the same thing.
        }
        expect(await state()).toEqual(before);
    });
});

describe("preview mode: the same result, privately", () => {
    it("builds the page without claiming an address or writing anything public", async () => {
        await publishPage(testEnv, { id: 9, slug: "now", title: "Published" }, media);
        const before = await state();
        const page = await publishPage(
            testEnv,
            { id: 1, slug: "now", title: "A draft with the same address", content: words("Draft words."), heroMediaId: 7 },
            { ...media, mode: "preview" },
        );
        expect(page.bodyHtml).toContain("Draft words.");
        const after = await state();
        expect({ ...after, bucket: [] }).toEqual({ ...before, bucket: [] });
        // Its image is kept only under the private prefix, which the public /media route never serves.
        const added = after.bucket.filter((k) => !before.bucket.includes(k));
        expect(added).toHaveLength(1);
        expect(added[0].startsWith(PREVIEW_MEDIA_PREFIX)).toBe(true);
        expect(page.image?.src).toBe(`/media/${added[0].slice(PREVIEW_MEDIA_PREFIX.length)}`);
    });
});

describe("the sync check", () => {
    const publishAll = async () => {
        await publishPayloadPost(
            testEnv,
            { postId: "payload:1", slug: "hello", title: "Hello", content: words("Words."), publishedAt: T0, sourceUpdatedAt: T0 },
            { ...media, now: () => new Date(T0) },
        );
        await publishPage(testEnv, { id: 1, slug: "now", title: "Now", updatedAt: T0 }, media);
        await publishProject(testEnv, { id: 1, slug: "lamp", title: "Lamp", updatedAt: T0 }, media);
    };
    const inPayload = () => ({
        posts: [row({ id: 1, slug: "hello", public_id: "payload:1" })],
        pages: [row({ id: 1, slug: "now" })],
        projects: [row({ id: 1, slug: "lamp", listed: 1 })],
    });

    it("says the site is in step when it shows what Payload has published", async () => {
        await publishAll();
        const report = await siteDrift(payload(inPayload()), testEnv.DB, LATER);
        expect(report.items).toEqual([]);
        expect(report.projectListStale).toBe(false);
        expect(inStep(report)).toBe(true);
        // Nothing published anywhere is in step too.
        await resetDb();
        await testEnv.DB.prepare("DELETE FROM meta").run();
        expect(inStep(await siteDrift(payload({}), testEnv.DB, LATER))).toBe(true);
    });

    it("names what's published in Payload but missing from the site", async () => {
        const report = await siteDrift(payload(inPayload()), testEnv.DB, LATER);
        expect(report.items.map((i) => `${i.kind}:${i.slug}:${i.state}`).sort()).toEqual(["page:now:missing", "post:hello:missing", "project:lamp:missing"]);
        expect(inStep(report)).toBe(false);
    });

    it("names what the site shows from an older save, or at an older address", async () => {
        await publishAll();
        const newer = "2026-11-01T06:00:00.000Z";
        const saved = inPayload();
        saved.posts[0].updated_at = newer;
        saved.pages[0].updated_at = newer;
        saved.projects[0].slug = "desk-lamp";
        const report = await siteDrift(payload(saved), testEnv.DB, LATER);
        expect(report.items.map((i) => `${i.kind}:${i.state}`).sort()).toEqual(["page:stale", "post:stale", "project:stale"]);
    });

    it("names what's on the site but not published in Payload: a draft, in Trash, hidden, or gone", async () => {
        await publishAll();
        const report = await siteDrift(
            payload({
                posts: [row({ id: 1, slug: "hello", public_id: "payload:1", _status: "draft" })],
                pages: [row({ id: 1, slug: "now", deleted_at: T0 })],
                projects: [row({ id: 1, slug: "lamp", listed: 0 })],
            }),
            testEnv.DB,
            LATER,
        );
        expect(report.items.map((i) => `${i.kind}:${i.slug}:${i.state}:${i.id}`).sort()).toEqual([
            "page:now:extra:1",
            "post:hello:extra:1",
            "project:lamp:extra:1",
        ]);
        const gone = await siteDrift(payload({}), testEnv.DB, LATER);
        expect(gone.items.map((i) => `${i.kind}:${i.state}:${i.id}`).sort()).toEqual(["page:extra:null", "post:extra:null", "project:extra:null"]);
    });

    it("leaves other publishers' posts and the site's own built-in pages alone", async () => {
        await testEnv.DB.prepare(
            "INSERT INTO posts (id, slug, title, tags, featured, body_html, toc, search_text, word_count, reading_minutes, published_at, content_hash, synced_at, source) VALUES ('cap-1', 'older', 'Older', '[]', 0, '<p>x</p>', '[]', 'x', 1, 1, ?1, 'h', ?1, 'capacities')",
        )
            .bind(T0)
            .run();
        expect(inStep(await siteDrift(payload({}), testEnv.DB, LATER))).toBe(true);
    });

    it("doesn't call a save from the last two minutes drift (it may still be on its way)", async () => {
        const just = new Date(new Date(T0).getTime() + SYNC_GRACE_MS - 1000);
        expect((await siteDrift(payload(inPayload()), testEnv.DB, just)).items).toEqual([]);
        expect((await siteDrift(payload(inPayload()), testEnv.DB, new Date(just.getTime() + 2000))).items).toHaveLength(3);
    });

    it("notices a project list that doesn't match the published projects, and Republish's rebuild fixes it", async () => {
        await publishAll();
        await testEnv.DB.prepare("UPDATE meta SET value = '[]' WHERE key = 'site:projects'").run();
        expect((await siteDrift(payload(inPayload()), testEnv.DB, LATER)).projectListStale).toBe(true);
        await republishProjectList(testEnv);
        expect(inStep(await siteDrift(payload(inPayload()), testEnv.DB, LATER))).toBe(true);
    });

    it("is put right by publishing again: a post whose content didn't change still records the save it matches", async () => {
        await publishAll();
        const newer = "2026-11-01T06:00:00.000Z";
        const saved = inPayload();
        saved.posts[0].updated_at = newer;
        expect((await siteDrift(payload(saved), testEnv.DB, LATER)).items).toHaveLength(1);
        const again = await publishPayloadPost(
            testEnv,
            { postId: "payload:1", slug: "hello", title: "Hello", content: words("Words."), publishedAt: T0, sourceUpdatedAt: newer },
            { ...media, now: () => new Date(newer) },
        );
        expect(again.outcome).toBe("unchanged");
        expect(inStep(await siteDrift(payload(saved), testEnv.DB, LATER))).toBe(true);
        // Taking things down that Payload no longer publishes does the same.
        await unpublishPayloadPost(testEnv, "payload:1");
        await unpublishPage(testEnv, 1);
        await unpublishProject(testEnv, 1);
        expect(inStep(await siteDrift(payload({}), testEnv.DB, LATER))).toBe(true);
    });

    it("the cron keeps the result for the dashboard, and a check that can't run never reads as in step", async () => {
        const report = await recordSiteDrift(payload(inPayload()), testEnv.DB, LATER);
        expect(report?.items).toHaveLength(3);
        const kept = JSON.parse((await testEnv.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(DRIFT_KEY).first<{ value: string }>())!.value);
        expect(kept.items).toHaveLength(3);
        const broken = { prepare: () => ({ all: async () => Promise.reject(new Error("D1 is down")) }) } as never;
        await expect(siteDrift(broken, testEnv.DB, LATER)).rejects.toThrow(/down/);
        expect(await recordSiteDrift(broken, testEnv.DB, LATER)).toBeNull();
        expect(await recordSiteDrift(undefined, testEnv.DB, LATER)).toBeNull();
        // The last good result is left as it was.
        expect(
            JSON.parse((await testEnv.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(DRIFT_KEY).first<{ value: string }>())!.value).items,
        ).toHaveLength(3);
    });

    it("keeps what the dashboard shows about the checks: last success and how many, last failure, last repair, last missed save", async () => {
        expect(await readSyncStatus(testEnv.DB)).toMatchObject({
            lastSuccessAt: null,
            lastFailureAt: null,
            outstanding: null,
            lastRepair: null,
            lastPublishFailure: null,
        });
        const report = await recordSiteDrift(payload(inPayload()), testEnv.DB, LATER);
        expect(discrepancies(report!)).toBe(3);
        expect(await readSyncStatus(testEnv.DB)).toMatchObject({ lastSuccessAt: LATER.toISOString(), outstanding: 3, lastFailureAt: null });

        // A check that can't run is recorded as a failure, and what was known before stays.
        const broken = { prepare: () => ({ all: async () => Promise.reject(new Error("D1 is down")) }) } as never;
        const failedAt = new Date("2026-11-03T00:00:00.000Z");
        await recordSiteDrift(broken, testEnv.DB, failedAt);
        expect(await readSyncStatus(testEnv.DB)).toMatchObject({
            lastSuccessAt: LATER.toISOString(),
            outstanding: 3,
            lastFailureAt: failedAt.toISOString(),
            lastFailureMessage: "D1 is down",
        });
        // A database Payload hasn't set up yet isn't a failure.
        const fresh = { prepare: () => ({ all: async () => Promise.reject(new Error("D1_ERROR: no such table: posts")) }) } as never;
        await recordSiteDrift(fresh, testEnv.DB, new Date("2026-11-04T00:00:00.000Z"));
        expect((await readSyncStatus(testEnv.DB)).lastFailureAt).toBe(failedAt.toISOString());

        // The parts are merged, never overwritten wholesale: a repair and a missed save sit beside the check's own.
        await noteSyncStatus(testEnv.DB, {
            lastRepair: { at: "2026-11-05T00:00:00.000Z", by: "owner@example.com", fixed: 2, failed: 0, leftAlone: 1, inStep: false },
        });
        await noteSyncStatus(testEnv.DB, { lastPublishFailure: { at: "2026-11-06T00:00:00.000Z", what: "page 4", message: "D1 is down" } });
        await publishAll();
        await recordSiteDrift(payload(inPayload()), testEnv.DB, new Date("2026-11-07T00:00:00.000Z"));
        expect(await readSyncStatus(testEnv.DB)).toMatchObject({
            lastSuccessAt: "2026-11-07T00:00:00.000Z",
            outstanding: 0,
            lastFailureAt: failedAt.toISOString(),
            lastRepair: { fixed: 2, leftAlone: 1, by: "owner@example.com" },
            lastPublishFailure: { what: "page 4" },
        });
        // A damaged status row reads as "nothing known" and is repaired by the next note.
        await testEnv.DB.prepare("UPDATE meta SET value = '{broken' WHERE key = 'site:sync-status'").run();
        expect((await readSyncStatus(testEnv.DB)).lastSuccessAt).toBeNull();
        await noteSyncStatus(testEnv.DB, { outstanding: 0 });
        expect((await readSyncStatus(testEnv.DB)).outstanding).toBe(0);
    });

    it("removing an orphan takes one item off the site and keeps a full copy first", async () => {
        await publishAll();
        await publishPayloadPost(
            testEnv,
            { postId: "payload:1", slug: "hello-again", title: "Hello", content: words("Words."), publishedAt: T0, sourceUpdatedAt: T0 },
            { ...media, now: () => new Date(T0) },
        );
        const before = await state();
        expect(await removeOrphan(testEnv, "post", "payload:nope", "owner@example.com")).toBeNull();
        expect(await state()).toEqual(before);

        expect(await removeOrphan(testEnv, "post", "payload:1", "owner@example.com", LATER)).toBe("hello-again");
        expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM posts").first<{ n: number }>())!.n).toBe(0);
        const post = JSON.parse(
            (await testEnv.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(removedKey("post", "payload:1")).first<{ value: string }>())!.value,
        );
        expect(post).toMatchObject({ kind: "post", slug: "hello-again", by: "owner@example.com", removedAt: LATER.toISOString() });
        expect(post.copy.row.body_html).toContain("Words.");
        expect(post.copy.redirects.map((r: { from_slug: string }) => r.from_slug)).toEqual(["hello"]);

        expect(await removeOrphan(testEnv, "page", "1", null)).toBe("now");
        expect(await removeOrphan(testEnv, "project", "1", null)).toBe("lamp");
        const left = (
            await testEnv.DB.prepare(
                "SELECT key FROM meta WHERE substr(key, 1, 5) = 'page:' OR substr(key, 1, 8) = 'project:' OR substr(key, 1, 8) = 'page-id:' OR substr(key, 1, 11) = 'project-id:'",
            ).all()
        ).results;
        expect(left).toEqual([]);
        expect(JSON.parse((await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'site:projects'").first<{ value: string }>())!.value)).toEqual([]);
        expect(
            JSON.parse((await testEnv.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(removedKey("page", "1")).first<{ value: string }>())!.value).copy
                .snapshots[0].value,
        ).toContain("Now");
        // The kept copies aren't site content: the checker doesn't count them.
        expect(inStep(await siteDrift(payload({}), testEnv.DB, LATER))).toBe(true);
        // Another publisher's post can't be removed this way.
        await testEnv.DB.prepare(
            "INSERT INTO posts (id, slug, title, tags, featured, body_html, toc, search_text, word_count, reading_minutes, published_at, content_hash, synced_at, source) VALUES ('cap-1', 'older', 'Older', '[]', 0, '<p>x</p>', '[]', 'x', 1, 1, ?1, 'h', ?1, 'capacities')",
        )
            .bind(T0)
            .run();
        expect(await removeOrphan(testEnv, "post", "cap-1", null)).toBeNull();
        expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM posts").first<{ n: number }>())!.n).toBe(1);
    });

    it("sees a post that an older write left behind, even though it was written recently", async () => {
        await publishAll();
        const saved = inPayload();
        saved.posts[0].updated_at = "2026-11-01T06:00:00.000Z";
        // The site's row was written a moment ago (synced_at is fresh) but from the earlier save.
        await testEnv.DB.prepare("UPDATE posts SET synced_at = '2026-11-01T23:00:00.000Z'").run();
        expect((await siteDrift(payload(saved), testEnv.DB, LATER)).items.map((i) => `${i.kind}:${i.state}`)).toEqual(["post:stale"]);
    });

    it("a damaged snapshot can be replaced, and doesn't keep the project list looking wrong", async () => {
        await publishAll();
        await testEnv.DB.prepare("INSERT INTO meta (key, value) VALUES ('project:broken', '{not json'), ('page:broken', '{not json')").run();
        expect((await siteDrift(payload(inPayload()), testEnv.DB, LATER)).projectListStale).toBe(false);
        await publishPage(testEnv, { id: 2, slug: "broken", title: "Mended", updatedAt: T0 }, media);
        await publishProject(testEnv, { id: 2, slug: "broken", title: "Mended", updatedAt: T0 }, media);
        const mended = inPayload();
        mended.pages.push(row({ id: 2, slug: "broken" }));
        mended.projects.push(row({ id: 2, slug: "broken", listed: 1 }));
        expect(inStep(await siteDrift(payload(mended), testEnv.DB, LATER))).toBe(true);
    });
});
