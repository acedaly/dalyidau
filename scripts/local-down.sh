#!/usr/bin/env bash
LOG=${1:-.wrangler/logs}
for f in "$LOG"/mock.pid "$LOG"/wrangler.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
# wrangler dev spawns workerd as a child process.
pkill -x workerd 2>/dev/null || true
exit 0
