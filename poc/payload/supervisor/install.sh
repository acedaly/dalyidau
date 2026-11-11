#!/bin/zsh
# Installs, inspects or removes the Payload autonomy supervisor (a user-level launchd agent; no admin rights).
#   supervisor/install.sh install <session-id> <deadline-ISO>   # follow that session until the deadline
#   supervisor/install.sh status
#   supervisor/install.sh uninstall                              # stop for good (also: touch ~/.payload-autonomy/STOP)
set -euo pipefail
LABEL=au.id.daly.payload-autonomy
PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
DIR=${0:A:h}
STATE=$HOME/.payload-autonomy
REPO=${DIR:h:h:h}
NODE=$(command -v node)
CLAUDE=$(command -v claude)

case ${1:-} in
install)
  [[ -n ${2:-} && -n ${3:-} ]] || { echo "usage: install <session-id> <deadline-ISO>"; exit 2; }
  mkdir -p $STATE && chmod 700 $STATE && rm -f $STATE/STOP
  cat > $STATE/state.json <<JSON
{
  "sessionId": "$2",
  "deadline": "$3",
  "maxLaunches": 4,
  "launches": 0,
  "repo": "$REPO",
  "projectDir": "$HOME/.claude/projects/${REPO//\//-}",
  "claudePath": "$CLAUDE",
  "path": "${NODE:h}:${CLAUDE:h}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}
JSON
  cat > $PLIST <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/supervisor.mjs</string></array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StandardOutPath</key><string>$STATE/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$STATE/launchd.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
PL
  launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) $PLIST
  echo "installed; following $2 until $3. Log: $STATE/supervisor.log";;
status)
  launchctl print gui/$(id -u)/$LABEL 2>/dev/null | grep -E "state =|runs =|last exit" || echo "not loaded"
  [[ -f $STATE/STOP ]] && echo "STOP: $(cat $STATE/STOP)"
  tail -5 $STATE/supervisor.log 2>/dev/null || true;;
uninstall)
  mkdir -p $STATE && echo "$(date -u +%FT%TZ) uninstalled" > $STATE/STOP
  launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
  rm -f $PLIST
  echo "uninstalled (state kept in $STATE)";;
*) echo "usage: install <session-id> <deadline> | status | uninstall"; exit 2;;
esac
