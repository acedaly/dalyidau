// Reads .poc-results/cpu-windows.txt (from measure-cpu.sh) and prints Cloudflare's CPU-time percentiles
// for each window of the staging Worker. Read-only Workers analytics; uses Wrangler's own sign-in.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "9fd9c764b89b09bcc55f18ed1429781a";
const token = execFileSync("npx", ["wrangler", "auth", "token"], { encoding: "utf8" }).trim().split("\n").pop();
const windows = readFileSync(".poc-results/cpu-windows.txt", "utf8").trim().split("\n").map((l) => l.split(" "));
const from = windows[0][1];
const to = new Date(Date.parse(windows.at(-1)[1]) + 60_000).toISOString();
const query = `query { viewer { accounts(filter:{accountTag:"${ACCOUNT}"}) { workersInvocationsAdaptive(limit: 100,
  filter:{scriptName:"dalyidau-payload-staging", datetime_geq:"${from}", datetime_lt:"${to}"}) {
  sum { requests } quantiles { cpuTimeP50 cpuTimeP90 cpuTimeP99 } dimensions { datetimeMinute status } } } } }`;
const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
});
const body = await response.json();
if (body.errors) throw new Error(JSON.stringify(body.errors));
const rows = body.data.viewer.accounts[0].workersInvocationsAdaptive;
const ms = (us) => (us / 1000).toFixed(1);
for (const [label, minute] of windows) {
    const row = rows.filter((r) => r.dimensions.datetimeMinute === minute && r.dimensions.status === "success");
    if (!row.length) {
        console.log(`${label.padEnd(24)} ${minute}  (no data yet)`);
        continue;
    }
    const r = row[0];
    console.log(`${label.padEnd(24)} requests ${String(r.sum.requests).padStart(3)}   CPU p50 ${ms(r.quantiles.cpuTimeP50).padStart(5)} ms   p90 ${ms(r.quantiles.cpuTimeP90).padStart(5)} ms   p99 ${ms(r.quantiles.cpuTimeP99).padStart(5)} ms`);
}
