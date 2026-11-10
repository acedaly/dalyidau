# Payload wedding system: scope and timeline review

**11 Nov 2026.** You asked me to challenge the 7–9 week estimate for a personal wedding system. It doesn't hold up. **The minimum usable Payload-based wedding system is essentially built.** What's left is mostly approvals, a deploy pipeline and one supervised cutover: about **1.5–2 weeks elapsed**, with **5–8 working days** of actual work. The rest is optional.

## Why the old estimate was too high

The 7–9 weeks assumed three big pieces of work. None of them is needed.

1. **Extracting `wedding-core` and `platform-core` packages.** Not needed. The combined Worker imports the existing modules directly, and the whole existing suite passes through it (821 tests on `main`, 476 on PR #48). A package split adds structure, not function.
2. **Rebuilding the wedding screens in Payload.** Not needed. All 19 wedding screens run unchanged inside Payload's admin, using the portal's own components, loader and permission checks (39/39 browser checks).
3. **Migrating wedding data into Payload collections.** Not needed, and it would be the riskiest part. Guests, households, RSVPs, messages and the audit log stay in the existing tables, with the existing atomic SQL. Payload gets its own small database (its user mirror and preferences), which starts empty. **There is no real-data migration at cutover.** The cutover is a Worker deploy, reversible in about 3 seconds (rehearsed).

## Kept without modification

These keep running exactly as they do today, with no code changes:

- **The public wedding site and RSVP.** `wedding.daly.id.au`, invitation links, RSVP lookup and submit, the PDFs.
- **Communications.** Email (Fastmail), SMS (ClickSend), scheduled sends, webhooks, opt-outs.
- **The Wedding Planner phone app.** `weddingplanner.daly.id.au` and `/portal/planner`.
- **The wedding API and its security.** All `/api/portal/wedding/*` routes, Access verification, roles, audit, rate limits and signed links.
- **The cron jobs,** including the wedding message queue.
- **`/portal/wedding` itself.** It stays available in parallel, so there's a fallback while you get used to the Payload admin.
- **The MCP gateway binding.** `PortalMcpEntrypoint` is re-exported unchanged.

## Necessary before production (security, reliability, readiness)

| # | Task | Status | Effort |
|---|---|---|---|
| 1 | Host isolation: no admin on guest hosts | Done, tested (8,000+ generated paths) | — |
| 2 | Payload sign-in only through Access; no Payload sessions; internal routes blocked; media writes for owners and admins only | Done this session (121/121 authz matrix) | — |
| 3 | Cron doesn't start Payload | Done (2.9 s → 28 ms CPU) | — |
| 4 | No CPU cost on unrelated routes | Measured on Cloudflare: none | — |
| 5 | Guarded deploy path; `.dev.vars` can't redirect a deploy; isolation checks mandatory | Done for staging | — |
| 6 | Rollback rehearsed with invented data | Done on staging (see the cutover plan) | — |
| 7 | **CI pipeline for the combined Worker**: build (client + OpenNext + merge), platform suite, authz matrix, config checks, then deploy as `dalyidau` with `OPEN_NEXT_DEPLOY=true` and a clean environment | Not started (workflow change; needs your review) | 1–2 days |
| 8 | **Production Payload resources**: a new D1 for Payload content (`D1`) and a new R2 bucket for Payload media, plus the `PAYLOAD_SECRET` and `PAYLOAD_JOBS_SECRET` secrets | Needs approval (new resources and secrets) | ½ day |
| 9 | **Access covers Payload's paths in production**: `/admin*`, `/api/platform/*`, `/api/users*`, `/api/pages*`, `/api/media*` and `/api/payload-preferences*` on `daly.id.au`. Without this, the Worker fails closed and everyone gets 401; nothing leaks. | Needs approval (Access change) | ½ day, mostly testing |
| 10 | **Real Access test on a staging hostname** (sign-in, sign-out, expiry, a revoked user, direct URLs) | Needs approval for a hostname (scripts prepared) | 1 day |
| 11 | **Production cutover** outside the RSVP-critical window, then 48 hours of monitoring (Workers analytics: errors, CPU; D1) | Needs approval | 1 day + monitoring |
| 12 | Merge PR #48 first (recommended) | Your review | — |

PR #48 retires the Intelligence Centre, whose housekeeping cron is the account's biggest D1 load (about 26 million rows read a day) and the likely cause of the overload error on 10 Nov. It also shrinks today's Worker by 28%. The Payload branch replays onto it cleanly.

## Optional improvements that can wait

- **Website content in Payload** (pages and posts, public rendering from Payload). This is the actual CMS benefit, but the wedding doesn't need it. 1–2 weeks, any time after cutover.
- **Payload 4** when it's released: 2–3 days (the diff is already prepared in `poc/payload/evidence/`).
- **Retiring `/portal/wedding`** once you're happy with the Payload admin: 1 day. Removing it isn't part of this approval.
- **Small polish:**
  - keep query strings on in-screen links;
  - Payload's typing quirk in `message-page.tsx` (no runtime effect);
  - quieter logs.
- **Package extraction (`wedding-core`):** not recommended. It adds complexity for no user-visible gain.

## Updated timeline

| | Work | Elapsed |
|---|---|---|
| **Essential: production-ready Payload wedding admin** | Approvals (#8–#10, #12), CI pipeline (#7), Access test on staging (#10), cutover and monitoring (#11) | **5–8 working days**, about 1.5–2 weeks depending on approval turnaround |
| Enhancements | Website CMS, Payload 4, retiring the old portal screens | 2–4 weeks, whenever wanted, independent of the wedding |

## An honest note

For the wedding alone, the Payload admin adds no capability: it's the same screens in different chrome. It does add a larger Worker (about 4.9 MB compressed vs 0.6–0.85 MB; startup about +25–30 ms per cold isolate (typical Cloudflare readings ≈147 ms combined vs ≈121 ms today, three samples each; either build occasionally reads ~300 ms)) and Next.js/OpenNext upkeep.

The case for doing it is the website CMS and having one admin, not the wedding features. If the CMS isn't wanted soon, a reasonable alternative is to stop after the essential steps above, or to defer the cutover until after 23 Oct 2027. Either way, nothing built so far is wasted, and the old portal keeps working.
