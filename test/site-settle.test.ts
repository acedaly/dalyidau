// The two loops every copy from Payload to the site goes through (worker/site/settle.ts): overlapping syncs
// settle on the latest version, a failed read is never taken for "gone", and a retry after a lost answer is safe.
import { beforeEach, describe, expect, it } from "vitest";
import { publishPage, unpublishPage } from "../worker/site/publisher";
import { GaveUp, Unsettled, retried, settle } from "../worker/site/settle";
import { resetDb, testEnv } from "./helpers";

type Doc = { v: number; published: boolean } | null;
const same = (a: Doc, b: Doc) => (a === null) === (b === null) && a?.v === b?.v && a?.published === b?.published;
const noWait = async () => undefined;

describe("settle", () => {
    it("writes once when nothing changes meanwhile", async () => {
        const written: Doc[] = [];
        await settle<Doc>(
            async () => ({ v: 1, published: true }),
            async (doc) => void written.push(doc),
            same,
        );
        expect(written).toEqual([{ v: 1, published: true }]);
    });

    it("two overlapping syncs end on the latest version, whichever writes last", async () => {
        // The document as Payload has it, and the site as the syncs leave it.
        let doc: Doc = { v: 1, published: true };
        let site: Doc = null;
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        // The slow sync reads version 1, then is held up before it writes.
        const slow = settle<Doc>(
            async () => doc,
            async (read) => {
                if (read?.v === 1) await held;
                site = read;
            },
            same,
        );
        await Promise.resolve();
        // Meanwhile the document is saved again and a second sync writes version 2…
        doc = { v: 2, published: true };
        await settle<Doc>(
            async () => doc,
            async (read) => void (site = read),
            same,
        );
        expect(site).toEqual({ v: 2, published: true });
        // …and then the slow one writes its stale version 1 over it. It reads again, sees the change, and puts it right.
        release();
        await slow;
        expect(site).toEqual({ v: 2, published: true });
    });

    it("a sync that wrote a publish over a later unpublish takes it down again", async () => {
        let doc: Doc = { v: 1, published: true };
        let site: Doc = null;
        let first = true;
        await settle<Doc>(
            async () => doc,
            async (read) => {
                site = read?.published ? read : null;
                // Unpublished while this sync was writing.
                if (first) doc = { v: 2, published: false };
                first = false;
            },
            same,
        );
        expect(site).toBeNull();
    });

    it("says so when the document never holds still, instead of returning quietly", async () => {
        let v = 0;
        let writes = 0;
        await expect(
            settle<Doc>(
                async () => ({ v: v++, published: true }),
                async () => void writes++,
                same,
            ),
        ).rejects.toBeInstanceOf(Unsettled);
        expect(writes).toBe(4);
    });

    it("a read that fails is thrown, never read as 'the document is gone'", async () => {
        const applied: Doc[] = [];
        await expect(
            settle<Doc>(
                () => Promise.reject(new Error("D1 is down")),
                async (doc) => void applied.push(doc),
                same,
            ),
        ).rejects.toThrow("D1 is down");
        expect(applied).toEqual([]);
    });
});

describe("retried", () => {
    it("tries three times, then gives up with the last failure", async () => {
        let calls = 0;
        let retries = 0;
        const error = await retried(
            async () => {
                calls++;
                throw new Error(`failure ${calls}`);
            },
            { wait: noWait, onRetry: () => retries++ },
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GaveUp);
        expect(((error as GaveUp).last as Error).message).toBe("failure 3");
        expect([calls, retries]).toEqual([3, 3]);
    });

    it("returns as soon as an attempt works", async () => {
        let calls = 0;
        expect(
            await retried(
                async () => {
                    if (++calls < 3) throw new Error("not yet");
                    return "done";
                },
                { wait: noWait },
            ),
        ).toBe("done");
        expect(calls).toBe(3);
    });

    it("doesn't retry a refusal: it is the caller's to see, as it is", async () => {
        class Refusal extends Error {}
        let calls = 0;
        await expect(
            retried(
                async () => {
                    calls++;
                    throw new Refusal("no");
                },
                { wait: noWait, isFinal: (e) => e instanceof Refusal },
            ),
        ).rejects.toBeInstanceOf(Refusal);
        expect(calls).toBe(1);
    });
});

describe("a retry after a write whose answer was lost", () => {
    beforeEach(async () => {
        await resetDb();
        await testEnv.DB.prepare("DELETE FROM meta").run();
    });
    const media = { loadMedia: async () => null };
    const meta = async () => (await testEnv.DB.prepare("SELECT key, value FROM meta WHERE key != 'content_version' ORDER BY key").all()).results;

    it("publishing again leaves exactly what the first write left", async () => {
        const input = { id: 3, slug: "now", title: "Now", updatedAt: "2026-11-01T00:00:00.000Z" };
        let lost = true;
        const page = await retried(
            async () => {
                const result = await publishPage(testEnv, input, media);
                // The write happened; its answer didn't arrive.
                if (lost) {
                    lost = false;
                    throw new Error("Network connection lost.");
                }
                return result;
            },
            { wait: noWait },
        );
        expect(page.slug).toBe("now");
        const once = await meta();
        await publishPage(testEnv, input, media);
        expect(await meta()).toEqual(once);
    });

    it("an unpublish whose answer was lost reports 'nothing to remove' on the retry, so the caller is told to assume it changed", async () => {
        await publishPage(testEnv, { id: 3, slug: "now", title: "Now" }, media);
        let lost = true;
        let assumeChanged = false;
        const removed = await retried(
            async () => {
                const result = await unpublishPage(testEnv, 3);
                if (lost) {
                    lost = false;
                    throw new Error("Network connection lost.");
                }
                return result;
            },
            { wait: noWait, onRetry: () => (assumeChanged = true) },
        );
        // The retry found nothing left to remove; only onRetry tells the caller the menu still needs rebuilding.
        expect([removed, assumeChanged]).toEqual([false, true]);
        const once = await meta();
        await unpublishPage(testEnv, 3);
        expect(await meta()).toEqual(once);
    });
});
