#!/usr/bin/env bash
# TWINS provider egress allow-list (the same mechanism as the Kite one, D-087 / D-091). BUILT 2026-11-06, NOT INSTALLED: this file only exists in the repository until the owner approves the host install (docs/twins/PROVIDERS.md section 4).
# Limits the providers network (10.0.29.0/24: the provider exporter and nothing else) to the addresses that exactly two host names currently resolve to (api.gdeltproject.org, api.stlouisfed.org), tcp/443 only, and DROPS everything else it sends. Reversible: ONE ipset, ONE dedicated chain and ONE jump rule in DOCKER-USER; no other rule, chain, policy or table is touched (see the unit tests).
# ONE jump rule in DOCKER-USER; no other rule, chain, policy or table is touched (see the unit tests).
#   twins-providers-egress.sh apply      create the set and the chain, run one refresh, insert the jump LAST (refuses if the chain exists)
#   twins-providers-egress.sh refresh    resolve api.gdeltproject.org and api.stlouisfed.org (A records), validate, add to the set with a 10-minute timeout, write the status file; exit 0 (a failed refresh is recorded, not fatal)
#   twins-providers-egress.sh status     exit 0 only if the jump, the chain and the set are exactly as built AND the last complete refresh is younger than 5 minutes AND the set is not empty (the START-UP CHECK)
#   twins-providers-egress.sh check-stale  raise the WARNING `providers.egress_stale` through twins-alert.sh when the last complete refresh is older than 5 minutes (or never happened); exit 0
#   twins-providers-egress.sh simulate <ip> [port]   DRY_RUN only: prints ALLOW or BLOCK for a connection from the providers network, using the simulated set and its expiry
#   twins-providers-egress.sh remove     delete the jump, flush and delete the chain, destroy the set (full rollback)
#   DRY_RUN=1: nothing touches iptables or ipset; every command is PRINTED, and the set, its expiry and the chain state are simulated in files under $STATE_DIR (used by the tests and for review).
# Fail closed: addresses expire 10 minutes after their last refresh, so a stopped refresh job leaves the network empty-handed, never open. Name resolution failures change nothing.
set -euo pipefail
SUBNET="10.0.29.0/24"
CHAIN="TWINS-PROVIDERS-EGRESS"
SET="twins_prov_dst"
PORT="443"
HOSTS=("api.gdeltproject.org" "api.stlouisfed.org")
TTL=600
STALE=300
MAX_PER_HOST=16 # a CDN host can answer with several addresses and rotate them; if a live test shows connections to addresses outside the resolved set, move to a hostname-filtering proxy instead (docs/twins/PROVIDERS.md)
DRY="${DRY_RUN:-0}"
MONITOR_DIR="${MONITOR_DIR:-/var/lib/twins-monitor}"
STATE_DIR="${STATE_DIR:-$MONITOR_DIR/providers-egress}"
STATUS="$MONITOR_DIR/providers-egress.json"
ALERT_BIN="${ALERT_BIN:-/usr/local/sbin/twins-alert.sh}"
NOW="${TWINS_NOW:-$(date +%s)}"
[[ "$NOW" =~ ^[0-9]{1,10}$ ]] || { echo "bad TWINS_NOW" >&2; exit 2; }
# the resolver and the tool names are fixed on a real host; only a dry run may substitute them (so a test never makes a network call)
if [ "$DRY" = "1" ]; then RESOLVER="${RESOLVER:-resolve-stub}"; else RESOLVER="dig"; fi
IPT=(iptables -w 5)
run() { if [ "$DRY" = "1" ]; then echo "$*"; else "$@"; fi; }
need_root() { [ "$DRY" = "1" ] || [ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }; }
mkdir -p "$MONITOR_DIR" "$STATE_DIR" 2>/dev/null && chmod 700 "$MONITOR_DIR" "$STATE_DIR" 2>/dev/null || true

