// Copies every object in an R2 bucket to this computer and proves the copy is complete.
//
//   node scripts/r2-bucket-backup.mjs dalyidau-media              # → backups/r2-bucket-dalyidau-media-<time>/
//   node scripts/r2-bucket-backup.mjs --verify backups/r2-bucket-…  # re-hash every file against the manifest
//
// Read-only on Cloudflare: it lists the bucket through the Cloudflare API (with Wrangler's own sign-in)
// and downloads each object with `wrangler r2 object get --remote`. Each file is checked against the
// size R2 reports, and manifest.json records key, size, etag and SHA-256. Files are stored under a
// hash of the key (keys can contain slashes and odd characters); the manifest maps them back.
//
// The bucket holds blog media and wedding uploads, so backups/ stays owner-only (0700/0600) and
// git-ignored, like the D1 backups.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "9fd9c764b89b09bcc55f18ed1429781a";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileName = (key) => createHash("sha256").update(key).digest("hex").slice(0, 32);

function verify(dir) {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    let bad = 0;
    for (const o of manifest.objects) {
        const path = join(dir, "objects", o.file);
        if (!existsSync(path) || sha256(readFileSync(path)) !== o.sha256 || statSync(path).size !== o.size) {
            console.error(`✗ ${o.key}`);
            bad++;
        }
    }
    console.log(bad ? `✗ ${bad} of ${manifest.objects.length} objects failed` : `✓ ${manifest.objects.length} objects verified (${manifest.bytes} bytes)`);
    return bad === 0;
}

function token() {
    const r = spawnSync("npx", ["wrangler", "auth", "token", "--json"], { cwd: ROOT, encoding: "utf8" });
    if (r.status !== 0) throw new Error("wrangler auth token failed (is Wrangler signed in?)");
    return JSON.parse(r.stdout).token;
}

async function list(bucket, auth) {
    const objects = [];
    let cursor;
    do {
        const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${bucket}/objects`);
        url.searchParams.set("per_page", "1000");
        if (cursor) url.searchParams.set("cursor", cursor);
        const res = await fetch(url, { headers: { authorization: `Bearer ${auth}` } });
        const body = await res.json();
        if (!body.success) throw new Error(`listing failed: ${JSON.stringify(body.errors)}`);
        objects.push(...body.result);
        cursor = body.result_info?.is_truncated ? body.result_info.cursor : undefined;
    } while (cursor);
    return objects;
}

async function backup(bucket) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = join(ROOT, "backups");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    chmodSync(base, 0o700);
    const dir = join(base, `r2-bucket-${bucket}-${stamp}`);
    mkdirSync(join(dir, "objects"), { recursive: true, mode: 0o700 });
    const objects = await list(bucket, token());
    const out = [];
    let bytes = 0;
    for (const o of objects) {
        const file = fileName(o.key);
        const path = join(dir, "objects", file);
        const r = spawnSync("npx", ["wrangler", "r2", "object", "get", `${bucket}/${o.key}`, "--remote", "--file", path], { cwd: ROOT, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`download failed: ${o.key}\n${r.stderr}`);
        chmodSync(path, 0o600);
        const data = readFileSync(path);
        if (data.length !== o.size) throw new Error(`size mismatch: ${o.key} (${data.length} ≠ ${o.size})`);
        bytes += data.length;
        out.push({ key: o.key, file, size: o.size, etag: o.etag, uploaded: o.last_modified, sha256: sha256(data) });
        process.stdout.write(".");
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ bucket, takenAt: new Date().toISOString(), bytes, objects: out }, null, 2), { mode: 0o600 });
    console.log(`\nbacked up ${out.length} objects (${bytes} bytes) to ${dir}`);
    if (!verify(dir)) process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === "--verify") process.exit(verify(args[1]) ? 0 : 1);
if (!args[0]) {
    console.error("usage: r2-bucket-backup.mjs <bucket> | --verify <dir>");
    process.exit(2);
}
await backup(args[0]);
