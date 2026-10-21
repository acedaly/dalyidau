// Amplenote publishing (docs/AMPLENOTE.md): the plugin's reports, the optional REST API connection,
// the eligibility rules, rendering, and the blog features each article must reach. Amplenote itself
// is the invented stand-in in fixtures/amplenote; the plugin is the real amplenote/plugin.js.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../amplenote/plugin.js";
import { type MockApp, NOTE_IDS, createAmplenoteMock, secondNote } from "../fixtures/amplenote/mock-api.mjs";
import { renderMarkdown } from "../worker/amplenote/markdown";
import { conventions, extractMetadata, publicToken, tagMetadata, websiteTags, withoutRepeatedTitle } from "../worker/amplenote/metadata";
import { type ArticleRow, ineligibility, reconcile } from "../worker/amplenote/publisher";
import type { Env } from "../worker/env";
import { createMock, resetDb, sync } from "./helpers";
import { ORIGIN, OWNER, accessToken, apiCall, auditActions, call, db, portalEnv } from "./portal-helpers";

const PUBLISH_TOKEN = "test-amplenote-publish-token-0123456789abcdef";
const GARDEN = "notes-from-a-small-vegetable-garden";

let mock: ReturnType<typeof createAmplenoteMock>;
let env: Env;

const routeFetch = () =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input as RequestInfo, init);
        // The plugin's reports go to the Worker; everything else is "Amplenote".
        if (new URL(request.url).host === "daly.id.au")
            return call(new URL(request.url).pathname, { method: request.method, headers: request.headers, body: await request.text(), env });
        return mock.handle(request);
    });

/** Runs the real plugin, as Amplenote would when the owner opens a note (or picks "Publish to website now"). */
const runPlugin = async (settings: Record<string, string> = {}) => {
    const app: MockApp = mock.app({ "Publishing token": PUBLISH_TOKEN, Website: "https://daly.id.au", ...settings });
    const instance = { ...plugin, _nextRun: 0 };
    await instance.appOption["Publish to website now"].call(instance, app);
    return app;
};

const page = async (path: string) => {
    const response = await call(path, { env });
    return { response, html: await response.text() };
};

const article = (uuid: string) => db().prepare("SELECT * FROM amplenote_articles WHERE uuid = ?").bind(uuid).first<ArticleRow>();
const amplenotePosts = async () =>
    (await db().prepare("SELECT slug, title FROM posts WHERE source = 'amplenote' ORDER BY slug").all<{ slug: string; title: string }>()).results;

const resetAmplenote = () =>
    db().batch(
        ["amplenote_articles", "amplenote_connection", "amplenote_oauth_states", "audit_log"]
            .map((t) => db().prepare(`DELETE FROM ${t}`))
            .concat(db().prepare("DELETE FROM posts WHERE source = 'amplenote'"), db().prepare("DELETE FROM media WHERE id LIKE 'amplenote:%'")),
    );

/** Connect in Portal settings, consent in "Amplenote", and follow the redirect back with the browser's cookie. */
const startConnecting = async () => {
    const start = await apiCall<{ url: string }>("POST", "/api/portal/website/amplenote/connect", {}, { env });
    expect(start.status).toBe(200);
    const cookie = start.headers.get("Set-Cookie")!.split(";")[0];
    const login = await mock.handle(new Request(start.json.url));
    const callback = new URL(login.headers.get("Location")!);
    return { start, cookie, callback: `${callback.pathname}${callback.search}`, callbackUrl: callback };
};

const connectApi = async () => {
    const { cookie, callback } = await startConnecting();
    return call(callback, { headers: { Cookie: cookie }, env });
};

beforeEach(async () => {
    await resetDb();
    await resetAmplenote();
    await sync(createMock());
    mock = createAmplenoteMock();
    env = await portalEnv({
        AMPLENOTE_PUBLISH_TOKEN: PUBLISH_TOKEN,
        AMPLENOTE_CLIENT_ID: "test-client",
        AMPLENOTE_TOKEN_KEY: "test-amplenote-token-key-0123456789abcdef",
    });
    routeFetch();
});

