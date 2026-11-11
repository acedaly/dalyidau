// The website managed in Payload (docs/PAYLOAD-FRONTEND-PLAN.md), end to end against the real Payload in
// `wrangler dev --local`: before Payload starts, the site shows its built-in text; the seed migration
// publishes exactly that text, so the public pages don't change; the homepage, settings, menu and pages
// then change on the next request when published, drafts never; reserved addresses are refused; only
// owners and admins can write; the admin and its API need an identity. Also: the wedding by path.
//
// Run before blog.mjs, on a fresh local state (see .github/workflows/payload.yml). Local only.
import { OWNER, token } from "../scripts/test-identity.mjs";

const BASE = process.env.POC_BASE ?? "http://localhost:8790";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE)) throw new Error("Local wrangler dev only.");
const people = { owner: OWNER, admin: "admin@example.test", editor: "editor@example.test", viewer: "viewer@example.test" };

async function call(method, p, email, body) {
    const response = await fetch(`${BASE}${p}`, {
        method,
        redirect: "manual",
        headers: { Origin: BASE, ...(email ? { "Cf-Access-Jwt-Assertion": token(email) } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {}
    return { status: response.status, text, json, location: response.headers.get("location") };
}
/** The page as a visitor gets it, without the build-specific bits that differ between requests. */
const page = async (p) => {
    const r = await call("GET", p, null);
    return { ...r, text: r.text.replace(/nonce-[^'"]+|nonce="[^"]+"/g, "") };
};
const main = (html) => /<main[\s\S]*<\/footer>/.exec(html)?.[0] ?? null;
/** What a reader sees: tags dropped, entities decoded, whitespace collapsed (the About page's body is now rich text). */
const visible = (html) =>
    (main(html) ?? "")
        .replace(/<script[\s\S]*?<\/script>/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();

let failures = 0;
const expect = (label, ok, detail) => {
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `  (${String(detail).slice(0, 300)})` : ""}`);
};
const lexical = (...paragraphs) => ({
    root: {
        type: "root", format: "", indent: 0, version: 1, direction: "ltr",
        children: paragraphs.map((p) => ({
            type: "paragraph", format: "", indent: 0, version: 1, direction: "ltr", textFormat: 0,
            children: [{ type: "text", text: p, format: 0, detail: 0, mode: "normal", style: "", version: 1 }],
        })),
    },
});

for (const role of ["admin", "editor", "viewer"]) {
    const r = await call("POST", "/api/portal/users", OWNER, { email: people[role], role });
    if (r.status >= 300 && !/already|exists|conflict/i.test(r.text)) throw new Error(`creating ${role}: ${r.status} ${r.text.slice(0, 120)}`);
}

// 1. Before Payload has started: the built-in text.
const PUBLIC = ["/", "/about", "/contact", "/blog", "/sitemap.xml", "/feed.xml"];
const before = Object.fromEntries(await Promise.all(PUBLIC.map(async (p) => [p, await page(p)])));
expect("homepage before Payload", before["/"].status === 200 && before["/"].text.includes("writing down."), before["/"].status);
expect("about before Payload", before["/about"].status === 200, before["/about"].status);

// 2. Nobody without an identity reaches the content API.
expect("no identity: settings API refused", (await call("GET", "/api/globals/site-settings", null)).status === 401);
expect("no identity: pages API refused", (await call("GET", "/api/pages", null)).status === 401);

// 3. First Payload request: migrations and the seed run. The public pages are unchanged.
const settings = await call("GET", "/api/globals/site-settings?depth=0", OWNER);
expect("owner reads the site settings (seeded)", settings.status === 200 && settings.json?.name === "Aidan Daly", settings.text);
const nav = await call("GET", "/api/globals/navigation?depth=0", OWNER);
expect("the menu was seeded with 4 items", nav.json?.items?.length === 4, nav.text);
const pages = await call("GET", "/api/pages?depth=0&where[slug][equals]=about", OWNER);
const aboutId = pages.json?.docs?.[0]?.id;
expect("the About page was seeded and published", pages.json?.docs?.[0]?._status === "published", pages.text);
for (const p of PUBLIC) {
    const now = await page(p);
    const same = p.endsWith(".xml") ? now.text.replace(/<lastBuildDate>.*?<\/lastBuildDate>/, "") === before[p].text.replace(/<lastBuildDate>.*?<\/lastBuildDate>/, "") : main(now.text) === main(before[p].text) && main(now.text) !== null;
    const sameText = p === "/about" && visible(now.text) === visible(before[p].text) && visible(now.text).length > 200;
    expect(`${p} ${p === "/about" ? "reads" : "looks"} the same after the seed`, same || sameText, p);
}

// 4. Who may write.
for (const [role, label] of [["editor", "editor"], ["viewer", "viewer"]]) {
    const r = await call("POST", "/api/globals/homepage?draft=false", people[role], { heading: "Hijacked", _status: "published" });
    expect(`${label} can't change the homepage`, r.status === 403, `${r.status} ${r.text}`);
    const c = await call("POST", "/api/pages", people[role], { title: "Nope", slug: "nope", _status: "published" });
    expect(`${label} can't create pages`, c.status === 403, `${c.status}`);
}
expect("the homepage is unchanged", (await page("/")).text.includes("writing down.") && !(await page("/")).text.includes("Hijacked"));

// 5. Homepage: drafts stay private, publishing shows on the next request.
const draft = await call("POST", "/api/globals/homepage?draft=true", people.admin, { heading: "A draft heading", _status: "draft" });
expect("admin saves a homepage draft", draft.status === 200, draft.text);
expect("the draft isn't public", !(await page("/")).text.includes("A draft heading"));
const pub = await call("POST", "/api/globals/homepage?draft=false", people.admin, { heading: "Published <heading>", _status: "published" });
expect("admin publishes the homepage", pub.status === 200, pub.text);
let home = await page("/");
expect("published: on the site straight away, escaped", home.text.includes("Published &lt;heading&gt;") && !home.text.includes("<heading>"));
const bad = await call("POST", "/api/globals/homepage?draft=false", people.admin, { ctaHref: "javascript:alert(1)", _status: "published" });
expect("an unsafe link is refused", bad.status === 400, `${bad.status} ${bad.text}`);
expect("…and the site keeps the last good version", (await page("/")).text.includes("Published &lt;heading&gt;"));

// 6. Settings and menu.
const set = await call("POST", "/api/globals/site-settings", OWNER, { footerText: "Footer from Payload", contact: { heading: "Say g'day" } });
expect("owner updates the site settings", set.status === 200, set.text);
expect("footer and contact page updated", (await page("/")).text.includes("Footer from Payload") && (await page("/contact")).text.includes("Say g&#x27;day"));
const badEmail = await call("POST", "/api/globals/site-settings", OWNER, { email: "nope" });
expect("an invalid email is refused", badEmail.status === 400, `${badEmail.status}`);

// 7. Pages.
const reserved = await call("POST", "/api/pages", people.admin, { title: "Mine", slug: "blog", content: lexical("x"), _status: "published" });
expect("a reserved address (blog) is refused", reserved.status === 400, `${reserved.status} ${reserved.text}`);
const wedding = await call("POST", "/api/pages", people.admin, { title: "Mine", slug: "wedding", _status: "published" });
expect("a reserved address (wedding) is refused", wedding.status === 400, `${wedding.status}`);
const created = await call("POST", "/api/pages?draft=true", people.admin, { title: "Now", slug: "now", lede: "What I'm up to.", content: lexical("Working on <b>things</b>."), _status: "draft" });
const id = created.json?.doc?.id;
expect("admin creates a page draft", created.status === 201 && id, created.text);
expect("the draft isn't public", (await page("/now")).status === 404);
const live = await call("PATCH", `/api/pages/${id}?draft=false`, people.admin, { _status: "published" });
expect("admin publishes it", live.status === 200, live.text);
let now = await page("/now");
expect("published: daly.id.au/now, escaped", now.status === 200 && now.text.includes("Working on &lt;b&gt;things&lt;/b&gt;."), now.status);
expect("it's in the sitemap", (await page("/sitemap.xml")).text.includes("/now</loc>"));
const menu = await call("POST", "/api/globals/navigation", OWNER, {
    items: [
        { label: "Home", type: "url", url: "/" },
        { label: "Now", type: "page", page: id },
        { label: "About", type: "page", page: aboutId },
    ],
});
expect("owner changes the menu", menu.status === 200, menu.text);
home = await page("/");
expect("the menu shows the new page, in order", /href="\/"[\s\S]*href="\/now"[\s\S]*href="\/about"/.test(main(home.text) ?? home.text) && !/>Contact</.test(/<header[\s\S]*<\/header>/.exec(home.text)?.[0] ?? ""));
const renamed = await call("PATCH", `/api/pages/${id}?draft=false`, people.admin, { slug: "lately", _status: "published" });
expect("renaming the page", renamed.status === 200, renamed.text);
const old = await page("/now");
expect("the old address redirects", old.status === 301 && old.location?.endsWith("/lately"), `${old.status} ${old.location}`);
expect("the menu follows the rename", (await page("/")).text.includes('href="/lately"'));
const off = await call("PATCH", `/api/pages/${id}?draft=false`, people.admin, { _status: "draft" });
expect("unpublishing it", off.status === 200 && (await page("/lately")).status === 404, off.status);
expect("…drops it from the menu", !(await page("/")).text.includes('href="/lately"'));
const clash = await call("POST", "/api/pages", people.admin, { title: "Another about", slug: "about", _status: "published" });
expect("another page can't take /about", clash.status === 400, `${clash.status}`);

// 8. Projects (Phase 4): drafts private, publish shows in the preview, the public pages wait for the switch.
for (const role of ["editor", "viewer"]) {
    const r = await call("POST", "/api/projects", people[role], { title: "Nope", slug: "nope", summary: "x", _status: "published" });
    expect(`${role} can't create projects`, r.status === 403, `${r.status}`);
}
const proj = await call("POST", "/api/projects?draft=true", people.admin, { title: "A <b>lamp</b>", slug: "lamp", summary: "It glows.", status: "experimental", content: lexical("Made <by> hand."), _status: "draft" });
const projId = proj.json?.doc?.id;
expect("admin creates a project draft", proj.status === 201 && projId, proj.text);
expect("a draft project isn't in the preview", (await call("GET", "/portal/preview/projects/lamp", OWNER)).status === 404);
const projPub = await call("PATCH", `/api/projects/${projId}?draft=false`, people.admin, { _status: "published" });
expect("admin publishes the project", projPub.status === 200, projPub.text);
const prev = await call("GET", "/portal/preview/projects/lamp", OWNER);
expect("published: the preview shows it, escaped", prev.status === 200 && prev.text.includes("A &lt;b&gt;lamp&lt;/b&gt;") && prev.text.includes("Made &lt;by&gt; hand."), prev.status);
expect("…but /projects isn't public while the switch is off", (await page("/projects/lamp")).status === 404 && (await page("/projects")).status === 404);
expect("…and the live homepage is unchanged", (await page("/")).text.includes("writing down."));
const dup = await call("POST", "/api/projects", people.admin, { title: "Another", slug: "lamp", summary: "x", _status: "published" });
expect("a duplicate project address is refused", dup.status === 400, `${dup.status}`);
const badLink = await call("PATCH", `/api/projects/${projId}?draft=false`, people.admin, { websiteUrl: "javascript:alert(1)", _status: "published" });
expect("an unsafe project link is refused", badLink.status === 400, `${badLink.status}`);
const hidden = await call("PATCH", `/api/projects/${projId}?draft=false`, people.admin, { listed: false, _status: "published" });
expect("unticking 'Show on the public site' takes it off", hidden.status === 200 && (await call("GET", "/portal/preview/projects/lamp", OWNER)).status === 404, hidden.status);
const homeV2 = await call("POST", "/api/globals/homepage?draft=false", OWNER, { projectsHome: { heroTitle: "Things I <make>." }, _status: "published" });
expect("the projects homepage text publishes", homeV2.status === 200 && (await call("GET", "/portal/preview", OWNER)).text.includes("Things I &lt;make&gt;."), homeV2.text);
expect("…without touching the live homepage", (await page("/")).text.includes("writing down.") && !(await page("/")).text.includes("Things I"));
const delProj = await call("DELETE", `/api/projects/${projId}`, OWNER);
expect("the owner deletes the test project", delProj.status === 200, delProj.status);
await call("POST", "/api/globals/homepage?draft=false", OWNER, { projectsHome: { heroTitle: "Building things that interest me." }, _status: "published" });

// 8. Admin view of the wedding module still there.
expect("wedding admin still opens", (await call("GET", "/admin/wedding", OWNER)).status === 200);

// Put the homepage and settings back for later suites.
await call("POST", "/api/globals/homepage?draft=false", OWNER, { heading: "Some things are worth", _status: "published" });
await call("POST", "/api/globals/site-settings", OWNER, { footerText: "", contact: { heading: "Get in touch" } });
await call("POST", "/api/globals/navigation", OWNER, { items: nav.json.items.map(({ id: _id, ...item }) => item) });

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
