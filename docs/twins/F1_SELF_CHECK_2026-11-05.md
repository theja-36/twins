# F1 implementer self-check (NOT an independent review)

> **Written by Claude, the assistant that wrote the code under review. This is a self-review, not an independent review. It certifies nothing. F1 remains OPEN.** A genuinely independent human reviewer is still required before F1 can be closed (Q-012). Reading only: no live host or database checks, no tests run by the assistant (the owner reported lint, typecheck and test green at the pinned commit). Recorded as D-096.

Date: 2026-11-05. Commit reviewed: `9ae70bb7`.

## Scope results
| # | Area | Verdict | Note |
|---|---|---|---|
| 1 | Shadow isolation | CONDITIONAL | Reads only, never throws, writes no `agent_*` row; kill-switch check first. Was awaited inline with no time limit (finding 1, fixed in this PR). |
| 2 | Config exclusivity | PASS | `enabled && shadow` rejected; flags must be `true`/`false`; shadow also refuses next to enforcing. |
| 3 | Enforcing hook | CONDITIONAL (partly reviewed) | Hook placement, fail-closed errors, `grantsApproval: false`, idempotent run key reviewed. `orchestrator.ts` / `synthesis.ts` internals NOT reviewed. |
| 4 | Approval re-check | PASS (static) | App check plus the same DB function inside `twins_record_risk_approval` (migrations 0027/0028). Not executed. |
| 5 | Inputs and privacy | CONDITIONAL (partly reviewed) | Signal context uses ids/timestamps only. `buildDecisionInputs` and the stored `inputSnapshot` NOT fully traced. |
| 6 | Kite read-only | PASS | GET-only allowlist plus the one `/session/token` POST; tests cover write verbs and path tricks; token file 0600. No live call made. |
| 7 | Egress and host | CONDITIONAL | Script fails closed; containers least-privilege. Live firewall NOT inspected; IPv6 not verified. |
| 8 | DB privileges | PASS (static) | `orders`/`fills`/`positions` read-only in `app-role.sql`; migration 0029 revokes writes. Live grants NOT queried. |

## Findings
| # | Severity | Where | Issue | Status |
|---|---|---|---|---|
| 1 | Medium | worker `agentShadowFor` / `runAgentEngineShadow` | No time limit on a shadow evaluation | Fixed in this PR: bounded at `SHADOW_TIMEOUT_MS` (8 s), returns `SHADOW_ERROR` / `SHADOW_TIMEOUT`; test added. **Must be deployed before shadow is enabled.** |
| 2 | Low-Med | `runAgentEngineShadow` | Shadow runs real agents/providers: real load; no test proves providers make no writes (a static grep found none) | Open |
| 3 | Low | `twins-kite-egress.sh`, `.service`, `twins-kite-feed-start.sh`, compose comment | Stale "NOT APPLIED / NOT INSTALLED" comments | Fixed in this PR (comments only) |
| 4 | Low | compose `kite-ticker` | Loads `kite.env`, which may carry the API secret the feed does not need | Fixed in this PR: `TWINS_KITE_API_SECRET: ""` overrides it for the ticker; the host file is unchanged. Not verified against the host file contents (deliberately not read). |
| 5 | Low | compose `kite-ticker` | Token directory mounted read-write | Fixed in this PR: `:ro`. Side effect: on a server-rejected token the ticker can no longer delete the stale token file; it still drops the token in memory and logs `tokenFileCleared: false`. The next login (kite-login, read-write) replaces the file. |
| 6 | Low | egress script | IPv4 only | Open (verify IPv6 is off on the Kite network) |
| 7 | Low (by design) | `researchEligibility.ts` | Engine disabled and no assessment: approval not blocked; read errors fail open in that case | Open: re-confirm before the engine is enabled |
| 8 | Info | `allowlist.ts` | Account-read GETs (orders, positions, margins) are allowed | Accepted |

## Verdict
Overall: **CONDITIONAL.** Nothing found lets shadow mode write, approve or place an order, and no path to a Kite write call. The conditional items, **especially finding 1**, must be fixed (and deployed) before shadow mode is enabled. Independent human review is still required.