afterEach(() => vi.restoreAllMocks());

// --- Units -----------------------------------------------------------------------------------------

describe("markdown rendering", () => {
    const ctx = {
        siteUrl: "https://daly.id.au",
        image: (url: string) => (url.includes("ok") ? { src: "/media/abc.png", width: 10, height: 5 } : null),
        noteSlug: (uuid: string) => (uuid === NOTE_IDS.garden ? GARDEN : null),
    };

    it("escapes everything and never passes raw HTML through", () => {
        const { html } = renderMarkdown(
            '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\nA <b>bold</b> "claim" & more\n\n[x](javascript:alert(1))',
            ctx,
        );
        expect(html).not.toMatch(/<script|onerror|<b>|javascript:/);
        expect(html).toContain("&quot;claim&quot; &amp; more");
        expect(html).toContain("<p>x</p>");
    });

    it("renders headings (from h2), lists, tasks, quotes, tables and code with a table of contents", () => {
        const md =
            "# Intro\n## Detail\n- one\n  - nested\n- [x] done\n1. first\n> quoted *text*\n\n| a | b |\n|-|-|\n| 1 | 2 |\n\n```js\nconst a = '<x>';\n```\n---";
        const { html, toc, wordCount } = renderMarkdown(md, ctx);
        expect(html).toContain('<h2 id="intro">Intro</h2><h3 id="detail">Detail</h3>');
        expect(html).toContain("<ul><li>one<ul><li>nested</li></ul></li></ul>");
        expect(html).toContain('<ul class="task-list"><li><input type="checkbox" disabled checked aria-label="Done"> done</li></ul>');
        expect(html).toContain("<ol><li>first</li></ol>");
        expect(html).toContain("<blockquote><p>quoted <em>text</em></p></blockquote>");
        expect(html).toContain("<thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>");
        expect(html).toContain('<pre data-lang="js"><code class="language-js">const a = &#39;&lt;x&gt;&#39;;</code></pre><hr>');
        expect(toc).toEqual([
            { id: "intro", text: "Intro", level: 2 },
            { id: "detail", text: "Detail", level: 3 },
        ]);
        expect(wordCount).toBeGreaterThan(5);
    });

    it("links other notes only when they're published here, and images only once copied", () => {
        const md = `[garden](https://www.amplenote.com/notes/${NOTE_IDS.garden}) [private](https://www.amplenote.com/notes/${NOTE_IDS.private})\n\n![ok](https://images.amplenote.com/ok.png)\n\n![skip](https://images.amplenote.com/no.png)`;
        const { html, images } = renderMarkdown(md, ctx);
        expect(html).toContain(`<a href="/blog/${GARDEN}">garden</a> private`);
        expect(html).not.toContain(NOTE_IDS.private);
        expect(html).toContain('<figure class="image"><img src="/media/abc.png" alt="ok" width="10" height="5"');
        expect(html).not.toContain("no.png");
        expect(images).toEqual(["https://images.amplenote.com/ok.png", "https://images.amplenote.com/no.png"]);
    });

    it("strips Amplenote's comments, blank-line markers and footnote references", () => {
        const { html } = renderMarkdown('Line one\\\nline two [^1]<!-- {"uuid":"x"} -->\n\\\n\n[^1]: A note', ctx);
        expect(html).toBe('<p>Line one<br>line two </p><section class="footnotes" aria-label="Notes"><ol><li>A note</li></ol></section>');
    });
});

