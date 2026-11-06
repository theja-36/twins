#!/usr/bin/env bash
# TWINS Kite run PREFLIGHT (read-only). Run on the staging host before the morning login / supervised feed run. It makes NO network request, reads NO secret value (only file metadata and variable NAMES),
# starts nothing and changes nothing. Prints one line per check: PASS, WARN or FAIL, then a summary. Exit code is always 0 (informational); a FAIL means do not start the feed.
#   twins-kite-preflight.sh
set -uo pipefail
COMPOSE_DIR="${COMPOSE_DIR:-/opt/twins-staging/infrastructure/staging}"
EGRESS="${EGRESS_BIN:-/opt/twins-staging/twins-kite-egress.sh}"
TOKEN_FILE="${TWINS_KITE_TOKEN_FILE:-/var/lib/twins-kite/kite-token.json}"
PROVIDERS_DIR="${TWINS_PROVIDERS_DIR:-/var/lib/twins-providers}"
DOCKER="${DOCKER:-docker}"
PYTHON="${PYTHON:-python3}"
pass=0; warn=0; fail=0
ok()   { printf 'PASS  %s\n' "$1"; pass=$((pass+1)); }
wr()   { printf 'WARN  %s\n' "$1"; warn=$((warn+1)); }
bad()  { printf 'FAIL  %s\n' "$1"; fail=$((fail+1)); }

# 1. clock and window (IST = UTC+5:30)
now_utc=$(date -u +%s); ist_h=$(( (now_utc + 19800) / 3600 % 24 )); ist_m=$(( (now_utc + 19800) / 60 % 60 )); dow=$(date -u -d "@$((now_utc + 19800))" +%u 2>/dev/null || echo 0)
printf 'INFO  host time %s UTC = %02d:%02d IST, weekday %s\n' "$(date -u +%FT%TZ)" "$ist_h" "$ist_m" "$dow"
if [ "$dow" -ge 6 ] || [ "$dow" -eq 0 ]; then wr "today is a weekend: the feed window is closed"; fi
mins=$((ist_h*60+ist_m))
if [ "$mins" -ge $((8*60+55)) ] && [ "$mins" -le $((15*60+40)) ]; then ok "inside the feed window (08:55-15:40 IST)"; else wr "outside the feed window (08:55-15:40 IST); the feed will not run usefully now"; fi

# 2. egress allow-list
if out="$("$EGRESS" status 2>&1)"; then ok "egress allow-list: $(printf '%s' "$out" | tail -1 | cut -c1-120)"; else bad "egress allow-list not ready: $(printf '%s' "$out" | tail -1 | cut -c1-120)"; fi

# 3. token file (metadata only; the token value is never read)
if [ -f "$TOKEN_FILE" ] && [ ! -L "$TOKEN_FILE" ]; then
  mode="$(stat -c %a "$TOKEN_FILE" 2>/dev/null)"
  if [ $((8#${mode:-777} & 8#077)) -ne 0 ]; then bad "token file permissions too open ($mode)"; fi
  verdict="$("$PYTHON" - "$TOKEN_FILE" "$now_utc" <<'PY'
import json, sys, datetime
try:
    issued = datetime.datetime.fromisoformat(json.load(open(sys.argv[1]))["issuedAt"].replace("Z", "+00:00"))
except Exception:
    print("unreadable"); sys.exit(0)
ist = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
t = issued.astimezone(ist); exp = t.replace(hour=6, minute=0, second=0, microsecond=0)
if exp <= t: exp += datetime.timedelta(days=1)
print("expired" if int(sys.argv[2]) >= int(exp.timestamp()) else "valid")
PY
)"
  case "$verdict" in valid) ok "token file present and within its advisory expiry";; expired) wr "token file is EXPIRED: the morning login is needed (expected before the login)";; *) bad "token file unreadable";; esac
else
  wr "no token file: the morning login is needed (expected before the first login)"
fi

# 4. kite.env: variable NAMES and the plan value only
KENV="$COMPOSE_DIR/kite.env"
if [ -f "$KENV" ]; then
  names="$(sed -E 's/=.*//' "$KENV" | grep -v '^#' | sort -u | tr '\n' ' ')"
  for n in TWINS_KITE_API_KEY TWINS_KITE_API_SECRET TWINS_KITE_PLAN; do case " $names" in *" $n "*) ;; *) bad "kite.env is missing $n";; esac; done
  plan="$(grep -E '^TWINS_KITE_PLAN=' "$KENV" | tail -1 | cut -d= -f2)"
  if [ "$plan" = "connect" ]; then ok "kite.env: key, secret and plan=connect present (values not read)"; else bad "kite.env plan is '$plan', the feed needs connect"; fi
else bad "kite.env not found"; fi

# 5. safety flags inside the running containers
for s in api worker; do
  env="$("$DOCKER" exec "twins-staging-$s-1" sh -c 'echo LIVE=$LIVE_TRADING PAPER=$TWINS_PAPER_TRADING_ENABLED ENFORCE=$TWINS_AGENT_ENGINE_ENABLED SHADOW=$TWINS_AGENT_ENGINE_SHADOW' 2>/dev/null)"
  case "$env" in "LIVE=false PAPER=false ENFORCE= SHADOW=true") ok "$s flags: $env";; "") bad "$s container not reachable";; *) bad "$s flags unexpected: $env";; esac
done
rs="$("$DOCKER" exec twins-staging-worker-1 sh -c 'echo ${TWINS_REDUCE_ONLY_SHADOW:-unset}' 2>/dev/null)"
printf 'INFO  reduce-only sizing shadow flag: %s (switch on only after a clean feed run)\n' "${rs:-unknown}"

# 6. services up and the feed not already running
ps="$("$DOCKER" ps --format '{{.Names}} {{.Status}}' 2>/dev/null)"
for s in api worker alert-relay; do echo "$ps" | grep -q "twins-staging-$s-1 Up" && ok "$s is up" || bad "$s is not up"; done
echo "$ps" | grep -q "kite-ticker" && wr "kite-ticker is already running" || ok "kite-ticker is not running yet"
echo "$ps" | grep -q "twins-staging-provider-exporter-1 Up" && ok "provider exporter is up" || wr "provider exporter is not up"

# 7. provider data freshness (file modification time only). macro-context and market-quotes are SKIPPED by the exporter (reason no_fresh_index) while the Kite-fed indices are stale, so an old
#    modification time on those two is expected until the feed has run.
for f in macro-context.json market-quotes.json economic-calendar.json; do
  if [ -f "$PROVIDERS_DIR/$f" ]; then age=$(( (now_utc - $(stat -c %Y "$PROVIDERS_DIR/$f")) / 60 )); [ "$age" -le 150 ] && ok "$f rewritten $age min ago" || wr "$f last rewritten $age min ago"; else wr "$f missing"; fi
done

# 8. resources
free_mb=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo); [ "${free_mb:-0}" -ge 800 ] && ok "memory available ${free_mb} MiB" || wr "memory available only ${free_mb} MiB"
disk=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}'); [ "${disk:-100}" -le 85 ] && ok "root disk ${disk}% used" || wr "root disk ${disk}% used"

printf 'SUMMARY  pass=%s warn=%s fail=%s  -> %s\n' "$pass" "$warn" "$fail" "$([ "$fail" -eq 0 ] && echo 'no blocker found (WARNs such as an expired token are expected before the login)' || echo 'DO NOT START THE FEED until the FAILs are resolved')"
exit 0
