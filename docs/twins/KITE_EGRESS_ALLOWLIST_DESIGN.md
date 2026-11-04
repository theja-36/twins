# Kite egress allow-list: design (nothing applied; no firewall change was made)

> **Decision 2026-11-03 (D-087): Option B selected** (hostname-pinned address set, 30 s refresh, 10 min entry expiry, one reversible chain, staleness alert, start-up check). Still design only: the implementation task (script, units, DRY_RUN tests) has not started and no firewall change has been made.

> Written 2026-11-03 for the owner's decision. Observations below were DNS queries only (no Kite request). Prerequisite for the first live feed run (see KITE_INTEGRATION.md "Feed readiness"); the feed stays off until the owner decides on Connect (decision of 2026-11-03: wait).

## 1. What must be reachable, and what must not
The Kite feed runs in one container (`kite-ticker`, plus the one-shot `kite-login`) on its own network `twins_kite_egress` (10.0.28.0/24, IPv4 only). It needs exactly two destinations, both on tcp/443:

| Host | Used for | What the DNS shows (2026-11-03, from the staging host) |
|---|---|---|
| `api.kite.trade` | REST: instruments dump, candles, quotes, session exchange, profile | **Cloudflare** (AS13335): A 104.16.33.50 and 104.16.34.50, AAAA 2606:4700::6810:2132 / ::6810:2232, TTL **300 s**; inside Cloudflare's published range 104.16.32.0/20 |
| `ws.kite.trade` | WebSocket market-data stream | CNAME to an **AWS ELB in ap-south-1 (Mumbai)** (`kite-prod-ticker-connect-....elb.amazonaws.com`), A 3.6.15.65 and 16.4.151.142 (AWS AS16509: 3.6.0.0/15, 16.4.128.0/17), TTL **60 s** |
| `kite.zerodha.com` | the human login page | Cloudflare. **Not needed from the host**: the morning login happens in the owner's browser; only the resulting `request_token` is typed into `kite-login` |

Everything else must stay blocked from that network: it carries a live broker token (read-only, but still an account credential). No database, no Redis and no other TWINS network is attached to it (verified by a compose test).

## 2. Why this is harder than the Telegram allow-list
`capture-egress-firewall.sh` pins the capture network to Telegram's **published** IPv4 ranges (a short, stable list). Zerodha publishes no address list that I could find, and the two hosts sit behind addresses that rotate: Cloudflare anycast addresses for REST, and a load balancer whose addresses change with a 60-second TTL for the WebSocket. Pinning today's four addresses would break within hours. (Confirm with Zerodha support whether they publish or guarantee anything; I assumed they do not.)

## 3. Options
| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Published vendor ranges** | Allow Cloudflare's published IPv4 ranges and AWS's published `ap-south-1` ranges (EC2/ELB) on tcp/443 | simple, same pattern as capture, no refresh job | very broad: every Cloudflare site and every AWS Mumbai host is reachable; ranges change, so a refresh job is still needed; weak as an exfiltration control |
| **B. Hostname-pinned address set (recommended)** | A root job resolves exactly `api.kite.trade` and `ws.kite.trade` (A records) every 30 s and keeps the results in an `ipset` with a 10-minute timeout; one dedicated iptables chain in `DOCKER-USER` allows 10.0.28.0/24 -> that set on tcp/443 and DROPs the rest | narrow (only what those names currently resolve to); follows the rotation; no new container; reversible; same style and tooling as the capture firewall | a brand-new address can be blocked for up to one refresh interval (the ticker already reconnects with bounded backoff); needs a refresh job and an alert when it stops |
| **C. Forward proxy with a hostname allow-list** | A small proxy (CONNECT to exactly the two names:443) is the container's only route | exact, name-based, rotation-proof | a new service to run and secure; Node's `fetch` and the built-in WebSocket do not honour `HTTPS_PROXY` by default, so the Kite client would need a proxy-aware dispatcher (code change in the package) |
| D. No control | open egress | trivial | rejected: a compromised feed container could talk anywhere |