describe("metadata conventions", () => {
    const c = conventions(undefined);

    it("reads category, tags and featured from website/ tags and drops every other tag", () => {
        const tags = ["website/blog", "website/category/making-things", "website/tag/gardening", "website/featured", "personal/home"];
        expect(websiteTags(tags, c)).toEqual(["website/blog", "website/category/making-things", "website/featured", "website/tag/gardening"]);
        expect(tagMetadata(tags, c)).toEqual({ featured: true, category: "Making things", tags: ["Gardening"] });
    });

    it("accepts only public.amplenote.com links", () => {
        expect(publicToken("https://public.amplenote.com/AbC123xyz")).toBe("AbC123xyz");
        expect(publicToken("https://public.amplenote.com/embed/AbC123xyz")).toBe("AbC123xyz");
        for (const bad of ["http://public.amplenote.com/AbC123xyz", "https://evil.example/AbC123xyz", "https://public.amplenote.com/a/b/c", null, "nonsense"]) {
            expect(publicToken(bad)).toBeNull();
        }
    });

    it("takes an optional Website section out of the article", () => {
        const { metadata, body } = extractMetadata(
            "Intro\n## Website\n- slug: My Better Slug\n- summary: Short\n- published: 2026-09-01\n- nonsense: ignored\n## Next\nMore",
        );
        expect(metadata).toEqual({ slug: "my-better-slug", subtitle: null, summary: "Short", published: "2026-09-01T00:00:00.000Z", image: null });
        expect(body).toBe("Intro\n## Next\nMore");
        expect(withoutRepeatedTitle("# My title\nBody", "My Title")).toBe("Body");
        expect(withoutRepeatedTitle("# Another\nBody", "My Title")).toBe("# Another\nBody");
    });
});

describe("eligibility", () => {
    const base: ArticleRow = {
        uuid: NOTE_IDS.garden,
        slug: GARDEN,
        title: "T",
        website_tags: "[]",
        public_token: "tok123",
        markdown: "x",
        note_created_at: null,
        note_updated_at: null,
        first_published_at: null,
        plugin_tagged: 1,
        plugin_published: 1,
        plugin_seen_at: "2026-10-01",
        plugin_missing: 0,
        rest_public: null,
        rest_tagged: null,
        rest_deleted: null,
        rest_seen_at: null,
        rest_missing: 0,
        link_status: "ok",
        link_checked_at: null,
        link_failures: 0,
        state: "pending",
        reason: null,
        content_hash: null,
    };

    it("needs the tag, a publication, content and a working link", () => {
        expect(ineligibility(base, false)).toBeNull();
        expect(ineligibility({ ...base, plugin_tagged: 0 }, false)).toMatch(/tagged/);
        expect(ineligibility({ ...base, plugin_published: 0 }, false)).toMatch(/Not published/);
        expect(ineligibility({ ...base, public_token: null }, false)).toMatch(/Not published/);
        expect(ineligibility({ ...base, markdown: null }, false)).toMatch(/content/);
        expect(ineligibility({ ...base, link_status: null }, false)).toMatch(/Checking/);
        expect(ineligibility({ ...base, plugin_missing: 2 }, false)).toMatch(/No longer reported/);
    });

    it("keeps a published article through a single missed report or a passing link error", () => {
        const live = { ...base, state: "published" as const };
        expect(ineligibility({ ...live, plugin_missing: 1 }, false)).toBeNull();
        expect(ineligibility({ ...live, link_status: "error" }, false)).toBeNull();
        expect(ineligibility({ ...live, link_status: "gone", link_failures: 1 }, false)).toBeNull();
        expect(ineligibility({ ...live, link_status: "gone", link_failures: 2 }, false)).toMatch(/link/);
    });

    it("adds the API's checks when it's connected", () => {
        expect(ineligibility(base, true)).toMatch(/Waiting for the Amplenote API/);
        const confirmed = { ...base, rest_public: 1, rest_tagged: 1, rest_deleted: 0, rest_seen_at: "x" };
        expect(ineligibility(confirmed, true)).toBeNull();
        expect(ineligibility({ ...confirmed, rest_public: 0 }, true)).toMatch(/Not published/);
        expect(ineligibility({ ...confirmed, rest_tagged: 0 }, true)).toMatch(/tagged/);
        expect(ineligibility({ ...confirmed, rest_deleted: 1 }, true)).toMatch(/Deleted/);
    });
});

// --- The plugin's endpoint -------------------------------------------------------------------------

