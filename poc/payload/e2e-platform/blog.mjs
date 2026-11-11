// The blog in Payload, end to end against the real Payload in `wrangler dev --local` (invented data):
// the import keeps an existing post's public page byte for byte; publishing, draft saves, slug changes,
// unpublishing and deleting do what docs/PAYLOAD-BLOG.md says; only owners and admins can write.
//
// Run (fresh local state; SITE_URL=http://localhost:8790 as for authz.mjs):
//   npx wrangler d1 migrations apply DB --local     (the site's schema in the local "wedding" D1)
//   node e2e-platform/blog.mjs --seed                (an invented legacy post, before Payload first starts)
//   npx wrangler dev --port 8790 --local --env-file .dev.vars.authz
//   node e2e-platform/blog.mjs
// Local only. Exits non-zero if any expectation fails.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { OWNER, token } from "../scripts/test-identity.mjs";

const here = path.resolve(import.meta.dirname, "..");
const BASE = process.env.POC_BASE ?? "http://localhost:8790";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE)) throw new Error("Local wrangler dev only.");
const LEGACY_ID = "invented-capacities-0001";
const LEGACY_SLUG = "an-invented-older-post";

if (process.argv.includes("--seed")) {
    const html = '<p>Written before Payload. <a href="https://example.com/" rel="noopener noreferrer" target="_blank">A link</a>.</p><h2 id="part">Part</h2><p>More.</p>';
    const sql = `INSERT OR REPLACE INTO posts (id, slug, title, subtitle, summary, category, tags, featured, body_html, toc, search_text, word_count, reading_minutes, published_at, updated_at, content_hash, synced_at, source)
      VALUES ('${LEGACY_ID}', '${LEGACY_SLUG}', 'An invented older post', 'From the archive', 'Written before Payload.', 'Archive', '["history"]', 0,
      '${html.replace(/'/g, "''")}', '[{"id":"part","text":"Part","level":2}]', 'Written before Payload. A link. Part More.', 7, 1, '2026-10-01T00:00:00.000Z', NULL, 'x', '2026-10-01T00:00:00.000Z', 'capacities')`;
    execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--command", sql], { cwd: here, stdio: "inherit" });
    console.log("seeded");
    process.exit(0);
}

