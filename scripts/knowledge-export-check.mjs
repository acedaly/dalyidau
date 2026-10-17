// Checks a downloaded Daly Knowledge export (.zip or .json) without touching any database:
//
//   node scripts/knowledge-export-check.mjs ~/Downloads/my-knowledge-2026-10-17.zip
//
// Verifies the ZIP's checksums and entry names, the manifest's format and version, that every
// reference resolves, and that each object has its Markdown file. Prints counts only, never contents.
// The full round trip (export, restore into an empty database, export again, compare) is
// test/knowledge-export.test.ts.
import { readFileSync } from "node:fs";
import { checkManifest, checkZip, summarise } from "./lib/knowledge-export-check.mjs";
import { Report } from "./lib/ops.mjs";

const file = process.argv[2];
if (!file) {
    console.error("Usage: node scripts/knowledge-export-check.mjs <export.zip|export.json>");
    process.exit(1);
}
const report = new Report();
const bytes = readFileSync(file);
let manifest;
let problems;
if (file.endsWith(".zip")) {
    ({ manifest, problems } = checkZip(bytes));
    report.check(!!manifest, "The ZIP opens and every checksum matches", "The ZIP has no manifest.json");
} else {
    manifest = JSON.parse(bytes.toString("utf8"));
    problems = checkManifest(manifest);
}
report.check(problems.length === 0, "The export is consistent: every reference resolves", `Problems: ${problems.slice(0, 5).join("; ")}`);
if (manifest?.objects) report.info(JSON.stringify(summarise(manifest)));
report.finish();