describe("the ingest endpoint", () => {
    const post = (headers: Record<string, string>, body: unknown, callEnv = env) =>
        call("/api/amplenote/ingest", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body),
            env: callEnv,
        });

    it("doesn't exist until the publishing token is set", async () => {
        const off = await portalEnv({ AMPLENOTE_PUBLISH_TOKEN: undefined });
        expect((await post({ Authorization: `Bearer ${PUBLISH_TOKEN}` }, { version: 1, complete: true, notes: [] }, off)).status).toBe(404);
    });

    it("needs the bearer token; an Access session or cookie is not enough", async () => {
        const report = { version: 1, complete: true, notes: [] };
        expect((await post({}, report)).status).toBe(401);
        expect((await post({ Authorization: "Bearer wrong-token-wrong-token-wrong-token" }, report)).status).toBe(401);
        const withAccess = await call("/api/amplenote/ingest", {
            method: "POST",
            token: await accessToken({ email: OWNER }),
            headers: { Origin: ORIGIN, "Content-Type": "application/json", Cookie: "CF_Authorization=x" },
            body: JSON.stringify(report),
            env,
        });
        expect(withAccess.status).toBe(401);
    });

    it("answers the plugin's CORS preflight, without allowing credentials", async () => {
        const response = await call("/api/amplenote/ingest", { method: "OPTIONS", env });
        expect(response.status).toBe(204);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
        expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    });

    it("rejects malformed reports and changes nothing", async () => {
        const response = await post({ Authorization: `Bearer ${PUBLISH_TOKEN}` }, { version: 1, complete: true, notes: [{ uuid: "../../etc", tags: [] }] });
        expect(response.status).toBe(422);
        expect(await amplenotePosts()).toEqual([]);
    });

    it("isn't reachable on the wedding domain", async () => {
        const response = await call("/api/amplenote/ingest", {
            method: "POST",
            host: "wedding.daly.id.au",
            env: { ...env, WEDDING_URL: "https://wedding.daly.id.au" },
        });
        expect(response.status).toBe(404);
    });
});

// --- Publishing through the plugin ------------------------------------------------------------------

