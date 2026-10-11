# Deployment

## Cloudflare resources

Everything for this site is separate from DalyHub. Nothing below touches `dalyhub-*` Workers, the `dalyhub-v2` D1 database or the `dalyhub-v2-*` R2 buckets.

| Resource | Production | Staging |
| --- | --- | --- |
| Worker | `dalyidau` | `dalyidau-staging` |
| D1 database | `dalyidau-production` (`a003fec1-8404-4468-a23f-de5fb202bc57`) | `dalyidau-staging` (`a88696eb-3621-4dcb-ac9f-a907a9cd9c06`) |
| R2 bucket | `dalyidau-media` | `dalyidau-media-staging` |
| Cron | `*/15 * * * *` | none (sync manually) |
| Hostname | `daly.id.au` (after cut-over), `dalyidau.<account>.workers.dev` | `dalyidau-staging.<account>.workers.dev` |

The D1 databases and R2 buckets already exist (created 11 October 2026). The Workers are created on the first deploy. Local development uses Miniflare's local D1/R2 and never touches either environment.

Only the production Worker on `daly.id.au` is indexable. workers.dev hosts and staging send `noindex` and a disallow-all `robots.txt`.

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

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | Dashboard → Workers & Pages → Account ID |

Also create GitHub environments named `production` and `staging` (Settings → Environments). Add required reviewers to `production` if you want a manual approval gate.

### 3. First deploy

Merge to `main` (or run the Deploy workflow manually). The workflow typechecks, runs unit, integration and E2E tests, applies D1 migrations, then deploys.

### 4. Worker secrets

After the first deploy:

```bash
npx wrangler secret put CAPACITIES_API_TOKEN --env=""   # read-only Capacities token
npx wrangler secret put ADMIN_TOKEN --env=""            # any random string, 24+ characters
# e.g. openssl rand -base64 32

# Staging, if used:
npx wrangler secret put CAPACITIES_API_TOKEN --env staging
npx wrangler secret put ADMIN_TOKEN --env staging
```

Until `CAPACITIES_API_TOKEN` is set, each cron run logs "CAPACITIES_API_TOKEN is not set; nothing was changed" and the site shows its empty states.

Check it works at `https://dalyidau.<account>.workers.dev`, then run a manual sync ([OPERATIONS.md](OPERATIONS.md)).

## DNS cut-over (done 11 October 2026)

`daly.id.au` and `www.daly.id.au` are Custom Domains on the `dalyidau` Worker, declared in the `routes` block of `wrangler.jsonc`. Cloudflare manages their DNS records and certificates. The Worker 301s `www` to the apex.

**Records removed (the only DNS change):**

| Name | Type | Value | Proxied | Was used by |
| --- | --- | --- | --- | --- |
| `daly.id.au` | A | `103.168.172.37` | No | Fastmail-hosted homepage |
| `daly.id.au` | A | `103.168.172.52` | No | Fastmail-hosted homepage |
| `www.daly.id.au` | A | `110.232.143.111` | Yes | Old cPanel host serving a default page |

**Left alone:** the `*.daly.id.au` wildcard (Fastmail IPs, also what `my.daly.id.au` in the SPF record resolves through), `mail`, MX, SPF, DKIM (`fm1`–`fm3`), DMARC, the Fastmail SRV records, `hub.daly.id.au` and `mcp.daly.id.au` (DalyHub Workers) and every other subdomain.

**Undo the cut-over:** remove the two Custom Domains (Workers & Pages → dalyidau → Settings → Domains & Routes), comment out the `routes` block, then recreate the three records above.

## Rollback

| Problem | Fix |
| --- | --- |
| Bad code deploy | `npx wrangler deployments list --env=""`, then `npx wrangler rollback <version-id> --env=""`. Or Dashboard → Workers & Pages → dalyidau → Deployments → Rollback. Or revert the commit on `main`. |
| Bad content | Fix it in Capacities and run a manual sync, or set the post to Draft. |
| Damaged database | D1 Time Travel keeps 30 days: `npx wrangler d1 time-travel info dalyidau-production`, then `npx wrangler d1 time-travel restore dalyidau-production --timestamp=<ISO time>` |
| Rebuild from scratch | Content lives in Capacities, so an empty D1 refills itself: run a forced manual sync. |

Migrations are forward-only. Add new files to `migrations/` and they apply before each deploy.
