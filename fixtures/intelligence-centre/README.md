# Intelligence Centre fixtures (invented)

Everything here is **invented**. Each response follows the format its provider published when the
sources were checked on 19 October 2026 (see `docs/INTELLIGENCE_SOURCES.md`), but every incident,
place ("Example…"), reading and id is made up. Real provider data isn't committed: the Bureau of
Meteorology's terms don't allow passing it on, and real incidents go out of date.

- `feeds.mjs`: builders for each provider's response, with times relative to a given `now`.
- Used by `test/centre*.test.ts` (through a fake transport) and `scripts/mock-feeds.mjs` (local
  development and the browser tests, via `CENTRE_FEED_BASE`).

Anything collected from these is stored with `fixture = 1` and shown as **"Recorded fixture data,
not live"** in the portal and on wallboards.
