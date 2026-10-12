# Staging

Staging is a separate copy of the site for trying changes, migrations and the portal with fictional data before production.

|                    | Production                 | Staging                                                    |
| ------------------ | -------------------------- | ---------------------------------------------------------- |
| Worker             | `dalyidau`                 | `dalyidau-staging` (not deployed yet)                      |
| URL                | `https://daly.id.au`       | `https://dalyidau-staging.<account-subdomain>.workers.dev` |
| D1 database        | `dalyidau-production`      | `dalyidau-staging` (exists, empty)                         |
| R2 bucket          | `dalyidau-media`           | `dalyidau-media-staging`                                   |
| Secrets            | its own                    | its own (set separately)                                   |
| Access application | covers `daly.id.au/portal` | covers the whole staging hostname                          |
| Email delivery     | `EMAIL_DELIVERY: "off"`    | `EMAIL_DELIVERY: "off"`                                    |
| Cron sync          | every 15 minutes           | none (sync by hand)                                        |

## Why staging can't touch production

- Its own D1 database and R2 bucket in `wrangler.jsonc` (`env.staging`); `npm run check:config -- --env staging` fails if the database id ever matches production's.
- `"routes": []` in `env.staging`. Named environments **inherit** top-level routes, so before this change a staging deploy would have moved `daly.id.au` to the staging Worker. The config check and CI fail if staging ever gets routes again.
- Separate secrets and a separate Access application (different audience tag), so a staging token is rejected by production and vice versa.
- `npm run seed:staging` refuses to run if staging and production share a database id, and only ever replaces rows whose ids start with `demo_`.

## Setting it up (needs your approval and Cloudflare login)

All free on the current plan; nothing here is paid.

1. **Deploy staging once** to create the Worker: GitHub → Actions → Deploy → Run workflow → `staging` (or `npm run deploy:staging`). It applies migrations to the staging database.
2. **Note the URL** it prints (`https://dalyidau-staging.<subdomain>.workers.dev`) and set `SITE_URL` in `env.staging.vars` in `wrangler.jsonc` to it, so links and RSVP codes in staging point at staging. Commit and redeploy.
3. **Protect the whole hostname with Access**: Workers & Pages → `dalyidau-staging` → Settings → Domains & Routes → workers.dev → enable **Cloudflare Access** (this also covers preview URLs). Then in Zero Trust → Access → Applications, open the application it created, set the policy to your two emails, and copy its **AUD tag**.
4. **Secrets**:
    ```bash
    npx wrangler secret put ACCESS_TEAM_DOMAIN  --env staging
    npx wrangler secret put ACCESS_AUD          --env staging   # the staging application's AUD
    npx wrangler secret put PORTAL_OWNER_EMAILS --env staging
    npx wrangler secret put RSVP_LINK_SECRET     --env staging # use a different high-entropy value from production
    # optional, for the blog sync on staging:
    npx wrangler secret put CAPACITIES_API_TOKEN --env staging
    npx wrangler secret put ADMIN_TOKEN          --env staging
    ```
5. **Check it**: `npm run check:config -- --env staging --url https://dalyidau-staging.<subdomain>.workers.dev`
6. **Demo data**: `npm run seed:staging -- --yes`

## Using it

- Sign in at `/portal` on the staging URL. The portal shows a "staging environment" banner.
- Everything works as in production, with fictional guests. Turn on the website and native RSVP there freely to test them. Use the signed links shown in Households; legacy demo codes are available only while **Allow short household codes** is enabled.
- To rehearse a release: deploy the branch to staging, run `npm run db:verify -- --env staging`, click through, then deploy production.
- Reset the demo data at any time by re-running `npm run seed:staging -- --yes`.
