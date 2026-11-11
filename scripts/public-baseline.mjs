// Records what the public site serves, so a deploy can be checked against it.
//
//   node scripts/public-baseline.mjs capture <dir> [--origin https://daly.id.au]
//   node scripts/public-baseline.mjs compare <before-dir> <after-dir>
//
// Captures every URL in the sitemap plus the feeds, robots.txt, the blog's images and the public
// wedding pages: status, content type, redirect, and for HTML the SEO surface (title, description,
// canonical, robots, Open Graph, Twitter, JSON-LD) and a hash of the visible article/main text.
// `compare` exits 1 if any URL's status, type, SEO fields or main text changed. Asset fingerprints
// and CSP nonces are ignored (they change on every build).
//
// Only public, unauthenticated GETs. Admin/portal paths are checked separately (they must redirect
// to Access or refuse).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
};

const EXTRA = ["/rss.xml", "/feed.xml", "/sitemap.xml", "/robots.txt", "/blog", "/about", "/contact", "/does-not-exist-404"];
const WEDDING = ["https://wedding.daly.id.au/", "https://wedding.daly.id.au/admin", "https://wedding.daly.id.au/robots.txt"];
const PRIVATE = ["/portal", "/portal/wedding", "/admin", "/admin/wedding", "/admin/collections/posts", "/api/users", "/api/posts", "/api/media", "/api/pages", "/api/projects", "/api/globals/site-settings", "/api/globals/homepage", "/admin/globals/homepage", "/api/payload-preferences", "/api/platform/wedding-page", "/api/portal/wedding/guests"];

function attr(html, re) {
    return [...html.matchAll(re)].map((m) => m[1].replace(/&amp;/g, "&")).sort();
}

function seo(html) {
    const meta = {};
    for (const m of html.matchAll(/<meta\s+([^>]+)>/gi)) {
        const name = /(?:name|property)="([^"]+)"/i.exec(m[1])?.[1];
        const content = /content="([^"]*)"/i.exec(m[1])?.[1];
        if (name && content !== undefined && !/^(viewport|theme-color|color-scheme)$/i.test(name)) meta[name] = content;
    }
    const main = /<(article|main)[\s>][\s\S]*?<\/\1>/i.exec(html)?.[0] ?? "";
    const text = main.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return {
        title: /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null,
        canonical: /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i.exec(html)?.[1] ?? null,
        alternates: attr(html, /<link[^>]+rel="alternate"[^>]+href="([^"]+)"/gi),
        meta,
        jsonLd: attr(html, /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi).map((s) => sha(s)),
        h1: attr(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi).map((s) => s.replace(/<[^>]+>/g, "").trim()),
        images: attr(html, /<img[^>]+src="([^"]+)"/gi).filter((s) => !/\/assets\/[^/]+-[A-Za-z0-9_-]{8}\./.test(s)),
        mainText: sha(text),
        mainLength: text.length,
    };
}

async function get(url) {
    const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "daly-public-baseline/1" } });
    const type = res.headers.get("content-type") ?? "";
    const body = /text|xml|json/.test(type) ? await res.text() : Buffer.from(await res.arrayBuffer());
    const location = res.headers.get("location");
    const entry = { url, status: res.status, type: type.split(";")[0], location: location?.replace(/\?.*$/, "") ?? null };
    if (typeof body === "string") {
        if (type.includes("html")) Object.assign(entry, seo(body));
        else entry.body = sha(body.replace(/<lastBuildDate>.*?<\/lastBuildDate>/, ""));
    } else entry.body = sha(body);
    return { entry, body };
}

async function capture(dir, origin) {
    mkdirSync(dir, { recursive: true });
    const sitemap = await (await fetch(`${origin}/sitemap.xml`)).text();
    const paths = new Set([...attr(sitemap, /<loc>([^<]+)<\/loc>/g).map((u) => new URL(u).pathname), ...EXTRA]);
    const results = [];
    for (const p of paths) {
        const { entry, body } = await get(origin + p);
        results.push(entry);
        if (typeof body === "string" && entry.type?.includes("html")) for (const img of entry.images) if (img.startsWith("/")) paths.add(img);
    }
    for (const u of WEDDING) results.push((await get(u)).entry);
    for (const p of PRIVATE) results.push({ ...(await get(origin + p)).entry, private: true });
    results.sort((a, b) => a.url.localeCompare(b.url));
    writeFileSync(join(dir, "baseline.json"), JSON.stringify({ origin, takenAt: new Date().toISOString(), results }, null, 2));
    console.log(`captured ${results.length} URLs to ${dir}/baseline.json`);
    for (const r of results.filter((r) => r.private)) {
        const ok = r.status === 404 || r.status === 401 || r.status === 403 || (r.status === 302 && /cloudflareaccess\.com/.test(r.location ?? ""));
        console.log(`${ok ? "✓" : "✗"} private ${r.url} → ${r.status} ${r.location ?? ""}`);
        if (!ok) process.exitCode = 1;
    }
}

function compare(a, b) {
    const before = JSON.parse(readFileSync(join(a, "baseline.json"), "utf8")).results;
    const after = new Map(JSON.parse(readFileSync(join(b, "baseline.json"), "utf8")).results.map((r) => [r.url, r]));
    let changed = 0;
    for (const r of before) {
        const n = after.get(r.url);
        const x = JSON.stringify({ ...r, private: undefined });
        const y = n && JSON.stringify({ ...n, private: undefined });
        if (x !== y) {
            changed++;
            console.log(`✗ ${r.url}`);
            for (const k of new Set([...Object.keys(r), ...Object.keys(n ?? {})]))
                if (JSON.stringify(r[k]) !== JSON.stringify(n?.[k])) console.log(`    ${k}: ${JSON.stringify(r[k])} → ${JSON.stringify(n?.[k])}`);
        }
    }
    console.log(changed ? `${changed} of ${before.length} URLs changed` : `✓ all ${before.length} URLs unchanged`);
    process.exitCode = changed ? 1 : 0;
}

if (args[0] === "capture") await capture(args[1], flag("--origin", "https://daly.id.au"));
else if (args[0] === "compare") compare(args[1], args[2]);
else {
    console.error("usage: capture <dir> [--origin …] | compare <before> <after>");
    process.exit(2);
}
