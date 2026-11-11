#!/bin/zsh
# Phase 1: Worker CPU per route type on Cloudflare, for today's Worker alone and the combined Worker.
# Each (worker, route) pair gets its own UTC minute, so Workers analytics (cpuTime per minute) can
# separate them. Uses the private `wrangler dev --remote --env staging` session; invented data only.
# Output: lines "<label> <minute>" in .poc-results/cpu-windows.txt, for scripts/cpu-report.mjs.
set -u
cd ${0:A:h}/..
LOG=${TMPDIR:-/tmp}/payload-cpu-session.log
OUT=.poc-results/cpu-windows.txt; : > $OUT
TOKEN=$(node scripts/test-identity.mjs token owner@example.test)
waitminute() { while [ $(date -u +%S) -ne 2 ]; do sleep 0.5; done; }
session() {
  pkill -f "wrangler dev --remote" ; sleep 3
  if [ $1 = combined ]; then OPEN_NEXT_DEPLOY=true npx wrangler dev --remote --env staging --port 8791 > $LOG 2>&1 &
  else npx wrangler dev --remote --env staging --port 8791 platform/entry-legacy-baseline.ts > $LOG 2>&1 & fi
  for i in $(seq 1 90); do grep -q "Ready on" $LOG && break; sleep 2; done
  for i in 1 2 3; do curl -s -o /dev/null http://localhost:8791/; curl -s -o /dev/null -H "Cf-Access-Jwt-Assertion: $TOKEN" http://localhost:8791/api/portal/wedding/guests; done  # warm
}
burst() { # label path [auth]
  waitminute; local minute=$(date -u +%Y-%m-%dT%H:%M:00Z)
  for i in $(seq 1 40); do
    if [ -n "${3:-}" ]; then curl -s -o /dev/null -H "Cf-Access-Jwt-Assertion: $TOKEN" http://localhost:8791$2; else curl -s -o /dev/null http://localhost:8791$2; fi
  done
  echo "$1 $minute" | tee -a $OUT
}
for worker in legacy combined; do
  session $worker
  burst "${worker}:blog-home" /
  burst "${worker}:wedding-api" /api/portal/wedding/guests auth
  burst "${worker}:portal-page" /portal/wedding/guests auth
done
pkill -f "wrangler dev --remote"