## 4. Recommendation: B, with C kept as the long-term upgrade
Design of B (all of it new, none of it applied):
1. **`twins-kite-egress.sh`** (host, root), modelled on `capture-egress-firewall.sh`:
   * `apply` creates the ipset `twins_kite_dst` (`hash:ip timeout 600`), the chain `TWINS-KITE-EGRESS` with, in order: ACCEPT established/related; ACCEPT `-s 10.0.28.0/24 -p tcp --dport 443 -m set --match-set twins_kite_dst dst`; ACCEPT DNS to the Docker resolver only; DROP (with a rate-limited LOG) everything else from 10.0.28.0/24; and ONE jump from `DOCKER-USER`. It refuses if the chain exists.
   * `refresh` resolves the two names (A records only; a result outside IPv4 or an empty result changes nothing), adds the addresses with `ipset add -exist` (refreshing the timeout), and writes a status file; it never removes an address early.
   * `status` exits 0 only if the jump, the chain and the set are exactly as built; `remove` deletes the jump, the chain and the set (full rollback).
   * `DRY_RUN=1` prints every command (the unit tests run in this mode, as for the capture script).
2. **A timer** (`twins-kite-egress-refresh.timer`, every 30 s, enabled only with the feed) and a **health alert**: if the last successful refresh is older than 5 minutes, `twins-alert.sh` raises a WARNING; a ticker that cannot connect also shows up as `kite.feed.*` events.
3. **IPv6**: the network is IPv4-only (no `enable_ipv6`), so AAAA records are ignored; a test asserts the compose network has no IPv6.
4. **Persistence**: like the capture rules, not persistent across a reboot by default; a systemd unit (as for `twins-capture-egress-firewall.service`) reapplies the chain and runs one refresh before the feed may start; the feed service is not started if `status` fails.
5. **DNS exposure** (known limit): the container still resolves names through Docker's resolver, so DNS itself is a possible low-bandwidth channel; accepted for read-only market data, revisit if Option C is built.
6. **What this does not protect**: addresses inside the allowed set are shared infrastructure (Cloudflare/AWS), so a compromised container could in principle reach another tenant that happens to share an address. Mitigation is the narrow set, the absence of any secret other than the Kite token in that container, the 0600 token store and the daily token expiry.

## 5. Acceptance criteria (before the first live start)
1. `DRY_RUN` output reviewed by the owner; `apply` creates exactly one chain, one set and one jump; `remove` restores the previous state (verified with `iptables -S` before and after).
2. From a throwaway container on `twins_kite_egress`: a TCP connect to an address resolved for `api.kite.trade` and for `ws.kite.trade` on 443 succeeds (TCP connect only; **no HTTP request is sent to Kite**); a connect to an unrelated public address, and to any port other than 443, is dropped.
3. After the refresh job is stopped for 11 minutes the set empties and connects fail closed; restarting it restores access.
4. The refresh-staleness alert fires in a test (simulated stale status file) and is delivered through the relay.
5. `status` is part of the feed's start-up checklist; the other TWINS networks and the capture chain are byte-identical before and after.

## 6. Open questions for the owner
* Accept Option B (and its up-to-30-second window for a brand-new address), or prefer the broader Option A for simplicity, or invest in Option C?
* Should Zerodha be asked in writing about published address ranges or a static egress arrangement?
* Is it acceptable that DNS is not restricted for this network?

## 7. Implementation status (2026-11-04, D-088): code and dry-run tests only - NOT applied, NOT installed
| Piece | File | Notes |
|---|---|---|
| Firewall + set + refresh script | `infrastructure/staging/twins-kite-egress.sh` | `apply` / `refresh` / `status` / `check-stale` / `simulate` / `remove`; `DRY_RUN=1` prints every command and simulates the set, its expiry and the chain in files, so the whole lifecycle is testable without iptables, ipset or DNS |
| Boot unit | `twins-kite-egress.service` | removes a leftover chain, applies, then fails unless `status` passes; `ExecStop` removes the rules |
| Refresh timer | `twins-kite-egress-refresh.{service,timer}` | every 30 s: `refresh`, then `check-stale`; alerts on failure |
| Start-up check | `twins-kite-feed-start.sh` | the only supported way to start `kite-ticker`: refuses (exit 3) unless `twins-kite-egress.sh status` passes |
| Tests | `tests/unit/infrastructure/kiteEgress.test.ts` (13 tests) | commands, rollback, allow/block simulation, rotation, expiry, fail-closed, resolution failure, poisoned DNS, units, start gate |

