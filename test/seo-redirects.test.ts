// Phase 2b (docs/AUDIT-2026-11.md): search and sharing settings for posts, pages and projects, and redirects
// kept by hand. Everything has a default, nothing unsafe reaches a page's head or a Location header, and
// the site's own redirects always win.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { PublishError, publishPayloadPost, unpublishPayloadPost } from "../worker/blog/payload-publisher";
import { forgetEarlierDocument, publishPage, publishProject, unpublishPage } from "../worker/site/publisher";
import {
    REDIRECTS_KEY,
    addressInUse,
    automaticRedirects,
    manualRedirect,
    publishRedirects,
    redirectFrom,
    redirectTo,
    redirectsSnapshot,
} from "../worker/site/redirects";
import { discrepancies, inStep, siteDrift } from "../worker/site/sync-check";
import { resetDb, testEnv } from "./helpers";
import { sampleImage } from "./image-samples";

const media = {
    loadMedia: async (id: string | number) =>
        String(id) === "7" || String(id) === "9"
            ? {
                  bytes: sampleImage(String(id) === "7" ? "jpeg" : "png"),
                  contentType: String(id) === "7" ? "image/jpeg" : "image/png",
                  alt: String(id) === "7" ? "Cover" : "For sharing",
              }
            : null,
};
const words = (text: string) => ({ root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text }] }] } });
const T0 = "2026-11-01T00:00:00.000Z";
const get = async (path: string) => {
    const response = await SELF.fetch(`https://daly.id.au${path}`, { redirect: "manual" });
    return { status: response.status, html: await response.text(), location: response.headers.get("Location") };
};
const tag = (html: string, pattern: RegExp) => pattern.exec(html)?.[1] ?? null;
const head = (html: string) => ({
    title: tag(html, /<title>([^<]*)<\/title>/),
    description: tag(html, /<meta name="description" content="([^"]*)">/),
    canonical: tag(html, /<link rel="canonical" href="([^"]*)">/),
    robots: tag(html, /<meta name="robots" content="([^"]*)">/),
    ogTitle: tag(html, /<meta property="og:title" content="([^"]*)">/),
    ogDescription: tag(html, /<meta property="og:description" content="([^"]*)">/),
    ogImage: tag(html, /<meta property="og:image" content="([^"]*)">/),
    ogImageAlt: tag(html, /<meta property="og:image:alt" content="([^"]*)">/),
    twitterTitle: tag(html, /<meta name="twitter:title" content="([^"]*)">/),
});
const post = (over = {}) => ({
    postId: "payload:1",
    slug: "hello",
    title: "Hello",
    summary: "A summary.",
    content: words("Words."),
    heroMediaId: 7,
    publishedAt: T0,
    sourceUpdatedAt: T0,
    ...over,
});
const flag = (key: string, on: boolean) =>
    testEnv.DB.prepare(
        "INSERT INTO feature_flags (key, enabled, updated_at, updated_by) VALUES (?1, ?2, '2026-01-01T00:00:00.000Z', 'test') ON CONFLICT(key) DO UPDATE SET enabled = ?2",
    )
        .bind(key, on ? 1 : 0)
        .run();

beforeEach(async () => {
    await resetDb();
    await testEnv.DB.prepare("DELETE FROM meta").run();
    await flag("website.projects_home", false);
});

