// Inventory of everything Capacities published, read from Cloudflare only (docs/CAPACITIES_RETIREMENT.md):
// every article, the images it shows, the old addresses that redirect to it, and whether the
// archive (capacities_archive) holds a matching copy. Never calls Capacities.
//
//   node scripts/capacities-inventory.mjs --env production             # list and check
//   node scripts/capacities-inventory.mjs --env production --download  # also copy every image here
//   node scripts/capacities-inventory.mjs --local --persist-to <dir>   # a local database and bucket
//
// Read-only on Cloudflare. Writes migration-work/capacities-<env>-<time>/ (git-ignored: it holds
// real article titles): inventory.json, and with --download one file per image plus its SHA-256.
// Exits non-zero if any image is missing from R2 or any article isn't archived.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, Report, d1Query, envFlag, parseArgs, readWranglerConfig, wrangler } from "./lib/ops.mjs";

const args = parseArgs();
const local = !!args.local;
const env = local ? "local" : String(args.env ?? "production");
const source = local ? { remote: false, persistTo: args["persist-to"] ? String(args["persist-to"]) : undefined } : {};
const report = new Report();
const config = readWranglerConfig();
const bucket = (env === "production" || local ? config : config.env?.[env])?.r2_buckets?.find((b) => b.binding === "MEDIA")?.bucket_name;
if (!bucket) throw new Error(`No MEDIA bucket configured for ${env}`);

const [posts] = d1Query(
    env,
    "SELECT id, slug, title, published_at, category, tags, image_key, body_html, content_hash FROM posts WHERE source = 'capacities' ORDER BY published_at",
    source,
);
const [redirects] = d1Query(env, "SELECT from_slug, post_id FROM slug_redirects", source);
let archive = [];
try {
    [archive] = d1Query(env, "SELECT id, slug, content_hash, archived_at, replaced_by FROM capacities_archive", source);
} catch {
    report.warn("capacities_archive doesn't exist yet: apply migration 0029 first");
}
const archived = new Map(archive.map((a) => [a.id, a]));
const mediaKeys = (p) => [
    ...new Set([...(p.image_key ? [p.image_key] : []), ...[...p.body_html.matchAll(/\/media\/([a-f0-9]{24}\.(?:jpg|png|gif|webp|avif))/g)].map((m) => m[1])]),
];

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(ROOT, "migration-work", `capacities-${env}-${stamp}`);
mkdirSync(join(out, "media"), { recursive: true, mode: 0o700 });

const images = new Map();
const articles = posts.map((p) => {
    const keys = mediaKeys(p);
    for (const key of keys) images.set(key, null);
    const copy = archived.get(p.id);
    return {
        id: p.id,
        slug: p.slug,
        title: p.title,
        publishedAt: p.published_at,
        category: p.category,
        tags: JSON.parse(p.tags),
        redirectsFrom: redirects.filter((r) => r.post_id === p.id).map((r) => r.from_slug),
        images: keys,
        archive: !copy ? "none" : copy.content_hash === p.content_hash ? "current" : "outdated",
    };
});

console.log(`${articles.length} Capacities article(s), ${images.size} image(s) in ${bucket}\n`);
for (const key of images.keys()) {
    // Downloading is the only check wrangler offers; without --download the copy is discarded.
    const tmp = join(out, "media", `${key}.download`);
    const get = ["r2", "object", "get", `${bucket}/${key}`, "--file", tmp, local ? "--local" : "--remote"];
    if (local && args["persist-to"]) get.push("--persist-to", String(args["persist-to"]));
    if (!local) get.push(envFlag(env).replace(/"/g, ""));
    const result = wrangler(get, { quiet: true });
    if (!result.ok || !existsSync(tmp)) {
        report.fail(`/media/${key} is missing from R2`);
        continue;
    }
    const bytes = readFileSync(tmp);
    images.set(key, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    if (args.download) renameSync(tmp, join(out, "media", key));
    else rmSync(tmp);
}
for (const a of articles) {
    if (a.archive === "current") report.pass(`/blog/${a.slug}: archived, ${a.images.length} image(s), ${a.redirectsFrom.length} old address(es)`);
    else report.fail(`/blog/${a.slug}: archive ${a.archive} (run Check and archive in Portal settings → Website & Blog)`);
}
const moved = archive.filter((a) => a.replaced_by);
if (moved.length) console.log(`\n${moved.length} article(s) moved to Amplenote at the same address: ${moved.map((m) => `/blog/${m.slug}`).join(", ")}`);

writeFileSync(
    join(out, "inventory.json"),
    JSON.stringify({ env, at: new Date().toISOString(), bucket, articles, images: Object.fromEntries(images), moved }, null, 2),
    { mode: 0o600 },
);
console.log(`\nWrote ${join(out, "inventory.json")}${args.download ? " and the images" : ""}`);
report.finish();
