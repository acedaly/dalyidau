# Retiring the portal: dependency map (Phase 3, 11 Nov 2026)

Goal: Payload at `daly.id.au/admin` is the only administration. This map was drawn before anything was removed.

## Human-facing pages

| Old address | Replaced by | Now |
|---|---|---|
| `/portal`, `/portal/wedding` | `/admin/wedding` (Wedding → Dashboard) | 302 |
| `/portal/wedding/<screen>` (guests, households, events, RSVPs, invitations, communications, messages, texts, providers, tasks, timeline, seating, catering, budget, suppliers, website, settings) | `/admin/wedding/<screen>` | 302, query and fragment kept |
| `/portal/settings[/general,access,features,website,security,privacy]` | `/admin/administration[/…]` (new Administration section: Users and permissions, Features, Integrations and security, Privacy, Capacities archive) | 302 |
| `/portal/audit` | `/admin/administration/audit` | 302, filters kept |
| Old settings aliases (`SETTINGS_REDIRECTS`) | the same screens | 302 straight to Payload |
| `/portal/planner/*` (phone app) | `/admin/wedding` | 302 |
| `weddingplanner.daly.id.au/*` | `daly.id.au/admin/wedding` | 302; API 404 (see `docs/PLANNER.md`) |
| Retired apps' pages (`/portal/calendar`, `/portal/knowledge`…) | — | plain 410 with the retirement message (as before, without portal chrome) |
| Anything else under `/portal` | `/admin` | 302 |
| `/portal/wedding/website/preview[/rsvp]` | **kept**: the draft preview is a rendered wedding page, opened from Wedding → Website | 200, Access + role |
| `/portal/sw.js`, `/portal/planner/sw.js`, `weddingplanner…/sw.js` | **kept**: unregisters installed copies of the old apps | 200 |

Every redirect happens after the Access/role check (strangers get the refusal, not a map), and is `no-store`, `noindex`. Cloudflare Access still protects `/portal` and `/api/portal`.

## Shared services that stay (and why)

| Kept | Used by |
|---|---|
| `/api/portal/*` (`worker/portal/api.ts` and its modules) | Every wedding and administration screen in Payload; the wedding site's RSVP preview test endpoint. Same Access JWT + role check, audit log. Never redirected. |
| `worker/portal/auth.ts` `authenticate`, `access.ts`, roles and permissions | Payload's sign-in strategy (`poc/payload/src/auth/access-strategy.ts`), the combined Worker's admin gate (`platform/compose.ts`), the API. |
| `worker/portal/pages.ts` `loadPortalPage` | Page data for each screen, now through `worker/portal/admin-page.ts` (used by `/api/platform/wedding-page`). |
| `src/portal/pages/*`, `src/portal/components/*`, `portal-context.tsx` | The screens themselves, rendered by Payload (`src/portal/portal-screen.tsx`). |
| `shell-portal.html` + `src/entry-portal.tsx` | Now a CSS-only entry: the stylesheet the screens load inside their shadow root (the bridge reads its hashed name). |
| `portal_users`, `feature_flags`, `settings`, `audit_log`, `dashboard_layouts` and all wedding tables | Unchanged. |
| Cron (`scheduled`: message queue, etc.) | Unchanged. |

## Removed

- `src/portal/portal-app.tsx` (portal chrome), `src/portal/layout/portal-sidebar.tsx`, `src/portal/boot-shell.ts`: the portal's own shell.
- The portal page renderer in `worker/index.ts` (loading shell, page data) and the `portal`/`planner` shells.
- Wedding Planner: `src/planner/*`, `src/entry-planner.tsx`, `src/shared/planner/*`, `shell-planner.html`, its manifest, offline page and caching service worker.
- Portal-only tests and specs moved: the screens' browser suite now runs inside Payload (`playwright.admin.config.ts`); the phone app's spec was deleted.

## Not removed (needs the owner)

- The `weddingplanner.daly.id.au` route and DNS record (routes/DNS change).
- Cloudflare Access destinations `/portal` and `/api/portal`: keep. `/api/portal` is still the admin's API, and `/portal` still answers the preview and redirects.
- Planner icons in `public/icons/` (harmless; remove with the route).
- No data, tables, secrets or backups were touched. 0032/0033 remain in `docs/pending`.
