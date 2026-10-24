# 04 Data and integrations audit

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

## Telegram
| Aspect | Finding | Evidence |
|---|---|---|
| Access | User API via TDLib, read-only, 14 allowed request types, single approved chat set from host env | tdlib.py:11; tests/unit/tools/telegramCapture.test.ts |
| History | Pilot only: <=50 messages, <=7 days, <=6 pages; one import ran (32 rows) | history.py:17-19 |
| Rate limits | Flood-wait recorded as `blocked_until`; exit 75; 15-minute fatal hold bounds restart loops | service.py:9-17 |
| Edits | Recorded as revisions; history import cannot recover pre-edit text (first_seen_edited flag exists) | telegramRevisions.ts; migration 0007 |
| Deletions | Permanent server deletions only; none visible for pre-capture period | mapping.py:111-119 |
| Replies/forwards | Not captured | MISSING (TG-06) |
| Time | timestamptz; no IST/session derivation | UNVERIFIED (TG-09) |
| Bot API | Used only for the approval bot (separate token); webhook route exists in code but is not publicly routed (503) per earlier audit; not re-checked | apps/api/src/index.ts:352 |

## Market data
| Aspect | Finding |
|---|---|
| Provider | Yahoo unofficial chart endpoint, daily bars only (`adapters/market/src/yahoo.ts`); terms not evidenced |
| Persistence | `market_observations`: 0 rows on staging; scheduler off |
| Quality | Dimension rules exist (completeness, freshness [7-day age], anomaly, conflict) |
| Options | No premium, OI, IV, bid/ask or expired-contract data; `premium.ts` reports unavailable |
| Instruments | `instruments`: exchange, symbol, lot_size, tick_size (nullable); no expiry/strike/right; contract identity inside claim JSON and an offline provider snapshot (not configured on staging) |
| Calendar/sessions | none |
| Entitlements | none evidenced; no vendor chosen |

## News, macro, AI, broker
News: GDELT metadata adapter (evidence only; 0 rows on staging). Macro: 16-line stub. AI: 21-line stub, imported by nothing. Broker: 35-line contracts stub, nothing imports it.

## Do-not-assume list (carried into P04)
Any paid provider's coverage of expired options, historical bid/ask, intrabar bars, or OI/IV must be proven by a recorded probe against the owner's actual account before it is relied upon.