describe("search and sharing settings", () => {
    it("a post, page and project with none set get sensible defaults from their own content", async () => {
        await publishPayloadPost(testEnv, post(), media);
        await publishPage(testEnv, { id: 1, slug: "now", title: "Now", lede: "What I am doing.", content: words("Now."), heroMediaId: 7 }, media);
        const p = head((await get("/blog/hello")).html);
        expect(p).toMatchObject({
            title: "Hello — Aidan Daly",
            description: "A summary.",
            canonical: "https://daly.id.au/blog/hello",
            ogTitle: "Hello",
            ogDescription: "A summary.",
            ogImageAlt: "Cover",
        });
        expect(p.ogImage).toMatch(/^https:\/\/daly\.id\.au\/media\/[a-f0-9]{24}\.jpg$/);
        expect(head((await get("/now")).html)).toMatchObject({
            title: "Now — Aidan Daly",
            description: "What I am doing.",
            canonical: "https://daly.id.au/now",
        });
        // Nothing is stored for a post that sets nothing: its row is exactly as it would have been before.
        expect(await testEnv.DB.prepare("SELECT seo FROM posts WHERE id = 'payload:1'").first()).toEqual({ seo: null });
        // The test environment isn't production, so nothing here is indexable; the sitemap still lists them.
        expect((await get("/sitemap.xml")).html).toContain("/blog/hello");
    });

    it("every setting is used when it's set, on a post, a page and a project", async () => {
        const seo = {
            title: "A search title",
            description: "A search description.",
            socialTitle: "A sharing title",
            socialDescription: "A sharing description.",
            imageMediaId: 9,
            canonical: "https://example.com/first-published-here",
        };
        await publishPayloadPost(testEnv, post({ seo }), media);
        await publishPage(testEnv, { id: 1, slug: "now", title: "Now", heroMediaId: 7, seoTitle: seo.title, seoDescription: seo.description, seo }, media);
        await flag("website.projects_home", true);
        await publishProject(
            testEnv,
            { id: 1, slug: "lamp", title: "Lamp", summary: "A lamp.", heroMediaId: 7, seoTitle: seo.title, seoDescription: seo.description, seo },
            media,
        );
        for (const path of ["/blog/hello", "/now", "/projects/lamp"]) {
            const h = head((await get(path)).html);
            expect(h, path).toMatchObject({
                title: "A search title",
                description: "A search description.",
                canonical: "https://example.com/first-published-here",
                ogTitle: "A sharing title",
                ogDescription: "A sharing description.",
                twitterTitle: "A sharing title",
                ogImageAlt: "For sharing",
            });
            // The sharing image, not the cover.
            expect(h.ogImage, path).toMatch(/^https:\/\/daly\.id\.au\/media\/[a-f0-9]{24}\.png$/);
        }
        // A canonical address on this site is made absolute.
        await publishPage(testEnv, { id: 1, slug: "now", title: "Now", seo: { canonical: "/blog/hello" } }, media);
        expect(head((await get("/now")).html).canonical).toBe("https://daly.id.au/blog/hello");
    });

    it("the search title and description alone also feed link previews", async () => {
        await publishPayloadPost(testEnv, post({ seo: { title: "Only a search title", description: "Only a search description." } }), media);
        expect(head((await get("/blog/hello")).html)).toMatchObject({ ogTitle: "Only a search title", ogDescription: "Only a search description." });
    });

    it("'hide from search engines' marks the page noindex and leaves it out of the sitemap, while it stays public", async () => {
        await publishPayloadPost(testEnv, post({ seo: { noindex: true } }), media);
        await publishPayloadPost(testEnv, post({ postId: "payload:2", slug: "listed", title: "Listed" }), media);
        await publishPage(testEnv, { id: 1, slug: "now", title: "Now", seo: { noindex: true } }, media);
        await publishPage(testEnv, { id: 2, slug: "uses", title: "Uses" }, media);
        await flag("website.projects_home", true);
        await publishProject(testEnv, { id: 1, slug: "lamp", title: "Lamp", seo: { noindex: true } }, media);
        await publishProject(testEnv, { id: 2, slug: "desk", title: "Desk" }, media);
        for (const path of ["/blog/hello", "/now", "/projects/lamp"]) {
            const page = await get(path);
            expect(page.status, path).toBe(200);
            expect(head(page.html).robots, path).toBe("noindex, follow");
        }
        const sitemap = (await get("/sitemap.xml")).html;
        for (const listed of ["/blog/listed", "/uses", "/projects/desk"]) expect(sitemap).toContain(`https://daly.id.au${listed}<`);
        for (const hidden of ["/blog/hello", "/now<", "/projects/lamp"]) expect(sitemap).not.toContain(hidden);
        // Still in the list of projects on the site: hidden from search engines, not from visitors.
        expect((await get("/projects")).html).toContain("Lamp");
    });

    it("refuses what can't be used, in a check and in a publish, and stores nothing unsafe", async () => {
        for (const mode of [{ mode: "check" as const }, {}]) {
            await expect(
                publishPage(testEnv, { id: 1, slug: "now", title: "Now", seo: { canonical: "javascript:alert(1)" } }, { ...media, ...mode }),
            ).rejects.toThrow(/canonical address/);
            await expect(publishPage(testEnv, { id: 1, slug: "now", title: "Now", seo: { imageMediaId: 404 } }, { ...media, ...mode })).rejects.toThrow(
                /sharing image/,
            );
            await expect(publishPayloadPost(testEnv, post({ seo: { canonical: "//evil.example" } }), { ...media, ...mode })).rejects.toBeInstanceOf(
                PublishError,
            );
        }
        expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM posts").first()).toEqual({ n: 0 });
        // Markup in a title or description is text, never markup.
        await publishPage(
            testEnv,
            { id: 1, slug: "now", title: "Now", seoTitle: `"><script>alert(1)</script>`, seo: { socialDescription: `"><img src=x onerror=alert(1)>` } },
            media,
        );
        const html = (await get("/now")).html;
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).not.toContain("<img src=x");
        // Text longer than the limit is cut, not refused: content saved before the limit existed still publishes.
        await publishPage(testEnv, { id: 1, slug: "now", title: "Now", seoTitle: "t".repeat(200), seoDescription: "d".repeat(500) }, media);
        const h = head((await get("/now")).html);
        expect([h.title?.length, h.description?.length]).toEqual([120, 300]);
    });

    it("a snapshot from before these settings existed still shows its title and description", async () => {
        await publishPage(testEnv, { id: 1, slug: "now", title: "Now" }, media);
        await testEnv.DB.prepare(
            "UPDATE meta SET value = json_set(json_remove(value, '$.seo'), '$.seoTitle', 'An earlier title', '$.seoDescription', 'An earlier description.') WHERE key = 'page:now'",
        ).run();
        await testEnv.DB.prepare("UPDATE meta SET value = 'changed' WHERE key = 'content_version'").run();
        expect(head((await get("/now")).html)).toMatchObject({ title: "An earlier title", description: "An earlier description." });
    });
});

