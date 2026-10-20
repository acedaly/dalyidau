// Builds the Intelligence Centre's detailed basemap (docs/INTELLIGENCE_CENTRE_9_1.md#detailed-basemap):
// a bounded extract of the Protomaps OpenStreetMap build for NSW, the ACT and a margin, as one
// PMTiles file, and prints the command to upload it to R2. It never uploads anything itself.
//
//   node scripts/centre-basemap.mjs [--maxzoom 13] [--build 20261019] [--out migration-work/basemap.pmtiles] [--dry-run]
//
// Needs the go-pmtiles CLI on PATH (https://github.com/protomaps/go-pmtiles/releases). Measured on
// 19 October 2026 for this extent: zoom 12 ≈ 100 MB, 13 ≈ 210 MB, 14 ≈ 419 MB, 15 ≈ 878 MB.
// Wrangler uploads objects up to 315 MB; above that use rclone or another S3-compatible client.
// The data is © OpenStreetMap contributors under the ODbL: keep the attribution the maps show.
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./lib/ops.mjs";

const args = Object.fromEntries(
    process.argv
        .slice(2)
        .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []),
);
const BBOX = "140.5,-38.0,154.0,-27.8"; // NSW and the ACT, with a margin
const KEY = "private/centre/basemap/basemap.pmtiles"; // worker/centre/basemap.ts
const maxzoom = Number(args.maxzoom ?? 13);
if (!Number.isInteger(maxzoom) || maxzoom < 8 || maxzoom > 15) {
    console.error("--maxzoom is 8 to 15");
    process.exit(1);
}
const out = join(ROOT, String(args.out ?? "migration-work/basemap.pmtiles"));

let build = args.build;
if (!build) {
    const builds = await (await fetch("https://build-metadata.protomaps.dev/builds.json")).json();
    build = builds.at(-1).key.replace(/\.pmtiles$/, "");
}
const source = `https://build.protomaps.com/${build}.pmtiles`;
const which = spawnSync("pmtiles", ["version"], { encoding: "utf8" });
if (which.status !== 0) {
    console.error("The pmtiles CLI isn't on PATH: download it from https://github.com/protomaps/go-pmtiles/releases");
    process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
const run = spawnSync("pmtiles", ["extract", source, out, `--bbox=${BBOX}`, `--maxzoom=${maxzoom}`, ...(args["dry-run"] ? ["--dry-run"] : [])], {
    stdio: "inherit",
});
if (run.status !== 0) process.exit(run.status ?? 1);
if (args["dry-run"]) process.exit(0);
const mb = statSync(out).size / 1_000_000;
console.log(`\nWrote ${out} (${mb.toFixed(0)} MB) from Protomaps build ${build}, zoom 0–${maxzoom}.`);
console.log("\nUpload it (owner only, after approval), then choose Detailed in Intelligence Centre → Settings:");
if (mb < 300) console.log(`  npx wrangler r2 object put <MEDIA bucket>/${KEY} --file ${out} --content-type application/vnd.pmtiles --remote`);
else console.log(`  rclone copyto ${out} r2:<MEDIA bucket>/${KEY}   (Wrangler's limit is 315 MB)`);
console.log("For local development: the same wrangler command with --local instead of --remote.");