Behaviour as built:
* **Set:** `hash:ip timeout 600`, filled by `refresh` (A records of exactly `api.kite.trade` and `ws.kite.trade`; the host list is a constant, not configuration). Entries are only ever added or renewed; they leave by expiry after 10 minutes, so a stopped refresh job fails closed.
* **Validation:** only public unicast IPv4 is accepted. Private (10/8, 172.16/12, 192.168/16), loopback, link-local (including the cloud metadata address), CGNAT (100.64/10), multicast, zero and malformed answers are discarded, at most 16 addresses per host; a poisoned DNS answer therefore cannot open an internal address.
* **Chain** (`TWINS-KITE-EGRESS`, jumped to from `DOCKER-USER` for 10.0.28.0/24, inserted LAST): ACCEPT established/related; ACCEPT tcp/443 to the set; rate-limited LOG; DROP. `apply` fills the set before the chain exists, and refuses if the chain exists.
* **Staleness:** the status file records `last_ok_epoch` (the last refresh in which BOTH names resolved). `check-stale` raises WARNING `kite.egress_stale` (details `ageSeconds`, `windowSeconds`, `reason` only; throttled to 1 per hour) when it is older than 5 minutes or missing; `status` fails for the same reason or an empty set.
* **Resolution failure:** recorded as `resolution_failed`, never fatal, existing entries untouched.

Deviation from section 4: the design listed "ACCEPT DNS to the Docker resolver" in the chain. Docker's embedded resolver (127.0.0.11) lives INSIDE the container's network namespace and forwards from the host's own namespace, so container DNS never crosses `DOCKER-USER`; no DNS rule is needed (or possible) in this chain, and none was written. The DNS-exposure limit of section 4.5 stands.

Not done, deliberately: nothing was installed or enabled on the host, no iptables/ipset command ran outside a dry run, and no Kite endpoint received a request. Remaining before the first live start: an owner-approved host install (with the owner reviewing `DRY_RUN` output), acceptance tests 2-5 of section 5 on the host with a throwaway container (TCP connects only), and the other live-run gates (Connect decision, callback-origin closure, login, supervised first run).

## 8. Installed and verified on the staging host (2026-11-04, D-091)
* **Prerequisite installed (owner-approved):** `apt install ipset` (`ipset 7.19-1ubuntu2` + `libipset13`); kernel modules `ip_set`, `xt_set`, `xt_conntrack`, `xt_limit` unchanged.
* **Installed:** `/opt/twins-staging/twins-kite-egress.sh` and `twins-kite-feed-start.sh`; units `twins-kite-egress.service` (enabled; applied at install, `status` OK) and `twins-kite-egress-refresh.{service,timer}` (enabled, every 30 s). Rules in force: set `twins_kite_dst` (4 addresses), chain `TWINS-KITE-EGRESS`, ONE jump from `DOCKER-USER` for 10.0.28.0/24. No container is on that network yet, so no running service was affected; `iptables -S` is identical to before apart from the `TWINS-KITE` lines (diffed).
* **Acceptance tests (section 5), real host, a throwaway container on a temporary 10.0.28.0/24 network, TCP connect only - no TLS, no HTTP, no bytes sent:**
  1. `api.kite.trade` (104.16.33.50, 104.16.34.50) and `ws.kite.trade` (3.6.15.65, 16.4.151.142) on 443: **CONNECTED** (1-181 ms).
  2. `1.1.1.1:443`, `8.8.8.8:443`, a Kite address on ports 80 / 8443 / 22, and a private address: **BLOCKED** (timeout); the chain's DROP counter rose accordingly.
  3. Refresh job stopped: at +307 s `status` failed (STALE) and `check-stale` raised WARNING `kite.egress_stale`, **forwarded to Telegram by the relay** (journal line `relay.forwarded kite.egress_stale WARNING`); at +607 s the set was empty, `status` said EMPTY and all four Kite addresses were **BLOCKED** (fail closed); restarting the job restored `status` OK and the connects.
  4. All other firewall rules byte-identical before and after; running containers untouched; the temporary network was removed.
* **Still not done:** the feed itself (no `kite.env` key/secret, nothing deployed, nothing started); the start gate `twins-kite-feed-start.sh` is installed but unused.
