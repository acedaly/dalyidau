#!/bin/zsh
set -u
SP=/private/tmp/claude-501/-Users-aidandaly-Projects-dalyidau/c48f8b04-c17d-492f-8654-4f2e5d1f64c8/scratchpad
cd /Users/aidandaly/Projects/dalyidau/poc/payload
pkill -f "wrangler dev"; pkill -f workerd; sleep 1
npm run poc:build > $SP/build.log 2>&1 || { echo BUILD FAILED; exit 1; }
echo "== browser checks"
ST=$SP/cv-state; rm -rf $ST; npx wrangler d1 migrations apply DB --local --persist-to $ST >/dev/null 2>&1
(npx wrangler dev --local --port 8790 --persist-to $ST > $SP/cv.log 2>&1 &)
for i in $(seq 1 90); do grep -q "Ready on" $SP/cv.log && break; sleep 2; done
node scripts/seed-invented.mjs | tail -1
node e2e-platform/custom-view.mjs 2>&1 | grep -E "FAIL|checks passed|passed"
node e2e-platform/wedding-publish.mjs 2>&1 | grep -E "FAIL|all passed|FAILED"
pkill -f "wrangler dev"; pkill -f workerd; sleep 2
echo "== site/blog/authz"
ST=$SP/sb-state; rm -rf $ST; npx wrangler d1 migrations apply DB --local --persist-to $ST >/dev/null 2>&1
SQL="INSERT OR REPLACE INTO posts (id, slug, title, subtitle, summary, category, tags, featured, body_html, toc, search_text, word_count, reading_minutes, published_at, updated_at, content_hash, synced_at, source) VALUES ('invented-capacities-0001','an-invented-older-post','An invented older post','From the archive','Written before Payload.','Archive','[\"history\"]',0,'<p>Written before Payload. <a href=\"https://example.com/\" rel=\"noopener noreferrer\" target=\"_blank\">A link</a>.</p><h2 id=\"part\">Part</h2><p>More.</p>','[{\"id\":\"part\",\"text\":\"Part\",\"level\":2}]','Written before Payload. A link. Part More.',7,1,'2026-10-01T00:00:00.000Z',NULL,'x','2026-10-01T00:00:00.000Z','capacities')"
npx wrangler d1 execute DB --local --persist-to $ST --command "$SQL" >/dev/null 2>&1
(npx wrangler dev --local --port 8790 --env-file .dev.vars.authz --persist-to $ST > $SP/sb.log 2>&1 &)
for i in $(seq 1 90); do grep -q "Ready on" $SP/sb.log && break; sleep 2; done
for t in site blog authz; do echo "-- $t"; node e2e-platform/$t.mjs 2>&1 | grep -E "FAIL|all passed|FAILED|failed|All authorisation"; done
pkill -f "wrangler dev"; pkill -f workerd; sleep 2
echo "== admin e2e"
cd ../.. && npx playwright test -c playwright.admin.config.ts 2>&1 | grep -E "passed|failed|flaky|^\s+[0-9]+\) " | sed 's/\x1b\[[0-9;]*m//g' | tail -12
echo DONE
