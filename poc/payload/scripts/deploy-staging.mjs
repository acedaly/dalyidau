// The only way to deploy from this folder: the isolated staging Worker, with the isolation checks made
// mandatory around it. There is deliberately no production deploy here (that needs separate approval).
//
//   node scripts/deploy-staging.mjs [--secrets-file path]   (or: npm run staging:deploy)
//   node scripts/deploy-staging.mjs --baseline              # today's Worker alone, for cutover/rollback rehearsals
//
// Why not plain `wrangler deploy`: in a Next.js folder Wrangler hands the deploy to `opennextjs-cloudflare
// deploy`, which loads .dev.vars (and .env*) into the deploy process's own environment. Wrangler never
// uploads those as Worker secrets, but a CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / WRANGLER_* value
// in one of them would silently change which account or credentials the deploy uses. So this:
//   1. refuses if any .dev.vars* or .env* file sets a Cloudflare or Wrangler variable;
//   2. runs check-staging.mjs (config) and refuses on any problem;
//   3. runs `wrangler deploy --env staging` directly (OPEN_NEXT_DEPLOY=true skips OpenNext's wrapper),
//      with a clean environment: only what Wrangler needs from this shell, never anything from those files;
//   4. runs check-staging.mjs --online (deployed secret names) and fails loudly if anything is off.
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const here = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.some((a) => a === "--env" || a.startsWith("--env="))) throw new Error("This script deploys staging only; don't pass --env.");
const secretsIndex = args.indexOf("--secrets-file");
const secretsFile = secretsIndex >= 0 ? args[secretsIndex + 1] : null;
// Rehearsals only: today's Worker without Payload (still behind the outbound lock), as production runs now.
const baseline = args.includes("--baseline");

// 1. Local env files must not be able to redirect the deploy.
const DANGEROUS = /^\s*(?:export\s+)?(CLOUDFLARE_[A-Z_]*|CF_[A-Z_]*|WRANGLER_[A-Z_]*|OPEN_NEXT_[A-Z_]*)\s*=/m;
for (const name of readdirSync(here).filter((f) => /^\.dev\.vars|^\.env/.test(f))) {
    const match = readFileSync(path.join(here, name), "utf8").match(DANGEROUS);
    if (match) throw new Error(`${name} sets ${match[1]}: remove it before deploying (it could change the account or credentials used).`);
}

// 2. Isolation, before.
const run = (cmd, argv, env = process.env) => {
    const result = spawnSync(cmd, argv, { cwd: here, stdio: "inherit", env });
    if (result.status !== 0) {
        console.error(`\n${cmd} ${argv.join(" ")} failed (${result.status}). Nothing more was done.`);
        process.exit(result.status ?? 1);
    }
};
run("node", ["scripts/check-staging.mjs"]);

// 3. Deploy, with only the environment Wrangler needs.
const KEEP = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM", "NODE_OPTIONS", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "XDG_CONFIG_HOME"];
const env = Object.fromEntries(KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
env.OPEN_NEXT_DEPLOY = "true";
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
run(
    "npx",
    [
        "wrangler", "deploy", "--env", "staging",
        ...(baseline ? ["platform/entry-legacy-baseline.ts"] : []),
        "--message", `staging ${sha}${baseline ? " baseline (no Payload)" : ""}`,
        ...(secretsFile ? ["--secrets-file", secretsFile] : []),
    ],
    env,
);

// 4. Isolation, after (includes the deployed secret names).
run("node", ["scripts/check-staging.mjs", "--online"]);
console.log("\nStaging deployed and re-checked.");