const SITE = { Origin: BASE };
const people = { owner: OWNER, admin: "admin@example.test", editor: "editor@example.test", viewer: "viewer@example.test" };
async function call(method, p, email, body) {
    const response = await fetch(`${BASE}${p}`, {
        method,
        redirect: "manual",
        headers: { ...SITE, ...(email ? { "Cf-Access-Jwt-Assertion": token(email) } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {}
    return { status: response.status, text, json, location: response.headers.get("location") };
}
const page = async (p) => {
    const r = await call("GET", p, null);
    return { ...r, text: r.text.replace(/nonce-[^'"]+|nonce="[^"]+"/g, "") };
};

let failures = 0;
const expect = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `  (${String(detail).slice(0, 300)})` : ""}`);
};

const lexical = (...paragraphs) => ({
    root: {
        type: "root",
        format: "",
        indent: 0,
        version: 1,
        direction: "ltr",
        children: paragraphs.map((p) => ({
            type: "paragraph",
            format: "",
            indent: 0,
            version: 1,
            direction: "ltr",
            textFormat: 0,
            children: [{ type: "text", text: p, format: 0, detail: 0, mode: "normal", style: "", version: 1 }],
        })),
    },
});

// 0. People for each role (through the portal's own API, as the owner).
for (const role of ["admin", "editor", "viewer"]) {
    const r = await call("POST", "/api/portal/users", OWNER, { email: people[role], role });
    if (r.status >= 300 && !/already|exists|conflict/i.test(r.text)) throw new Error(`creating ${role}: ${r.status} ${r.text.slice(0, 120)}`);
}

// 1. The legacy post before Payload has started (public routes never start it).
const before = { page: await page(`/blog/${LEGACY_SLUG}`), rss: await page("/feed.xml"), sitemap: await page("/sitemap.xml") };
expect("legacy post is public before the import", before.page.status === 200, before.page.status);

// 2. First Payload request: migrations run, the import with them.
const list = await call("GET", "/api/posts?depth=0&limit=50&draft=false", OWNER);
expect("owner lists posts", list.status === 200, list.text);
const imported = list.json?.docs?.find((d) => d.publicId === LEGACY_ID);
expect("the legacy post was imported, published, with its HTML kept", imported?._status === "published" && imported?.legacy?.bodyHtml?.includes("Written before Payload"), JSON.stringify(imported)?.slice(0, 200));
const after = { page: await page(`/blog/${LEGACY_SLUG}`), rss: await page("/feed.xml"), sitemap: await page("/sitemap.xml") };
expect("its public page is byte-identical", after.page.text === before.page.text);
expect("the feed is identical (but for the build date)", after.rss.text.replace(/<lastBuildDate>.*?<\/lastBuildDate>/, "") === before.rss.text.replace(/<lastBuildDate>.*?<\/lastBuildDate>/, ""));
expect("the sitemap is identical", after.sitemap.text === before.sitemap.text);
const again = await call("GET", "/api/posts?depth=0&limit=50", OWNER);
expect("the import doesn't repeat", again.json?.docs?.filter((d) => d.publicId === LEGACY_ID).length === 1);

// 3. Who may write.
const draftBody = { title: "Invented new post", slug: `invented-new-${Date.now()}`, content: lexical("Hello <script>alert(1)</script> world.") };
for (const [role, expected] of [["editor", 403], ["viewer", 403], [null, 401]]) {
    const r = await call("POST", "/api/posts?draft=true", role && people[role], { ...draftBody, _status: "draft" });
    expect(`${role ?? "no identity"} can't create a post`, r.status === expected || (r.status >= 400 && r.status < 500), `${r.status} ${r.text}`);
}
for (const role of ["editor", "viewer"]) {
    const r = await call("GET", "/api/posts", people[role]);
    expect(`${role} can't read posts through the API`, r.status === 403 || (r.json?.docs?.length ?? 0) === 0, r.status);
}

// 4. Draft, publish, edit as draft, slug change, unpublish, delete.
const created = await call("POST", "/api/posts?draft=true", people.admin, { ...draftBody, _status: "draft" });
const id = created.json?.doc?.id;
expect("admin creates a draft", created.status === 201 && id, created.text);
expect("a draft isn't public", (await page(`/blog/${draftBody.slug}`)).status === 404);
const published = await call("PATCH", `/api/posts/${id}?draft=false`, people.admin, { _status: "published" });
expect("admin publishes it", published.status === 200, published.text);
let live = await page(`/blog/${draftBody.slug}`);
expect("published: it's public", live.status === 200, live.status);
expect("its text is escaped", live.text.includes("Hello &lt;script&gt;alert(1)&lt;/script&gt; world.") && !live.text.includes("<script>alert(1)"));
expect("it's in the feed and sitemap", (await page("/feed.xml")).text.includes(draftBody.slug) && (await page("/sitemap.xml")).text.includes(draftBody.slug));

const draftEdit = await call("PATCH", `/api/posts/${id}?draft=true`, people.admin, { title: "Changed only in a draft", _status: "draft" });
expect("a draft save is accepted", draftEdit.status === 200, draftEdit.text);
live = await page(`/blog/${draftBody.slug}`);
expect("a draft save changes nothing public", live.status === 200 && !live.text.includes("Changed only in a draft"));

const clash = await call("PATCH", `/api/posts/${id}?draft=false`, people.admin, { slug: LEGACY_SLUG, _status: "published" });
expect("a slug another post uses is refused", clash.status === 400, `${clash.status} ${clash.text}`);
expect("…and the imported post is untouched", (await page(`/blog/${LEGACY_SLUG}`)).text === before.page.text);

const renamed = `${draftBody.slug}-renamed`;
const moved = await call("PATCH", `/api/posts/${id}?draft=false`, people.admin, { slug: renamed, title: "Invented new post", _status: "published" });
expect("changing the slug", moved.status === 200, moved.text);
const old = await page(`/blog/${draftBody.slug}`);
expect("the old address redirects to the new one", old.status === 301 && old.location?.endsWith(`/blog/${renamed}`), `${old.status} ${old.location}`);

const unpublished = await call("PATCH", `/api/posts/${id}?draft=false`, people.admin, { _status: "draft" });
expect("unpublishing", unpublished.status === 200, unpublished.text);
expect("unpublished: gone from the site", (await page(`/blog/${renamed}`)).status === 404);

const adminTrash = await call("DELETE", `/api/posts/${id}?trash=true`, people.admin);
expect("admins can't delete or trash posts", adminTrash.status === 403, `${adminTrash.status} ${adminTrash.text}`);
const ownerTrash = await call("DELETE", `/api/posts/${id}?trash=true`, OWNER);
expect("the owner moves it to Trash", ownerTrash.status === 200, `${ownerTrash.status} ${ownerTrash.text}`);
const inTrash = await call("GET", `/api/posts/${id}?trash=true&depth=0`, OWNER);
expect("…where it's kept, restorable", inTrash.status === 200 && !!inTrash.json?.deletedAt, inTrash.text);
await call("PATCH", `/api/posts/${id}?trash=true&draft=false`, OWNER, { deletedAt: null, _status: "published" });
expect("restored and republished, it's back on the site", (await page(`/blog/${renamed}`)).status === 200);
await call("DELETE", `/api/posts/${id}?trash=true`, OWNER);
expect("trashed: gone from the site", (await page(`/blog/${renamed}`)).status === 404);

// 5. Editing the imported post's content replaces its stored HTML; the address stays.
const edit = await call("PATCH", `/api/posts/${imported?.id}?draft=false`, OWNER, { content: lexical("Rewritten in Payload."), _status: "published" });
expect("the imported post can be rewritten in Payload", edit.status === 200, edit.text);
live = await page(`/blog/${LEGACY_SLUG}`);
expect("…and its page shows the new content at the same address", live.status === 200 && live.text.includes("Rewritten in Payload.") && !live.text.includes("Written before Payload"));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
