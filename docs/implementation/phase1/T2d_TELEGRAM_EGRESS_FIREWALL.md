# T2d - Telegram-only egress for the capture network (APPLIED on the staging host 2026-10-23; local, reversible; capture NOT started)

## 1. Source of the ranges
- URL: `https://core.telegram.org/resources/cidr.txt` (Telegram's official list of datacenter ranges), fetched 2026-10-23 09:25 GMT (HTTP 200, `last-modified: Fri, 01 Oct 2021 16:51:55 GMT`, 227 bytes).
- sha256 of the file as served: `3ecd072cedf72eceee6961b18a51e37f905d5ce4a656a5d24cf5fea63e6ec651`. It contains 9 IPv4 and 5 IPv6 ranges.
- IPv4 (applied; stored in `infrastructure/staging/telegram-cidr-ipv4.txt`, sha256 `e03cdce9ba86e0c7b4a689f5a1574d24c5f4689bef8a5518f0e9bdbb84a265c5`):
  `91.108.56.0/22  91.108.4.0/22  91.108.8.0/22  91.108.16.0/22  91.108.12.0/22  149.154.160.0/20  91.105.192.0/23  91.108.20.0/22  185.76.151.0/24`
- IPv6 (recorded, NOT applied: the egress network is IPv4-only, so the container has no IPv6 route):
  `2001:b28:f23d::/48  2001:b28:f23f::/48  2001:67c:4e8::/48  2001:b28:f23c::/48  2a0a:f280::/32`
- The file is old (2021). A Telegram address outside it fails closed (blocked). Re-fetch and compare before relying on it long term.

## 2. Rules (host `iptables` 1.8.10 nf_tables backend; ufw is active and was not touched)
One dedicated chain and ONE jump, inserted last (after the chain is complete) at position 1 of `DOCKER-USER`:
```
iptables -N TWINS-CAPTURE-EGRESS
iptables -A TWINS-CAPTURE-EGRESS -d <each IPv4 range> -p tcp --dport 443 -m comment --comment "twins-capture: telegram" -j ACCEPT   (9 rules)
iptables -A TWINS-CAPTURE-EGRESS -m limit --limit 5/min --limit-burst 5 -j LOG --log-prefix "twins-capture-egress-drop: "
iptables -A TWINS-CAPTURE-EGRESS -m comment --comment "twins-capture: drop everything else" -j DROP
iptables -I DOCKER-USER 1 -s 10.0.24.0/24 -j TWINS-CAPTURE-EGRESS
```
Everything is done by `infrastructure/staging/capture-egress-firewall.sh apply|remove|status <cidr-file>` (installed on the host as `/opt/twins-staging/capture-egress-firewall.sh`, root-only, with the CIDR file next to it). The six existing `DOCKER-USER` port-drop rules for `eth0` are untouched (verified identical before/after, apart from the new first rule). Only traffic whose SOURCE is `10.0.24.0/24` matches; SSH, the host, Traefik and other tenants are unaffected. Pre-change copies: `/opt/twins-staging/logs/iptables-filter-before-<stamp>.rules` and `docker-user-before-<stamp>.txt`.

## 3. Tests (throwaway containers from the capture image on `twins_egress`: uid 1000, read-only, no capabilities, no network other than egress; TCP handshake only, no Telegram protocol; the capture service was not started)
| Target | Before the rules | After the rules |
|---|---|---|
| Telegram `149.154.167.51:443`, `149.154.167.91:443`, `91.108.56.130:443` | reachable | **reachable** |
| `1.1.1.1:443`, `8.8.8.8:443`, `9.9.9.9:443` | reachable | **blocked** (timeout) |
| Telegram `149.154.167.51:80` (port not allowed) | reachable | **blocked** |
| `example.com` resolved inside the container, then TCP 443 to its IP | (host reaches it: 200) | **blocked** |
| `core.telegram.org` resolved, then TCP 443 to its IP (in a Telegram range) | - | **reachable** |
| DNS lookups (`core.telegram.org`, `example.com`) | resolve | **still resolve** (see 5) |
| host `10.0.24.1:22` (the host's SSH via the bridge gateway) | reachable | **still reachable** (see 5) |
Counters after the tests: ACCEPT rules matched 12 packets, the DROP rule 30, the LOG rule 5 (5 `twins-capture-egress-drop:` lines in the kernel log).

## 4. Rollback (one command, no other state)
`/opt/twins-staging/capture-egress-firewall.sh remove` (deletes the jump, flushes and deletes the chain). Full state restore if ever needed: `iptables-restore < /opt/twins-staging/logs/iptables-filter-before-<stamp>.rules` (review first: it replaces the whole filter table). Refresh the list: `remove`, edit the file, `apply` (only while the capture service is stopped: `apply` refuses to touch an existing chain).

## 5. Limits and residual risks (what this does NOT enforce)
1. **DNS is not restricted.** Docker's embedded resolver answers from the host's network namespace, so name resolution (and anything encoded in query names) is possible regardless of these rules. TDLib connects to datacenter addresses directly, so it should not need DNS, but this was not verified.
2. **The container can reach the host itself** through its bridge gateway (`10.0.24.1`, e.g. SSH on port 22): host-bound traffic is governed by the INPUT chain / ufw, not `DOCKER-USER`. Closing it needs a ufw/INPUT rule for the egress bridge (separate firewall approval).
3. **Not persistent across a reboot.** After a reboot the rules are gone and egress is open until `apply` is run again. The capture service has `restart: "no"`; before every start run `capture-egress-firewall.sh status <cidr-file>` (exit 0 required). A systemd oneshot (After=docker.service) would persist it; not installed (not approved).
4. **Only TCP 443 to the listed ranges.** If TDLib needs port 80/5222 or an address outside the (2021) list, connections will fail closed; this is unverified until the first real connection.
5. Telegram-only destination filtering is by address range, not by protocol or identity: anything else inside those ranges is allowed.