# ── simulated state (dry run only) ──
SIM_SET="$STATE_DIR/set.sim"        # "ip expires_epoch"
SIM_CHAIN="$STATE_DIR/chain.sim"    # "built" once apply completed, with the jump
# ── set operations ──
set_create() { if [ "$DRY" = "1" ]; then echo "ipset create $SET hash:ip timeout $TTL -exist"; : > "$SIM_SET"; else ipset create "$SET" hash:ip timeout "$TTL" -exist; fi; }
set_add() { # $1 ip
  if [ "$DRY" = "1" ]; then echo "ipset add $SET $1 timeout $TTL -exist"; grep -v "^$1 " "$SIM_SET" 2>/dev/null > "$SIM_SET.tmp" || true; echo "$1 $((NOW + TTL))" >> "$SIM_SET.tmp"; mv "$SIM_SET.tmp" "$SIM_SET"
  else ipset add "$SET" "$1" timeout "$TTL" -exist; fi
}
set_active() { # prints the addresses that have not expired
  if [ "$DRY" = "1" ]; then awk -v now="$NOW" '$2 > now {print $1}' "$SIM_SET" 2>/dev/null || true
  else ipset list "$SET" 2>/dev/null | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+ /{print $1}' || true; fi
}
set_destroy() { if [ "$DRY" = "1" ]; then echo "ipset destroy $SET"; rm -f "$SIM_SET"; else ipset destroy "$SET" 2>/dev/null || true; fi; }