describe("publishing with the plugin", () => {
    it("publishes a tagged, published note with its Amplenote title and metadata, and nothing else", async () => {
        const app = await runPlugin();
        expect(app.alerts[0]).toMatch(/1 published/);
        expect(await amplenotePosts()).toEqual([{ slug: GARDEN, title: "Notes from a small vegetable garden" }]);

        const post = await db().prepare("SELECT * FROM posts WHERE source = 'amplenote'").first<Record<string, unknown>>();
        expect(post).toMatchObject({
            id: `amplenote:${NOTE_IDS.garden}`,
            category: "Making things",
            tags: '["Gardening"]',
            featured: 1,
            subtitle: "A first season, honestly reported",
            summary: "What a season of tomatoes taught me about patience.",
        });
        expect(String(post!.image_key)).toMatch(/^[a-f0-9]{24}\.png$/);
        expect(await env.MEDIA.get(String(post!.image_key))).not.toBeNull();
        const body = String(post!.body_html);
        expect(body).not.toMatch(/<script|<h1|Website|summary:|personal\/home|task-1/);
        expect(body).toContain('<h3 id="what-worked">What worked</h3>');
        expect(body).not.toContain("never rendered");

        // The draft is known only by its id: no title, no content. The untagged note isn't stored at all.
        const draft = await article(NOTE_IDS.draft);
        expect(draft).toMatchObject({ title: null, markdown: null, state: "pending", reason: "Not published in Amplenote" });
        expect(await article(NOTE_IDS.private)).toBeNull();
        const everything = JSON.stringify((await db().prepare("SELECT * FROM amplenote_articles").all()).results);
        expect(everything).not.toMatch(/Secret draft|Private journal|personal\//);

        // Capacities articles are all still there.
        expect((await db().prepare("SELECT COUNT(*) AS n FROM posts WHERE source = 'capacities'").first<{ n: number }>())!.n).toBeGreaterThanOrEqual(3);
    });

    it("shows the article everywhere a blog post appears", async () => {
        await runPlugin();
        const title = "Notes from a small vegetable garden";

        const { response, html } = await page(`/blog/${GARDEN}`);
        expect(response.status).toBe(200);
        expect(html.match(/<h1/g)).toHaveLength(1);
        expect(html).toContain(`<link rel="canonical" href="https://daly.id.au/blog/${GARDEN}">`);
        expect(html).toContain(`<meta property="og:title" content="${title}">`);
        expect(html).toContain('"@type":"BlogPosting"');
        expect(html).toContain("Growing <strong>tomatoes</strong>");
        expect(response.headers.get("Content-Security-Policy")).not.toContain("amplenote");

        expect((await page("/")).html).toContain(title);
        expect((await page("/blog")).html).toContain(title);
        expect((await page(`/blog?category=${encodeURIComponent("Making things")}`)).html).toContain(title);
        expect((await page("/blog?tag=Gardening")).html).toContain(title);
        expect((await page("/blog?q=mulch")).html).toContain(title);
        expect((await page("/blog?q=zucchini")).html).toContain(title);

        const rss = (await page("/feed.xml")).html;
        expect(rss).toContain(`<title>${title}</title>`);
        expect(rss).toContain(`<link>https://daly.id.au/blog/${GARDEN}</link>`);
        expect(rss).toContain("What worked");
        expect((await page("/sitemap.xml")).html).toContain(`<loc>https://daly.id.au/blog/${GARDEN}</loc>`);
        // Capacities articles are still listed alongside it.
        expect(rss).toContain("Publishing straight from my notebook");
    });

    it("is idempotent: running again changes nothing and creates no duplicates", async () => {
        await runPlugin();
        const before = await db().prepare("SELECT content_hash, synced_at FROM posts WHERE source = 'amplenote'").first();
        const app = await runPlugin();
        expect(app.alerts[0]).toMatch(/0 published, 0 updated, 0 unpublished/);
        expect(await db().prepare("SELECT content_hash, synced_at FROM posts WHERE source = 'amplenote'").first()).toEqual(before);
        expect((await db().prepare("SELECT COUNT(*) AS n FROM amplenote_articles").first<{ n: number }>())!.n).toBe(2);
    });

    it("follows edits, keeping the address when the title changes", async () => {
        await runPlugin();
        mock.control.edit(NOTE_IDS.garden, { name: "A small vegetable garden, a year on", markdown: "Everything changed. Except the slugs." });
        const app = await runPlugin();
        expect(app.alerts[0]).toMatch(/1 updated/);
        expect(await amplenotePosts()).toEqual([{ slug: GARDEN, title: "A small vegetable garden, a year on" }]);
        expect((await page(`/blog/${GARDEN}`)).html).toContain("Everything changed.");
    });

    it("moves the article (with a redirect) when the note sets a new slug", async () => {
        await runPlugin();
        mock.control.edit(NOTE_IDS.garden, { markdown: "Body\n# Website\nslug: veggie-garden" });
        await runPlugin();
        expect(await amplenotePosts()).toEqual([{ slug: "veggie-garden", title: "Notes from a small vegetable garden" }]);
        expect((await page(`/blog/${GARDEN}`)).response.headers.get("Location")).toBe("https://daly.id.au/blog/veggie-garden");
    });

    it("takes the article down when it's unpublished in Amplenote, keeps the source, and restores the same address", async () => {
        await runPlugin();
        mock.control.unpublish(NOTE_IDS.garden);
        expect((await runPlugin()).alerts[0]).toMatch(/1 unpublished/);
        expect(await amplenotePosts()).toEqual([]);
        expect((await page(`/blog/${GARDEN}`)).response.status).toBe(404);
        expect((await page("/feed.xml")).html).not.toContain(GARDEN);
        expect((await page("/sitemap.xml")).html).not.toContain(GARDEN);
        expect(await article(NOTE_IDS.garden)).toMatchObject({ state: "withdrawn", slug: GARDEN, markdown: expect.stringContaining("tomatoes") });

        mock.control.edit(NOTE_IDS.garden, { public: true, token: "InventedGardenToken99" });
        await runPlugin();
        expect(await amplenotePosts()).toEqual([{ slug: GARDEN, title: "Notes from a small vegetable garden" }]);
    });

    it("takes the article down only after the tag has been missing twice", async () => {
        await runPlugin();
        mock.control.edit(NOTE_IDS.garden, { tags: ["personal/home"] });
        await runPlugin();
        expect(await amplenotePosts()).toHaveLength(1);
        await runPlugin();
        expect(await amplenotePosts()).toEqual([]);
        expect((await article(NOTE_IDS.garden))!.reason).toMatch(/No longer reported/);
    });

    it("ignores an empty report while articles are live (a client that hasn't loaded yet)", async () => {
        mock.control.add(secondNote);
        await runPlugin();
        expect(await amplenotePosts()).toHaveLength(2);
        for (const uuid of [NOTE_IDS.garden, NOTE_IDS.second, NOTE_IDS.draft]) mock.control.edit(uuid, { tags: [] });
        await runPlugin();
        await runPlugin();
        expect(await amplenotePosts()).toHaveLength(2);
    });

    it("links between published notes, and never to private ones", async () => {
        mock.control.add(secondNote);
        await runPlugin();
        const { html } = await page("/blog/why-i-write-things-down");
        expect(html).toContain(`<a href="/blog/${GARDEN}">my garden notes</a>`);
        expect(html).not.toContain(NOTE_IDS.private);
    });

    it("never takes an existing Capacities article's address", async () => {
        // The Capacities article lives at /blog/publishing-from-my-notebook.
        mock.control.add({ ...secondNote, name: "Publishing from my notebook" });
        await runPlugin();
        const slugs = (await amplenotePosts()).map((p) => p.slug);
        expect(slugs).toContain("publishing-from-my-notebook-2");
        // And a Capacities sync afterwards leaves Amplenote's articles alone.
        await sync(createMock(), {}, true);
        expect(await amplenotePosts()).toHaveLength(2);
        expect((await page("/blog/publishing-from-my-notebook")).response.status).toBe(200);
    });

    it("withdraws an article whose public link stops working, but not on a passing outage", async () => {
        await runPlugin();
        mock.control.linksDown(true);
        await reconcile(env);
        await reconcile(env);
        expect(await amplenotePosts()).toHaveLength(1);

        mock.control.linksDown(false);
        mock.control.edit(NOTE_IDS.garden, { token: "SomeOtherToken00" }); // The old link now answers 404.
        await reconcile(env);
        expect(await amplenotePosts()).toHaveLength(1);
        await reconcile(env);
        expect(await amplenotePosts()).toEqual([]);
        expect((await article(NOTE_IDS.garden))!.reason).toMatch(/link no longer works/);
    });

    it("doesn't publish a note until its public link has been confirmed", async () => {
        mock.control.linksDown(true);
        await runPlugin();
        expect(await amplenotePosts()).toEqual([]);
        expect((await article(NOTE_IDS.garden))!.reason).toMatch(/Checking its public Amplenote link/);
        mock.control.linksDown(false);
        await reconcile(env);
        expect(await amplenotePosts()).toHaveLength(1);
    });
});

// --- The REST API connection -----------------------------------------------------------------------

describe("the Amplenote API connection", () => {
    it("connects with PKCE, asks only for notes:list, and seals the tokens", async () => {
        const { start, cookie, callback, callbackUrl } = await startConnecting();
        const url = new URL(start.json.url);
        expect(url.origin + url.pathname).toBe("https://login.amplenote.com/login");
        expect(url.searchParams.get("scope")).toBe("notes:list");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
        expect(url.searchParams.get("redirect_uri")).toBe("https://daly.id.au/api/integrations/amplenote/callback");
        expect(callbackUrl.pathname).toBe("/api/integrations/amplenote/callback");
        expect(start.headers.get("Set-Cookie")).toMatch(
            /^__Secure-amplenote-oauth=[\w-]+; Path=\/api\/integrations\/amplenote\/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
        );

        const done = await call(callback, { headers: { Cookie: cookie }, env });
        expect(done.status).toBe(303);
        expect(done.headers.get("Location")).toBe("/portal/settings/website?amplenote=connected");
        expect(done.headers.get("Referrer-Policy")).toBe("no-referrer");
        expect(done.headers.get("Cache-Control")).toBe("no-store");
        expect(done.headers.get("Set-Cookie")).toContain("Max-Age=0");

        const row = await db().prepare("SELECT access_token, refresh_token, connected_by FROM amplenote_connection").first<Record<string, string>>();
        expect(row!.access_token).toMatch(/^v1:/);
        expect(JSON.stringify(row)).not.toMatch(/access-\d|refresh-\d/);
        expect(row!.connected_by).toBe(OWNER);
        expect(await auditActions()).toContain("website.amplenote.connect");

        // The state is single use.
        const again = await call(callback, { headers: { Cookie: cookie }, env });
        expect(again.headers.get("Location")).toBe("/portal/settings/website?amplenote=expired");
    });

    it("refuses a callback from a browser that didn't start the sign-in, and uses its state up", async () => {
        const { cookie, callback } = await startConnecting();
        for (const headers of [{}, { Cookie: "__Secure-amplenote-oauth=someone-elses-nonce" }] as Record<string, string>[]) {
            const response = await call(callback, { headers, env });
            expect(response.headers.get("Location")).toBe("/portal/settings/website?amplenote=expired");
        }
        // The first failed attempt consumed the state, so even the right browser must start again.
        expect((await call(callback, { headers: { Cookie: cookie }, env })).headers.get("Location")).toBe("/portal/settings/website?amplenote=expired");
        expect(await db().prepare("SELECT COUNT(*) AS n FROM amplenote_connection").first()).toEqual({ n: 0 });
        expect(mock.control.calls().filter((c) => c.endsWith("/oauth/token"))).toHaveLength(0);
    });

    it("treats a cancelled sign-in as declined and never asks for a token", async () => {
        const { cookie, start } = await startConnecting();
        const state = new URL(start.json.url).searchParams.get("state");
        const response = await call(`/api/integrations/amplenote/callback?error=access_denied&state=${state}`, { headers: { Cookie: cookie }, env });
        expect(response.headers.get("Location")).toBe("/portal/settings/website?amplenote=declined");
        expect(await db().prepare("SELECT COUNT(*) AS n FROM amplenote_oauth_states").first()).toEqual({ n: 0 });
    });

    it("is owner and admin only, and refuses anyone without Access", async () => {
        expect((await apiCall("POST", "/api/portal/users", { email: "editor@example.com", role: "editor" }, { env })).status).toBe(200);
        expect((await apiCall("POST", "/api/portal/website/amplenote/connect", {}, { email: "editor@example.com", env })).status).toBe(403);
        expect((await apiCall("GET", "/api/portal/website/amplenote", undefined, { email: "editor@example.com", env })).status).toBe(403);
        // The callback itself is public (it's the address Amplenote redirects to) but does nothing without a started sign-in.
        expect((await call("/api/integrations/amplenote/callback?code=good-code&state=x", { env })).headers.get("Location")).toBe(
            "/portal/settings/website?amplenote=expired",
        );
        expect((await call("/api/integrations/amplenote/callback?code=good-code&state=x", { method: "POST", env })).status).toBe(405);
    });

    it("refuses to connect without a key to seal the tokens", async () => {
        const unsealed = { ...env, AMPLENOTE_TOKEN_KEY: undefined };
        expect((await apiCall("POST", "/api/portal/website/amplenote/connect", {}, { env: unsealed })).status).toBe(409);
    });

    it("confirms publication through the API, and unpublishes without the plugin", async () => {
        await connectApi();
        await runPlugin();
        expect(await amplenotePosts()).toHaveLength(1);
        expect(await article(NOTE_IDS.garden)).toMatchObject({ rest_public: 1, rest_tagged: 1 });

        // Unpublished in Amplenote while the plugin isn't running: the scheduled check notices.
        mock.control.unpublish(NOTE_IDS.garden);
        await reconcile(env);
        expect(await amplenotePosts()).toEqual([]);
        expect((await article(NOTE_IDS.garden))!.reason).toMatch(/according to the Amplenote API/);
    });

    it("follows a title change and a removed tag through the API alone", async () => {
        await connectApi();
        await runPlugin();
        mock.control.edit(NOTE_IDS.garden, { name: "Renamed in Amplenote" });
        await reconcile(env);
        expect(await amplenotePosts()).toEqual([{ slug: GARDEN, title: "Renamed in Amplenote" }]);
        mock.control.edit(NOTE_IDS.garden, { tags: [] });
        await reconcile(env);
        expect(await amplenotePosts()).toEqual([]);
    });

    it("doesn't publish what the API finds until the plugin has sent it", async () => {
        await connectApi();
        await reconcile(env);
        expect(await amplenotePosts()).toEqual([]);
        expect(await article(NOTE_IDS.garden)).toMatchObject({ state: "pending", reason: expect.stringMatching(/Waiting for the Amplenote plugin/) });
        expect(await article(NOTE_IDS.private)).toBeNull();
    });

    it("refreshes an expired access token and keeps the rotated refresh token", async () => {
        await connectApi();
        await runPlugin();
        const before = await db().prepare("SELECT refresh_token FROM amplenote_connection").first<{ refresh_token: string }>();
        mock.control.expireAccess();
        await db().prepare("UPDATE amplenote_connection SET expires_at = '2000-01-01T00:00:00.000Z'").run();
        const summary = await reconcile(env);
        expect(summary.errors).toBe(0);
        expect(mock.control.calls().filter((c) => c.endsWith("/oauth/token"))).toHaveLength(2);
        const after = await db()
            .prepare("SELECT refresh_token, last_error FROM amplenote_connection")
            .first<{ refresh_token: string; last_error: string | null }>();
        expect(after!.refresh_token).not.toBe(before!.refresh_token);
        expect(after!.last_error).toBeNull();
    });

    it("keeps everything as it was when the connection or the listing fails", async () => {
        await connectApi();
        await runPlugin();

        mock.control.failListing(1);
        const failed = await reconcile(env);
        expect(failed.status).toBe("partial");
        expect(await amplenotePosts()).toHaveLength(1);

        mock.control.expireAccess();
        mock.control.revokeRefresh();
        await db().prepare("UPDATE amplenote_connection SET expires_at = '2000-01-01T00:00:00.000Z'").run();
        mock.control.unpublish(NOTE_IDS.garden);
        await reconcile(env);
        // The API can't be asked, and the plugin hasn't said anything new: the article stays up until one of them does.
        expect(await db().prepare("SELECT last_error FROM amplenote_connection").first()).toEqual({ last_error: expect.stringMatching(/Reconnect/) });
        expect(await amplenotePosts()).toHaveLength(1);
    });

    it("disconnects, and says what's configured without revealing any secret", async () => {
        await connectApi();
        const status = await apiCall<{ status: Record<string, unknown> }>("GET", "/api/portal/website/amplenote", undefined, { env });
        expect(status.json.status).toMatchObject({ tag: "website/blog", configured: { plugin: true, api: true }, connection: { connectedBy: OWNER } });
        expect(status.text).not.toContain(PUBLISH_TOKEN);
        expect(status.text).not.toMatch(/v1:|access-\d|refresh-\d|test-amplenote-token-key/);
        expect((await apiCall("POST", "/api/portal/website/amplenote/disconnect", {}, { env })).status).toBe(200);
        expect(await db().prepare("SELECT COUNT(*) AS n FROM amplenote_connection").first()).toEqual({ n: 0 });
        expect(await auditActions()).toContain("website.amplenote.disconnect");
    });
});

describe("the old proof of concept and the portal", () => {
    it("no longer special-cases /blog/amplenote-test or loosens the CSP anywhere", async () => {
        expect((await page("/blog/amplenote-test")).response.status).toBe(404);
        for (const path of ["/", "/blog", "/blog/publishing-from-my-notebook"]) {
            expect((await page(path)).response.headers.get("Content-Security-Policy")).not.toContain("amplenote");
        }
        const portal = await call("/portal/settings/website", { token: await accessToken({ email: OWNER }), env });
        expect(portal.status).toBe(200);
        const csp = portal.headers.get("Content-Security-Policy") ?? "";
        expect(csp).not.toContain("amplenote");
        expect(csp).toContain("frame-ancestors 'none'");
    });
});