describe("redirects kept by hand", () => {
    const row = (from: string, to: string, over = {}) => ({ from, to, status: "301", enabled: true, ...over });

    it("normalises old addresses and refuses the ones that could never work", () => {
        expect(redirectFrom("/old-page/")).toEqual({ path: "/old-page" });
        expect(redirectFrom("https://daly.id.au/Old/Thing")).toEqual({ path: "/Old/Thing" });
        // Stored as the Worker sees it: percent-encoded.
        expect(redirectFrom("/café menu".replace(" ", "-"))).toEqual({ path: "/caf%C3%A9-menu" });
        for (const bad of [
            "",
            "old-page",
            "//evil.example/x",
            "/a?b=1",
            "/a#b",
            "/a b",
            "/",
            "/admin/x",
            "/api/posts",
            "/portal",
            "/media/x.png",
            "/wedding/rsvp",
        ])
            expect("problem" in redirectFrom(bad), bad).toBe(true);
    });

    it("refuses duplicates, loops, chains and bad destinations, naming the row", () => {
        const problem = (rows: Parameters<typeof redirectsSnapshot>[0]) => {
            try {
                redirectsSnapshot(rows);
                return null;
            } catch (error) {
                expect(error).toBeInstanceOf(PublishError);
                return (error as Error).message;
            }
        };
        expect(problem([row("/a", "/b"), row("/a/", "/c")])).toMatch(/Redirect 2 repeats the old address of redirect 1 \(\/a\)/);
        // A duplicate is refused even when one of the pair is switched off: the list must read unambiguously.
        expect(problem([row("/a", "/b", { enabled: false }), row("/a", "/c")])).toMatch(/repeats/);
        expect(problem([row("/a", "/a/")])).toMatch(/points \/a at itself/);
        expect(problem([row("/a", "/b"), row("/b", "/c")])).toMatch(/itself redirected/);
        // A full address on this site, or one with a query, is still this site's path: no hiding a loop or a chain.
        expect(problem([row("/a", "https://daly.id.au/a")])).toMatch(/points \/a at itself/);
        expect(problem([row("/a", "https://www.daly.id.au/a/?x=1")])).toMatch(/points \/a at itself/);
        expect(problem([row("/a", "/a?x=1")])).toMatch(/points \/a at itself/);
        expect(problem([row("/a", "https://daly.id.au/b#top"), row("/b", "/c")])).toMatch(/itself redirected/);
        // The router sends a blog address to lower case before anything else, so these are one address.
        expect(problem([row("/blog/hello", "/blog/HELLO")])).toMatch(/points \/blog\/hello at itself/);
        expect(problem([row("/blog/Hello", "https://daly.id.au/blog/hELLO/")])).toMatch(/at itself/);
        expect(problem([row("/a", "/blog/HELLO"), row("/blog/hello", "/c")])).toMatch(/itself redirected/);
        // Elsewhere on the site, case is part of the address.
        expect(problem([row("/notes/hello", "/notes/HELLO")])).toBeNull();
        // The same path on another site is somewhere else.
        expect(problem([row("/a", "https://example.com/a")])).toBeNull();
        expect(problem([row("/a", "javascript:alert(1)")])).toMatch(/Redirect 1 needs a destination/);
        expect(problem([row("/a", "//evil.example")])).toMatch(/destination/);
        expect(problem([row("/a", "/b", { status: "307" })])).toMatch(/permanent \(301\) or temporary \(302\)/);
        expect(problem([row("/a", "/b"), row("/c", "https://example.com/x", { status: "302" }), row("/d", "/e", { enabled: false })])).toBeNull();
        expect(redirectsSnapshot([row("/a", "/b"), row("/d", "/e", { enabled: false })]).redirects).toEqual({ "/a": { to: "/b", status: 301 } });
    });

    it("a destination with characters a header can't carry is stored and sent percent-encoded", async () => {
        expect(redirectTo("/日本/café")).toEqual({ to: "/%E6%97%A5%E6%9C%AC/caf%C3%A9" });
        expect(redirectTo("/search?q=café#résumé")).toEqual({ to: "/search?q=caf%C3%A9#r%C3%A9sum%C3%A9" });
        expect(redirectTo("https://例え.jp/日本")).toEqual({ to: "https://xn--r8jz45g.jp/%E6%97%A5%E6%9C%AC" });
        // Already encoded: unchanged, not encoded twice.
        expect(redirectTo("/caf%C3%A9")).toEqual({ to: "/caf%C3%A9" });
        await publishRedirects(testEnv, [row("/old-unicode", "/日本"), row("/blog/Old-Post", "/caf\u00e9")]);
        expect(await get("/old-unicode")).toMatchObject({ status: 301, location: "https://daly.id.au/%E6%97%A5%E6%9C%AC" });
        // An old blog address is matched in the lower case the router has already sent the visitor to.
        expect(await get("/blog/Old-Post")).toMatchObject({ status: 301, location: "https://daly.id.au/blog/old-post" });
        expect(await get("/blog/old-post")).toMatchObject({ status: 301, location: "https://daly.id.au/caf%C3%A9" });
        // A blog address with characters the router leaves alone (+ & , :) or lower-case escapes still matches:
        // the lookup uses the same form the old address is stored in.
        await publishRedirects(testEnv, [row("/blog/c++-tips", "/blog"), row("/blog/q&a", "/about"), row("/blog/caf%c3%a9", "/contact")]);
        expect(await get("/blog/c++-tips")).toMatchObject({ status: 301, location: "https://daly.id.au/blog" });
        expect(await get("/blog/C++-Tips")).toMatchObject({ status: 301, location: "https://daly.id.au/blog/c%2B%2B-tips" });
        expect(await get("/blog/c%2B%2B-tips")).toMatchObject({ status: 301, location: "https://daly.id.au/blog" });
        expect(await get("/blog/q&a")).toMatchObject({ status: 301, location: "https://daly.id.au/about" });
        expect(await get("/blog/caf%c3%a9")).toMatchObject({ status: 301, location: "https://daly.id.au/contact" });
        expect(await get("/blog/caf%C3%A9")).toMatchObject({ status: 301, location: "https://daly.id.au/contact" });
        // A destination that only becomes another site's address once resolved is refused, not stored and dropped.
        expect("problem" in redirectTo("/a/..//evil.example/y")).toBe(true);
        // The length limit is on the stored (encoded) form, once: 34 kanji is fine, a very long address isn't.
        expect("path" in redirectFrom("/" + "日".repeat(34))).toBe(true);
        expect(redirectFrom("/" + "a".repeat(700))).toEqual({ problem: "has an old address that's too long." });
        // The list a write replaces is kept, one back.
        const previous = JSON.parse(
            (await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'site:redirects-previous'").first<{ value: string }>())!.value,
        );
        expect(Object.keys(previous.redirects)).toEqual(["/old-unicode", "/blog/old-post"]);
        // Even a list stored before destinations were encoded redirects instead of failing.
        await testEnv.DB.prepare("UPDATE meta SET value = ? WHERE key = ?")
            .bind(JSON.stringify({ redirects: { "/stored-raw": { to: "/日本", status: 301 } } }), REDIRECTS_KEY)
            .run();
        expect(await get("/stored-raw")).toMatchObject({ status: 301, location: "https://daly.id.au/%E6%97%A5%E6%9C%AC" });
    });

    it("sends an address that nothing answers to its destination, with the status chosen", async () => {
        await publishPayloadPost(testEnv, post(), media);
        expect((await get("/old-thing")).status).toBe(404);
        await publishRedirects(testEnv, [
            row("/old-thing", "/blog/hello"),
            row("/elsewhere", "https://example.com/there", { status: "302" }),
            row("/off", "/blog/hello", { enabled: false }),
            row("/deep/old/path", "/blog"),
        ]);
        expect(await get("/old-thing")).toMatchObject({ status: 301, location: "https://daly.id.au/blog/hello" });
        expect(await get("/old-thing/")).toMatchObject({ status: 301 });
        expect(await get("/elsewhere")).toMatchObject({ status: 302, location: "https://example.com/there" });
        expect(await get("/deep/old/path")).toMatchObject({ status: 301, location: "https://daly.id.au/blog" });
        expect((await get("/off")).status).toBe(404);
        expect((await get("/never-listed")).status).toBe(404);
        // Removing it from the list takes effect on the next request.
        await publishRedirects(testEnv, []);
        expect((await get("/old-thing")).status).toBe(404);
    });

    it("never hides a live page, and the site's own redirects always win", async () => {
        await publishPayloadPost(testEnv, post(), media);
        await publishPage(testEnv, { id: 1, slug: "now", title: "Now" }, media);
        await publishPage(testEnv, { id: 1, slug: "today", title: "Now" }, media); // renamed: /now redirects to /today by itself
        await publishPayloadPost(testEnv, post({ slug: "hello-again" }), media); // renamed: /blog/hello redirects by itself
        // Saving the list checks each old address against what already answers it.
        for (const [from, why] of [
            ["/today", /published page/],
            ["/blog/hello-again", /published post/],
            ["/now", /already redirects to \/today/],
            ["/blog/hello", /already redirects to \/blog\/hello-again/],
            ["/blog", /one of the site's own pages/],
            ["/contact", /one of the site's own pages/],
        ] as const)
            await expect(publishRedirects(testEnv, [row(from, "/somewhere")], { mode: "check" }), from).rejects.toThrow(why);
        expect(await addressInUse(testEnv.DB, "/free-address")).toBeNull();
        expect(await testEnv.DB.prepare("SELECT 1 FROM meta WHERE key = ?").bind(REDIRECTS_KEY).first()).toBeNull();
        // Even if such a row is on the site (a page published after the redirect was saved), the page answers.
        await publishRedirects(testEnv, [row("/today", "/blog"), row("/now", "/blog"), row("/blog/hello", "/blog")]);
        expect((await get("/today")).status).toBe(200);
        expect(await get("/now")).toMatchObject({ status: 301, location: "https://daly.id.au/today" });
        expect(await get("/blog/hello")).toMatchObject({ status: 301, location: "https://daly.id.au/blog/hello-again" });
        // An address kept for an unpublished page answers nothing, so a redirect from it is allowed and used.
        await unpublishPage(testEnv, 1);
        expect(await addressInUse(testEnv.DB, "/today")).toBeNull();
        expect(await get("/today")).toMatchObject({ status: 301, location: "https://daly.id.au/blog" });
    });

    it("a damaged or tampered list sends nobody anywhere unsafe", async () => {
        await testEnv.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
            .bind(
                REDIRECTS_KEY,
                JSON.stringify({
                    redirects: {
                        "/x": { to: "javascript:alert(1)", status: 301 },
                        "/y": { to: "//evil.example", status: 301 },
                        "/z": { to: "/fine", status: 999 },
                    },
                }),
            )
            .run();
        expect(await manualRedirect(testEnv.DB, "/x")).toBeNull();
        expect(await manualRedirect(testEnv.DB, "/y")).toBeNull();
        expect(await manualRedirect(testEnv.DB, "/z")).toEqual({ to: "/fine", status: 301 });
        await testEnv.DB.prepare("UPDATE meta SET value = '{not json' WHERE key = ?").bind(REDIRECTS_KEY).run();
        expect(await manualRedirect(testEnv.DB, "/x")).toBeNull();
        expect((await get("/x")).status).toBe(404);
    });

    it("lists the redirects the site keeps by itself, with what they belong to", async () => {
        await publishPayloadPost(testEnv, post(), media);
        await publishPayloadPost(testEnv, post({ slug: "hello-again" }), media);
        await publishPage(testEnv, { id: 1, slug: "now", title: "Now" }, media);
        await publishPage(testEnv, { id: 1, slug: "today", title: "Today" }, media);
        await publishProject(testEnv, { id: 1, slug: "lamp", title: "Lamp" }, media);
        await publishProject(testEnv, { id: 1, slug: "desk-lamp", title: "Desk lamp" }, media);
        const list = await automaticRedirects(testEnv.DB);
        expect(list.map((r) => `${r.kind} ${r.from} -> ${r.to} (${r.title})`)).toEqual([
            "post /blog/hello -> /blog/hello-again (Hello)",
            "page /now -> /today (Today)",
            "project /projects/lamp -> /projects/desk-lamp (Desk lamp)",
        ]);
        expect(list[0].createdAt).toBeTruthy();
        // Off the site: the addresses are kept, and shown as leading nowhere for now.
        await unpublishPayloadPost(testEnv, "payload:1");
        await unpublishPage(testEnv, 1);
        const kept = await automaticRedirects(testEnv.DB);
        expect(kept.filter((r) => r.kind !== "project").map((r) => `${r.from} -> ${r.to}`)).toEqual([
            "/blog/hello -> null",
            "/blog/hello-again -> null",
            "/now -> null",
            "/today -> null",
        ]);
    });

    it("the sync check compares the redirects on the site with the list in Payload, by content", async () => {
        const saved = "2026-11-01T06:00:00.000Z";
        type Item = { from: string; to: string; status: string; enabled: number };
        const payloadDb = (list: { updated_at: string; items: Item[] } | "no table" | "never saved") =>
            ({
                prepare: (sql: string) => ({
                    all: async () => {
                        if (!/FROM redirects/.test(sql)) return { results: [] };
                        if (list === "no table") throw new Error("D1_ERROR: no such table: redirects: SQLITE_ERROR");
                        if (list === "never saved") return { results: [] };
                        return { results: /redirects_items/.test(sql) ? list.items : [{ updated_at: list.updated_at }] };
                    },
                }),
            }) as never;
        const later = new Date("2026-11-02T00:00:00.000Z");
        const item = (from: string, to: string, enabled = 1): Item => ({ from, to, status: "301", enabled });
        const inPayload = { updated_at: saved, items: [item("/a", "/b"), item("/off", "/b", 0)] };
        // A Payload database from before the list existed, or a list never saved, and nothing on the site: in step.
        expect(inStep(await siteDrift(payloadDb("no table"), testEnv.DB, later))).toBe(true);
        expect(inStep(await siteDrift(payloadDb("never saved"), testEnv.DB, later))).toBe(true);
        // Saved in Payload, never written to the site.
        const missing = await siteDrift(payloadDb(inPayload), testEnv.DB, later);
        expect([missing.redirectsStale, inStep(missing), discrepancies(missing)]).toEqual([true, false, 1]);
        // On the site with the right date and the wrong list (what a hook publishing an empty document leaves).
        await publishRedirects(testEnv, [], { updatedAt: saved });
        expect((await siteDrift(payloadDb(inPayload), testEnv.DB, later)).redirectsStale).toBe(true);
        // The same list, whatever date it carries: in step. A row that's switched off isn't on the site.
        await publishRedirects(testEnv, [row("/a", "/b"), row("/off", "/b", { enabled: false })], { updatedAt: T0 });
        expect(inStep(await siteDrift(payloadDb(inPayload), testEnv.DB, later))).toBe(true);
        // A different destination is a different list.
        expect((await siteDrift(payloadDb({ updated_at: saved, items: [item("/a", "/c")] }), testEnv.DB, later)).redirectsStale).toBe(true);
        // The site still has redirects that Payload's list no longer does (an older Payload backup restored, say).
        expect((await siteDrift(payloadDb("never saved"), testEnv.DB, later)).redirectsStale).toBe(true);
        // A save from a moment ago isn't called drift by the automatic check; a person's check counts it.
        const justNow = { updated_at: "2026-11-01T23:59:30.000Z", items: [item("/a", "/c")] };
        expect((await siteDrift(payloadDb(justNow), testEnv.DB, later)).redirectsStale).toBe(false);
        expect((await siteDrift(payloadDb(justNow), testEnv.DB, later, 0)).redirectsStale).toBe(true);
    });
});

describe("a new document that was given a deleted one's number", () => {
    it("starts with none of the earlier document's kept addresses", async () => {
        // Page 5 was renamed, then unpublished: its two addresses are kept for it.
        await publishPage(testEnv, { id: 5, slug: "first", title: "Earlier" }, media);
        await publishPage(testEnv, { id: 5, slug: "second", title: "Earlier" }, media);
        await unpublishPage(testEnv, 5);
        // It was then deleted for good, and the site never heard. Payload gives a new page the number 5.
        await forgetEarlierDocument(testEnv, "page", 5);
        await publishPage(
            testEnv,
            { id: 5, slug: "unrelated", title: "New", createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z" },
            media,
        );
        expect((await get("/unrelated")).status).toBe(200);
        // The earlier page's addresses don't lead to the new one.
        expect((await get("/first")).status).toBe(404);
        expect((await get("/second")).status).toBe(404);
    });

    it("without that step they would have been inherited (what the step is for)", async () => {
        await publishPage(testEnv, { id: 5, slug: "first", title: "Earlier" }, media);
        await unpublishPage(testEnv, 5);
        await publishPage(testEnv, { id: 5, slug: "unrelated", title: "New" }, media);
        expect(await get("/first")).toMatchObject({ status: 301, location: "https://daly.id.au/unrelated" });
    });
});
