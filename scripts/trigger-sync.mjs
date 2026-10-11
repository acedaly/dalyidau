// Runs an authenticated manual sync: node scripts/trigger-sync.mjs <site-url> [--force]
// Reads ADMIN_TOKEN from the environment (or .dev.vars for local use).
import { readFileSync } from "node:fs";

const [site = "http://localhost:8787", flag] = process.argv.slice(2);
let token = process.env.ADMIN_TOKEN;
if (!token) {
    try {
        token = /^ADMIN_TOKEN=(.*)$/m.exec(readFileSync(".dev.vars", "utf8"))?.[1]?.trim();
    } catch {
        // No .dev.vars
    }
}
if (!token) {
    console.error("Set ADMIN_TOKEN (the same value as the Worker secret).");
    process.exit(1);
}

const url = new URL("/api/admin/sync", site);
if (flag === "--force") url.searchParams.set("force", "1");
const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
const body = await response.text();
console.log(`HTTP ${response.status}`);
console.log(body);
process.exit(response.ok ? 0 : 1);
