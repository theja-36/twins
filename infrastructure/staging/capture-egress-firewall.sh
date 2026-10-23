#!/usr/bin/env bash
# TWINS capture egress firewall (host, DOCKER-USER). Limits the capture egress network (10.0.24.0/24) to Telegram's published IPv4
# datacenter ranges on TCP 443 and DROPS everything else it sends. Reversible: ONE dedicated chain plus ONE jump rule; no other rule,
# chain, policy, table or tool (ufw, nat, INPUT) is touched.
#   capture-egress-firewall.sh apply  <cidr-file>    create the chain, then the jump (refuses if the chain exists)
#   capture-egress-firewall.sh remove                 delete the jump, flush and delete the chain (full rollback)
#   capture-egress-firewall.sh status <cidr-file>     exit 0 only if the jump exists and the chain is exactly as `apply` builds it
#   DRY_RUN=1 capture-egress-firewall.sh apply <cidr-file>   print the iptables commands instead of running them
# Not persistent across a reboot (rules are lost; the capture service has restart "no" and must be started only after `status` passes).
set -euo pipefail
SUBNET="10.0.24.0/24"
CHAIN="TWINS-CAPTURE-EGRESS"
PORT="443"
IPT=(iptables -w 5)
run() { if [ "${DRY_RUN:-0}" = "1" ]; then echo "iptables $*"; else "${IPT[@]}" "$@"; fi; }
read_cidrs() {
  local file="${1:?cidr file required}"
  [ -r "$file" ] || { echo "cannot read $file" >&2; exit 2; }
  CIDRS=()
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    [[ "$line" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]] || { echo "refusing: not an IPv4 CIDR: $line" >&2; exit 2; }
    CIDRS+=("$line")
  done < "$file"
  [ "${#CIDRS[@]}" -ge 1 ] || { echo "refusing: empty CIDR list" >&2; exit 2; }
}
cmd="${1:-}"
case "$cmd" in
  apply)
    read_cidrs "${2:-}"
    [ "${DRY_RUN:-0}" = "1" ] || [ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
    # The jump is inserted LAST, after the chain is complete, and an existing chain is never flushed while a jump may point at it
    # (that would briefly fail open). To refresh the list: `remove`, then `apply` (only while the capture service is stopped).
    if [ "${DRY_RUN:-0}" != "1" ] && "${IPT[@]}" -S "$CHAIN" >/dev/null 2>&1; then
      echo "chain $CHAIN already exists: run status, or remove then apply (capture stopped)" >&2; exit 3
    fi
    run -N "$CHAIN"
    for cidr in "${CIDRS[@]}"; do
      run -A "$CHAIN" -d "$cidr" -p tcp --dport "$PORT" -m comment --comment "twins-capture: telegram" -j ACCEPT
    done
    run -A "$CHAIN" -m limit --limit 5/min --limit-burst 5 -j LOG --log-prefix "twins-capture-egress-drop: "
    run -A "$CHAIN" -m comment --comment "twins-capture: drop everything else" -j DROP
    if [ "${DRY_RUN:-0}" = "1" ] || ! "${IPT[@]}" -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null; then
      run -I DOCKER-USER 1 -s "$SUBNET" -j "$CHAIN"
    fi
    ;;
  remove)
    [ "${DRY_RUN:-0}" = "1" ] || [ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
    if [ "${DRY_RUN:-0}" = "1" ]; then
      run -D DOCKER-USER -s "$SUBNET" -j "$CHAIN"; run -F "$CHAIN"; run -X "$CHAIN"
    else
      while "${IPT[@]}" -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null; do run -D DOCKER-USER -s "$SUBNET" -j "$CHAIN"; done
      if "${IPT[@]}" -S "$CHAIN" >/dev/null 2>&1; then run -F "$CHAIN"; run -X "$CHAIN"; fi
    fi
    ;;
  status)
    read_cidrs "${2:-}"
    "${IPT[@]}" -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null || { echo "MISSING: jump from DOCKER-USER"; exit 1; }
    rules="$("${IPT[@]}" -S "$CHAIN")"
    accepts="$(grep -c -- "-p tcp -m tcp --dport $PORT .*-j ACCEPT" <<<"$rules" || true)"
    [ "$accepts" = "${#CIDRS[@]}" ] || { echo "MISMATCH: $accepts accept rules, expected ${#CIDRS[@]}"; exit 1; }
    for cidr in "${CIDRS[@]}"; do grep -q -- "-d $cidr " <<<"$rules" || { echo "MISSING: $cidr"; exit 1; }; done
    [ "$(tail -n 1 <<<"$rules")" = "-A $CHAIN -m comment --comment \"twins-capture: drop everything else\" -j DROP" ] || { echo "MISSING: final DROP"; exit 1; }
    echo "OK: $accepts Telegram ranges (tcp/$PORT) then DROP for $SUBNET"
    "${IPT[@]}" -L "$CHAIN" -n -v -x | sed -n '1,2p;$p'
    ;;
  *) echo "usage: $0 apply <cidr-file> | remove | status <cidr-file>" >&2; exit 2;;
esac
