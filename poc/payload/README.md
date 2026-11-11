# Payload CMS: Phase 0 proof of concept

**Never deploy this to production or point it at production resources. Invented data only.** The only approved deploy is the isolated staging Worker (`--env staging`, Phase 1). Run `node scripts/check-staging.mjs --online` first and deploy with `OPEN_NEXT_DEPLOY=true`. See [docs/PAYLOAD_PHASE1.md](../../docs/PAYLOAD_PHASE1.md#reproducing).

This PoC runs Payload CMS 3.93 (Next.js through OpenNext) and the existing daly.id.au Worker in one Worker script, to test Option 1b. The results are in [docs/PAYLOAD_PHASE0.md](../../docs/PAYLOAD_PHASE0.md).

## What's here

| Path | What it is |
|---|---|
| `platform/hosts.ts` | Hostname and path rules, decided before anything else (experiment 6) |
| `platform/compose.ts` | The combined router, the Access gate in front of Payload, and the cron (experiments 4–6) |
| `platform/bridge.ts` | Page data for the wedding views, served by the existing portal loader (experiment 2) |
| `platform/entry.ts` | The Worker entry (`wrangler.jsonc` `main`) |
| `src/auth/access-strategy.ts` | Payload sign-in through the existing Cloudflare Access verifier and portal roles (experiment 3) |
| `src/views/` | The existing wedding screens as Payload admin views, isolated in a shadow root (experiment 2) |
| `src/middleware.ts` | The portal's CSP for the admin, with a per-request nonce |
| `test-platform/` | Runs the whole existing suite through the combined router, plus the security tests |
| `e2e-platform/custom-view.mjs` | Browser checks: rendering, isolation, overlays, dark mode, roles, CSP. Aborts any request that would leave the machine |
| `evidence/` | The Payload 4.0 beta upgrade diff (experiment 7) |

## Run it

Requires Node ≥ 24.22.1 (Payload's engine requirement) and the repository root's `npm ci`.

```bash
cd poc/payload
npm ci
node scripts/test-identity.mjs init          # invented Access key pair + .dev.vars (git-ignored)
npm run poc:build                            # root client build, OpenNext build, asset merge
npm run poc:migrate                          # local wedding D1 (existing migrations) + Payload's D1
npx wrangler dev --port 8790 --local --test-scheduled
node scripts/seed-invented.mjs               # invented households and guests, through the existing API
node e2e-platform/custom-view.mjs            # 19 browser checks; screenshots in .poc-results/
npm run poc:size                             # bundle size (wrangler dry run)
npm run poc:typecheck
```

From the repository root, run the existing suite and the platform tests through the combined router:

```bash
npx vitest run --config poc/payload/test-platform/vitest.platform.config.ts
```

To call it by hand, sign a token with `node scripts/test-identity.mjs token owner@example.test`, then send it as `Cf-Access-Jwt-Assertion` together with `Host: daly.id.au`.
