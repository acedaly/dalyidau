# Deployment

## Cloudflare resources

Everything for this site is separate from DalyHub. Nothing below touches `dalyhub-*` Workers, the `dalyhub-v2` D1 database or the `dalyhub-v2-*` R2 buckets.

Production is the only environment: the staging environment (its Worker, D1 database, R2 bucket and Vectorize indexes) was removed on 9 Nov 2026 ([DECOMMISSION_PORTAL_APPS.md](DECOMMISSION_PORTAL_APPS.md)).

| Resource    | Production                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker      | `dalyidau`                                                                                                                                                      |
| D1 database | `dalyidau-production` (`a003fec1-8404-4468-a23f-de5fb202bc57`)                                                                                                  |
| R2 bucket   | `dalyidau-media`                                                                                                                                                |
| Cron        | `*/15 * * * *` (the Capacities sync while it's switched on, and scheduled wedding messages)                                                                     |
| Hostnames   | `daly.id.au`, `www.daly.id.au`, `wedding.daly.id.au`, `weddingplanner.daly.id.au` (Custom Domains; `workers_dev` is off, so there's no `*.workers.dev` address) |

The D1 database and R2 bucket already exist (created 11 October 2026). Local development uses Miniflare's local D1/R2 and never touches production.

Only the production Worker on `daly.id.au` is indexable; other hosts (local development, previews) send `noindex` and a disallow-all `robots.txt`.

## One-time setup

### 1. Cloudflare API token for GitHub Actions

Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template, then make sure it has:

- Account → Workers Scripts: Edit
- Account → D1: Edit
- Account → Workers R2 Storage: Edit
- Account → Account Settings: Read
- Zone `daly.id.au` → Workers Routes: Edit (needed for the custom-domain cut-over)
- User → User Details: Read

Limit it to your account and the `daly.id.au` zone.

### 2. GitHub repository secrets

Settings → Secrets and variables → Actions:

| Secret                  | Value                                    |
| ----------------------- | ---------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Token from step 1                        |
| `CLOUDFLARE_ACCOUNT_ID` | Dashboard → Workers & Pages → Account ID |

Also create a GitHub environment named `production` (Settings → Environments). Add required reviewers to it if you want a manual approval gate.

### 3. First deploy

Merge to `main` (or run the Deploy workflow manually). The workflow typechecks, runs unit, integration and E2E tests, applies D1 migrations, then deploys.

### 4. Worker secrets

After the first deploy:

```bash
npx wrangler secret put CAPACITIES_API_TOKEN --env=""   # read-only Capacities token
npx wrangler secret put ADMIN_TOKEN --env=""            # any random string, 24+ characters
# e.g. openssl rand -base64 32
```

Until `CAPACITIES_API_TOKEN` is set, each cron run logs "CAPACITIES_API_TOKEN is not set; nothing was changed" and the site shows its empty states.

Check it works at `https://daly.id.au/api/health`, then run a manual sync ([OPERATIONS.md](OPERATIONS.md)).

## DNS cut-over (done 11 October 2026)

`daly.id.au`, `www.daly.id.au` and `wedding.daly.id.au` are declared as Custom Domains on the `dalyidau` Worker in `wrangler.jsonc`. Cloudflare manages their DNS records and certificates after an approved deploy. The Worker 301s `www` to the apex and legacy `/wedding` URLs to the wedding hostname while preserving their query string. The wedding hostname deliberately refuses portal, admin and communication-webhook routes.

The configuration change does not activate itself from this feature branch: do not run `wrangler deploy` or apply migration `0008_invitation_studio.sql` remotely until the pull request and production migration are explicitly approved.

**Records removed (the only DNS change):**

| Name             | Type | Value             | Proxied | Was used by                            |
| ---------------- | ---- | ----------------- | ------- | -------------------------------------- |
| `daly.id.au`     | A    | `103.168.172.37`  | No      | Fastmail-hosted homepage               |
| `daly.id.au`     | A    | `103.168.172.52`  | No      | Fastmail-hosted homepage               |
| `www.daly.id.au` | A    | `110.232.143.111` | Yes     | Old cPanel host serving a default page |

**Left alone:** the `*.daly.id.au` wildcard (Fastmail IPs, also what `my.daly.id.au` in the SPF record resolves through), `mail`, MX, SPF, DKIM (`fm1`–`fm3`), DMARC, the Fastmail SRV records, `hub.daly.id.au` and `mcp.daly.id.au` (DalyHub Workers) and every other subdomain.

**Undo the cut-over:** remove the two Custom Domains (Workers & Pages → dalyidau → Settings → Domains & Routes), comment out the `routes` block, then recreate the three records above.

## Rollback

| Problem              | Fix                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bad code deploy      | `npx wrangler deployments list --env=""`, then `npx wrangler rollback <version-id> --env=""`. Or Dashboard → Workers & Pages → dalyidau → Deployments → Rollback. Or revert the commit on `main`.                                                                                                                                                                                             |
| Bad content          | Fix it in Capacities (with Capacities sync on, the next run republishes it), or set its Status to anything but Published ([CAPACITIES.md](CAPACITIES.md)). Articles published earlier from Amplenote can only be changed in D1.                                                                                                                                                               |
| Damaged database     | D1 Time Travel keeps 30 days: `npx wrangler d1 time-travel info dalyidau-production`, then `npx wrangler d1 time-travel restore dalyidau-production --timestamp=<ISO time>`                                                                                                                                                                                                                   |
| Rebuild from scratch | Articles can be rebuilt from Capacities by a sync while it holds them; otherwise, and for the articles published from Amplenote, they exist **only in D1 and R2**: restore them from a backup (`npm run db:backup`, `npm run capacities:inventory -- --download`). **Wedding portal data exists only in D1**: restore it from Time Travel or a backup ([DATABASE.md](DATABASE.md#restoring)). |

Migrations are forward-only. Add new files to `migrations/` and they apply before each deploy, after a restore point is logged and before the code goes out; see [DATABASE.md](DATABASE.md).
