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

## DNS cut-over: needs your approval

This is the only step that changes live DNS. It hasn't been done.

**Current records (checked 11 October 2026):**

| Name | Type | Value | Proxied | Used by |
| --- | --- | --- | --- | --- |
| `daly.id.au` | A | `103.168.172.37`, `103.168.172.52` | No | Current Fastmail-hosted homepage |
| `www.daly.id.au` | A/CNAME | (proxied) | Yes | Old cPanel host serving a default page |
| `*.daly.id.au` (inferred: unknown names resolve to the Fastmail IPs) | A | `103.168.172.37`, `103.168.172.52` | No | Fastmail web hosting |
| `hub.daly.id.au` | (proxied) | | Yes | DalyHub, **leave alone** |
| MX | | `us1-smtp.messagingengine.com` (10), `us2-smtp.messagingengine.com` (20) | | Email, **leave alone** |
| TXT `daly.id.au` | | `v=spf1 a:my.daly.id.au include:spf.messagingengine.com ~all` | | SPF, **leave alone** |
| `fm1/fm2/fm3._domainkey` | CNAME | `…dkim.fmhosted.com` | | DKIM, **leave alone** |
| `_dmarc` | TXT | `v=DMARC1; p=quarantine` | | DMARC, **leave alone** |

**Change (two records only):**

1. In Cloudflare DNS for `daly.id.au`, note down then delete the two apex **A** records (`103.168.172.37`, `103.168.172.52`) and the **www** record. Touch nothing else.
2. Uncomment the `routes` block in `wrangler.jsonc`:
   ```jsonc
   "routes": [
       { "pattern": "daly.id.au", "custom_domain": true },
       { "pattern": "www.daly.id.au", "custom_domain": true }
   ],
   ```
3. Push to `main`. Wrangler attaches both hostnames to the Worker, creates the DNS records and issues certificates. The Worker 301s `www` to the apex.

Wrangler refuses to attach a custom domain while another A/AAAA/CNAME record exists for that name, so step 3 can't overwrite anything by accident. Email isn't affected: MX, SPF, DKIM and DMARC records are separate from the A records. Wildcard subdomains and `hub.daly.id.au` keep their own records.

**Undo the cut-over:** comment the `routes` block again and deploy (or remove the custom domains under Workers & Pages → dalyidau → Settings → Domains), then recreate the two A records above.

## Rollback

| Problem | Fix |
| --- | --- |
| Bad code deploy | `npx wrangler deployments list --env=""`, then `npx wrangler rollback <version-id> --env=""`. Or Dashboard → Workers & Pages → dalyidau → Deployments → Rollback. Or revert the commit on `main`. |
| Bad content | Fix it in Capacities and run a manual sync, or set the post to Draft. |
| Damaged database | D1 Time Travel keeps 30 days: `npx wrangler d1 time-travel info dalyidau-production`, then `npx wrangler d1 time-travel restore dalyidau-production --timestamp=<ISO time>` |
| Rebuild from scratch | Content lives in Capacities, so an empty D1 refills itself: run a forced manual sync. |

Migrations are forward-only. Add new files to `migrations/` and they apply before each deploy.
