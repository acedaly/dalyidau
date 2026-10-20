// Backs up the files Daly Intelligence keeps permanently (Knowledge attachments) and every stored
// Home & Assets photo and document from R2 to this computer, so there's a copy outside Cloudflare. D1 backups (db-backup.mjs) hold the attachment
// rows; this holds the files they point at.
//
//   node scripts/r2-backup.mjs --env production                # download and verify
//   BACKUP_PASSPHRASE=… node scripts/r2-backup.mjs --env production --encrypt
//   BACKUP_PASSPHRASE=… node scripts/r2-backup.mjs --verify backups/r2-production-<time>
//   node scripts/r2-backup.mjs --local --persist-to <dir>      # a local database and bucket (tests)
//
// Read-only on Cloudflare. Writes backups/r2-<env>-<time>/ with one file per attachment (named by
// id, never by its original name), and manifest.json: id, owner, object, size and SHA-256 of each.
// Every file is checked against the size D1 records. With --encrypt each file is sealed with
// AES-256-GCM under a key derived from BACKUP_PASSPHRASE (scrypt); the passphrase is never written
// anywhere, and --verify decrypts every file and checks its hash.
//
// Temporary processing files (recordings, uploads) are deliberately not backed up: they are deleted
// days after processing by design. Files marked to keep are, whatever their purpose.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, Report, d1Query, envFlag, parseArgs, readWranglerConfig, wrangler } from "./lib/ops.mjs";

const args = parseArgs();
const report = new Report();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAGIC = Buffer.from("DALYR2E1");

function keyFor(salt) {
    const passphrase = process.env.BACKUP_PASSPHRASE ?? "";
    if (passphrase.length < 16) throw new Error("Set BACKUP_PASSPHRASE (at least 16 characters) to encrypt or verify an encrypted backup");
    return scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

const seal = (bytes) => {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyFor(salt), iv);
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
};

const open = (sealed) => {
    if (!sealed.subarray(0, 8).equals(MAGIC)) throw new Error("not an encrypted backup file");
    const salt = sealed.subarray(8, 24);
    const iv = sealed.subarray(24, 36);
    const tag = sealed.subarray(36, 52);
    const decipher = createDecipheriv("aes-256-gcm", keyFor(salt), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed.subarray(52)), decipher.final()]);
};

// --- Verify an existing backup ---------------------------------------------------------------------

if (args.verify) {
    const dir = String(args.verify);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    for (const file of manifest.files) {
        try {
            const stored = readFileSync(join(dir, file.path));
            const bytes = manifest.encrypted ? open(stored) : stored;
            report.check(sha256(bytes) === file.sha256 && bytes.length === file.bytes, `${file.id}: intact`, `${file.id}: size or hash differs`);
        } catch (error) {
            report.fail(`${file.id}: ${error.message}`);
        }
    }
    report.info(`${manifest.files.length} file(s) in ${dir}`);
    report.finish();
    process.exit();
}

// --- Back up -----------------------------------------------------------------------------------------

const local = !!args.local;
const env = local ? "local" : (args.env ?? "production");
const source = local ? { remote: false, persistTo: args["persist-to"] } : { remote: true };
const config = readWranglerConfig();
const block = env === "production" || env === "local" ? config : config.env?.[env];
const bucket = (block?.r2_buckets ?? config.r2_buckets ?? []).find((b) => b.binding === "MEDIA")?.bucket_name;
if (!bucket) {
    console.error("No MEDIA bucket in wrangler.jsonc for that environment");
    process.exit(1);
}
const encrypt = !!args.encrypt;
if (encrypt) keyFor(randomBytes(16)); // fail early without a passphrase

const rows = d1Query(
    env,
    `SELECT id, owner_email, object_id, r2_key, bytes, content_type FROM attachments WHERE status <> 'deleted' AND status <> 'uploading' AND (retention = 'permanent' OR keep = 1)
     UNION ALL SELECT id, owner_email, asset_id AS object_id, r2_key, bytes, content_type FROM asset_files WHERE status = 'stored'
     UNION ALL SELECT id, email AS owner_email, id AS object_id, object_key AS r2_key, NULL AS bytes, 'application/json' AS content_type FROM ic_reports
     ORDER BY id`,
    source,
)[0];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(ROOT, "backups", `r2-${env}-${stamp}`);
mkdirSync(out, { recursive: true, mode: 0o700 });
chmodSync(join(ROOT, "backups"), 0o700);
// Photo previews (thumb_key) aren't copied: they're made from the photo and can be made again.
console.log(
    `Backing up ${rows.length} permanent attachment(s), asset file(s) and situation report(s) from ${bucket} to ${out}${encrypt ? " (encrypted)" : ""}\n`,
);

const files = [];
for (const row of rows) {
    const tmp = join(out, `${row.id}.download`);
    const get = ["r2", "object", "get", `${bucket}/${row.r2_key}`, "--file", tmp, local ? "--local" : "--remote"];
    if (local && args["persist-to"]) get.push("--persist-to", String(args["persist-to"]));
    if (!local) get.push(envFlag(env).replace(/"/g, ""));
    const result = wrangler(get, { quiet: true });
    if (!result.ok || !existsSync(tmp)) {
        report.fail(`${row.id}: couldn't download (${(result.stderr.split("\n").find((l) => l.trim()) ?? "wrangler error").trim()})`);
        continue;
    }
    const bytes = readFileSync(tmp);
    rmSync(tmp);
    // Reports don't record their size in D1; every other file must match the size D1 holds.
    if (row.bytes !== null && bytes.length !== Number(row.bytes)) {
        report.fail(`${row.id}: ${bytes.length} bytes, D1 says ${row.bytes}`);
        continue;
    }
    const path = `${row.id}${encrypt ? ".enc" : ".bin"}`;
    writeFileSync(join(out, path), encrypt ? seal(bytes) : bytes, { mode: 0o600 });
    files.push({
        id: row.id,
        path,
        owner: row.owner_email,
        objectId: row.object_id,
        contentType: row.content_type,
        bytes: bytes.length,
        sha256: sha256(bytes),
    });
    report.pass(`${row.id}: ${bytes.length} bytes`);
}
writeFileSync(
    join(out, "manifest.json"),
    JSON.stringify({ format: "daly.r2-backup.v1", env, bucket, createdAt: new Date().toISOString(), encrypted: encrypt, files }, null, 2),
    { mode: 0o600 },
);

// Prove it: read every file back (decrypting when encrypted) and compare hashes.
for (const file of files) {
    const stored = readFileSync(join(out, file.path));
    const bytes = encrypt ? open(stored) : stored;
    report.check(sha256(bytes) === file.sha256, `${file.id}: verified`, `${file.id}: verification failed`);
}
report.info(`Manifest: ${join(out, "manifest.json")}. Keep it with the D1 backup from the same time; copy the folder somewhere off this computer.`);
if (!readdirSync(out).length) rmSync(out, { recursive: true });
report.finish();
