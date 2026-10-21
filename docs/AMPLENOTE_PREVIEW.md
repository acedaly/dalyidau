# Amplenote published-note preview

This branch changes **only the public personal site**, not Daly Portal or the wedding site.

## Why

Use the existing Untitled UI Pro React website as an informal, editorial personal site while evaluating Amplenote Unlimited as the source for blog articles.

## Preview

- Route: `/blog/amplenote-test` (publicly accessible but unlisted and marked noindex).
- Note: the public Amplenote embed token provided by the site owner.
- The iframe uses `https://public.amplenote.com/embed/<token>`.
- The official deferred `https://public.amplenote.com/embed.js` script is loaded **only on the preview page**.
- The security header allows that host for `script-src` and `frame-src` only on that route, not for the portal.
- The page has `noindex` metadata and an `X-Robots-Tag: noindex` header and is absent from the blog index and sitemap.
- Amplenote is authoritative for the embedded content; the site controls the outer layout.

**This is an embed proof of concept, not an automatic blog publisher.** A public iframe
does not by itself give server-rendered article content, full SEO, editable metadata,
automatic discovery of new public notes, or RSS entries. Do not replace the Capacities
publisher before solving those pieces and verifying content exports.

## Local checks

```sh
npm ci
npm run typecheck
npm test
npm run test:e2e
npm run check:bundle
npm run check:styles
```

Open `/blog/amplenote-test` and confirm the external note loads and resizes correctly
on desktop and mobile. Test browser privacy extensions and Safari because cross-origin
embeds can be blocked. Confirm the portal CSP remains unchanged.

## Existing content

No existing post, feed, database, scheduled sync or production route is removed.
The Capacities pipeline remains in place until a separate approved cutover.
