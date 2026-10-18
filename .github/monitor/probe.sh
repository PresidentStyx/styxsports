#!/usr/bin/env bash
# Outage probe for sports.styxam.com: walks the path a viewer takes (schedule -> a live game's
# server tabs -> a playable free stream) once over HTTP/1.1, the way the APK (before 3.10) and
# Roku talk to the Worker, and once over HTTP/2, the way browsers do. A failure on one protocol
# only is how the 2026-10-18 outage looked: every TV got "HTTP 502" while the web played.
#
# Writes a Markdown report to $REPORT and the overall verdict (ok | degraded | down) to $VERDICT.
# Usage: probe.sh            (needs curl and jq)
set -uo pipefail

BASE="${STYX_BASE:-https://sports.styxam.com}"
# The probe announces itself like a TV app does (POST /api/ping); a TV install id is what lets
# an app read /api/schedule and /api/stream without the site password (web/src/presence.js).
DEVICE_ID="${STYX_MONITOR_ID:-health-monitor-gh01}"
REPORT="${REPORT:-/dev/stdout}"
VERDICT="${VERDICT:-/dev/null}"
MAX_SERVERS=3

say() { printf '%s\n' "$*" >> "$REPORT"; }

# get <proto> <path>: response body into $BODY, status into $CODE.
BODY=""; CODE=""
get() {
  local tmp; tmp=$(mktemp)
  CODE=$(curl -sS "--$1" -m 45 -H "X-Styx-Device: $DEVICE_ID" -o "$tmp" -w '%{http_code}' "$BASE$2" 2>/dev/null)
  CODE=${CODE:-000}
  BODY=$(cat "$tmp"); rm -f "$tmp"
}
err() { jq -r '.error // empty' <<<"$BODY" 2>/dev/null | head -c 120; }

enc() { jq -rn --arg v "$1" '$v|@uri'; }

# check <proto>: prints one Markdown table row, returns 0 when a free stream resolved as playable.
check() {
  local proto=$1 page servers tried=0 played="" games
  get "$proto" /api/schedule
  if [ "$CODE" != 200 ] || ! jq -e '.events' >/dev/null 2>&1 <<<"$BODY"; then
    say "| $proto | ❌ schedule: HTTP $CODE $(err) | | |"
    return 1
  fi
  games=$(jq '[.events[] | select(.live and (.ended|not))] | length' <<<"$BODY")
  # The hottest free live game.
  page=$(jq -r '[.events[] | select(.live and (.ended|not) and (.premium|not))] | sort_by(.hotRank // 999) | .[0].url // empty' <<<"$BODY")
  if [ -z "$page" ]; then
    say "| $proto | ✅ schedule ($games live) | – no free live game to open | – |"
    return 0
  fi
  get "$proto" "/api/stream?only=servers&page=$(enc "$page")"
  if [ "$CODE" != 200 ]; then
    say "| $proto | ✅ schedule ($games live) | ❌ game page: HTTP $CODE $(err) | |"
    return 1
  fi
  servers=$(jq -c "[.servers[] | select(.premium|not)] | .[:$MAX_SERVERS][]" <<<"$BODY")
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    tried=$((tried + 1))
    local url name state
    url=$(jq -r .pageUrl <<<"$s"); name=$(jq -r .name <<<"$s")
    get "$proto" "/api/stream?server=$(enc "$url")&name=$(enc "$name")"
    state=$(jq -r '.stream.state // empty' <<<"$BODY" 2>/dev/null)
    if [ "$CODE" = 200 ] && [ "$(jq -r '.stream.playable // false' <<<"$BODY")" = true ]; then
      played="$name ($state)"; break
    fi
  done <<<"$servers"
  local gameName; gameName=$(basename "$page")
  if [ -n "$played" ]; then
    say "| $proto | ✅ schedule ($games live) | ✅ \`$gameName\` | ✅ $played |"
    return 0
  fi
  say "| $proto | ✅ schedule ($games live) | ✅ \`$gameName\` | ❌ none of $tried free servers playable |"
  return 1
}

say "| Protocol | Schedule | Game page | Free stream |"
say "|---|---|---|---|"
curl -sS -m 20 -X POST -H 'Content-Type: application/json' \
  -d "{\"id\":\"$DEVICE_ID\",\"platform\":\"apk\",\"device\":\"Health monitor (GitHub Actions)\"}" \
  "$BASE/api/ping" >/dev/null 2>&1 || true

h1=0; h2=0
check http1.1 || h1=1
check http2 || h2=1

if [ $h1 = 0 ] && [ $h2 = 0 ]; then verdict=ok
elif [ $h1 = 1 ] && [ $h2 = 1 ]; then verdict=down
else verdict=degraded
fi
say ""
case $verdict in
  ok) say "**All good.**" ;;
  down) say "**Down on both protocols:** viewers on every platform are affected." ;;
  degraded)
    if [ $h1 = 1 ]; then say "**HTTP/1.1 only:** TV apps (Roku, APK before 3.10) are affected; browsers work."
    else say "**HTTP/2 only:** browsers and the APK (3.10+) are affected; Roku may still work."; fi ;;
esac
echo "$verdict" > "$VERDICT"