# ── resolution + validation ──
# A poisoned or odd answer must never open an internal or special-purpose address: only public unicast IPv4 passes.
valid_public_ipv4() {
  local ip="$1" a b c d
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a="${BASH_REMATCH[1]}"; b="${BASH_REMATCH[2]}"; c="${BASH_REMATCH[3]}"; d="${BASH_REMATCH[4]}"
  for o in "$a" "$b" "$c" "$d"; do [ "$((10#$o))" -le 255 ] || return 1; done
  a=$((10#$a)); b=$((10#$b))
  [ "$a" -eq 0 ] || [ "$a" -eq 10 ] || [ "$a" -eq 127 ] || [ "$a" -ge 224 ] && return 1
  [ "$a" -eq 169 ] && [ "$b" -eq 254 ] && return 1
  [ "$a" -eq 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 1
  [ "$a" -eq 192 ] && [ "$b" -eq 168 ] && return 1
  [ "$a" -eq 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 1
  return 0
}
resolve_host() { # prints valid public IPv4s of a host (max MAX_PER_HOST); nothing on failure
  local out n=0 line
  if [ "$RESOLVER" = "dig" ]; then out="$(dig +short +time=3 +tries=1 A "$1" 2>/dev/null || true)"; else out="$("$RESOLVER" "$1" 2>/dev/null || true)"; fi
  while IFS= read -r line; do
    line="${line//[[:space:]]/}"
    [ -z "$line" ] && continue
    if valid_public_ipv4 "$line" && [ "$n" -lt "$MAX_PER_HOST" ]; then echo "$line"; n=$((n + 1)); fi
  done <<<"$out"
}
last_ok() { { sed -n 's/.*"last_ok_epoch":\([0-9]*\).*/\1/p' "$STATUS" 2>/dev/null | head -1; } || true; }
write_status() { # $1 ok  $2 last_ok_epoch  $3 reason  $4 addresses  $5 hosts-json
  umask 077
  printf '{"ok":%s,"ts":"%s","epoch":%s,"last_ok_epoch":%s,"reason":"%s","addresses":%s,"hosts":%s}\n' "$1" "$(date -u +%FT%TZ)" "$NOW" "${2:-0}" "$3" "$4" "$5" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}
do_refresh() {
  local total=0 failed=0 hostsjson="" h ips ip count
  for h in "${HOSTS[@]}"; do
    ips="$(resolve_host "$h")"; count=0
    for ip in $ips; do set_add "$ip"; count=$((count + 1)); total=$((total + 1)); done
    [ "$count" -eq 0 ] && failed=1
    hostsjson+="${hostsjson:+,}\"$h\":$count"
  done
  local prev; prev="$(last_ok)"; prev="${prev:-0}"
  if [ "$failed" -eq 0 ]; then write_status true "$NOW" "" "$(set_active | wc -l | tr -d ' ')" "{$hostsjson}"; echo "refresh ok: $total addresses"
  else write_status false "$prev" "resolution_failed" "$(set_active | wc -l | tr -d ' ')" "{$hostsjson}"; echo "refresh incomplete: a host did not resolve; existing entries unchanged"; fi
}

cmd="${1:-}"
case "$cmd" in
  apply)
    need_root
    if [ "$DRY" = "1" ]; then [ ! -e "$SIM_CHAIN" ] || { echo "chain $CHAIN already exists: remove first" >&2; exit 3; }
    elif "${IPT[@]}" -S "$CHAIN" >/dev/null 2>&1; then echo "chain $CHAIN already exists: run status, or remove then apply" >&2; exit 3; fi
    set_create
    do_refresh   # the set is filled BEFORE the chain can drop anything
    run "${IPT[@]}" -N "$CHAIN"
    run "${IPT[@]}" -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment "twins-providers: replies" -j ACCEPT
    run "${IPT[@]}" -A "$CHAIN" -p tcp --dport "$PORT" -m set --match-set "$SET" dst -m comment --comment "twins-providers: api.gdeltproject.org api.stlouisfed.org" -j ACCEPT
    run "${IPT[@]}" -A "$CHAIN" -m limit --limit 5/min --limit-burst 5 -j LOG --log-prefix "twins-providers-egress-drop: "
    run "${IPT[@]}" -A "$CHAIN" -m comment --comment "twins-providers: drop everything else" -j DROP
    if [ "$DRY" = "1" ]; then echo "iptables -w 5 -I DOCKER-USER 1 -s $SUBNET -j $CHAIN"; echo built > "$SIM_CHAIN"
    elif ! "${IPT[@]}" -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null; then "${IPT[@]}" -I DOCKER-USER 1 -s "$SUBNET" -j "$CHAIN"; fi  # the jump LAST: no fail-open window
    ;;
  refresh)
    need_root
    do_refresh
    ;;
  status)
    if [ "$DRY" = "1" ]; then [ -e "$SIM_CHAIN" ] || { echo "MISSING: chain and jump (dry run)"; exit 1; }
    else
      need_root
      "${IPT[@]}" -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null || { echo "MISSING: jump from DOCKER-USER"; exit 1; }
      rules="$("${IPT[@]}" -S "$CHAIN")"
      [ "$(tail -n 1 <<<"$rules")" = "-A $CHAIN -m comment --comment \"twins-providers: drop everything else\" -j DROP" ] || { echo "MISSING: final DROP"; exit 1; }
      grep -q -- "--match-set $SET dst" <<<"$rules" || { echo "MISSING: set rule"; exit 1; }
      ipset list -n "$SET" >/dev/null 2>&1 || { echo "MISSING: ipset $SET"; exit 1; }
    fi
    n="$(set_active | wc -l | tr -d ' ')"
    [ "$n" -ge 1 ] || { echo "EMPTY: no active address (refresh stopped or never succeeded)"; exit 1; }
    lo="$(last_ok)"
    [[ "$lo" =~ ^[0-9]+$ ]] && [ "$lo" -gt 0 ] || { echo "STALE: no complete refresh recorded"; exit 1; }
    age=$((NOW - lo))
    [ "$age" -le "$STALE" ] || { echo "STALE: last complete refresh $age s ago (limit $STALE s)"; exit 1; }
    echo "OK: $n active addresses for ${HOSTS[*]} (tcp/$PORT then DROP for $SUBNET); last complete refresh ${age}s ago"
    ;;
  check-stale)
    lo="$(last_ok)"; lo="${lo:-0}"
    age=$((NOW - lo)); [ "$lo" -gt 0 ] || age=999999
    if [ "$age" -gt "$STALE" ]; then
      echo "stale: last complete refresh $age s ago"
      "$ALERT_BIN" --throttle 3600 --detail "ageSeconds=$age" --detail "windowSeconds=$STALE" --detail "reason=refresh_stale" providers.egress_stale WARNING twins-providers-egress refresh_stale "The providers egress allow-list has not been refreshed recently; the providers network will lose access as its addresses expire."
    else echo "fresh: ${age}s"; fi
    ;;
  simulate)
    [ "$DRY" = "1" ] || { echo "simulate is a dry-run command" >&2; exit 2; }
    ip="${2:-}"; port="${3:-443}"
    [ -e "$SIM_CHAIN" ] || { echo "ALLOW (no chain applied: nothing is filtered)"; exit 0; }
    if [ "$port" = "$PORT" ] && set_active | grep -qx -- "$ip"; then echo "ALLOW $ip:$port"; else echo "BLOCK $ip:$port"; fi
    ;;
  remove)
    need_root
    if [ "$DRY" = "1" ]; then echo "iptables -w 5 -D DOCKER-USER -s $SUBNET -j $CHAIN"; echo "iptables -w 5 -F $CHAIN"; echo "iptables -w 5 -X $CHAIN"; rm -f "$SIM_CHAIN"
    else
      while "${IPT[@]}" -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null; do "${IPT[@]}" -D DOCKER-USER -s "$SUBNET" -j "$CHAIN"; done
      if "${IPT[@]}" -S "$CHAIN" >/dev/null 2>&1; then "${IPT[@]}" -F "$CHAIN"; "${IPT[@]}" -X "$CHAIN"; fi
    fi
    set_destroy
    ;;
  *) echo "usage: $0 apply | refresh | status | check-stale | simulate <ip> [port] | remove" >&2; exit 2;;
esac
