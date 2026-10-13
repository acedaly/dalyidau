#!/usr/bin/env bash
# Starts the mock Capacities API and wrangler dev in the background for local testing.
# Usage: scripts/local-up.sh [logdir]
set -euo pipefail
LOG=${1:-.wrangler/logs}
mkdir -p "$LOG"
[ -f .dev.vars ] || cp .dev.vars.example .dev.vars
npm run build:client > "$LOG/vite.log" 2>&1
npx wrangler d1 migrations apply DB --local --env="" > "$LOG/migrate.log" 2>&1
nohup node scripts/mock-capacities.mjs > "$LOG/mock.log" 2>&1 &
echo $! > "$LOG/mock.pid"
nohup npx wrangler dev --env="" --port 8787 --test-scheduled > "$LOG/wrangler.log" 2>&1 &
echo $! > "$LOG/wrangler.pid"
for _ in $(seq 1 60); do
    if curl -sf http://localhost:8787/api/health > /dev/null; then echo "Ready on http://localhost:8787"; exit 0; fi
    sleep 1
done
echo "wrangler dev did not start; see $LOG/wrangler.log" >&2
exit 1
