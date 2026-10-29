# TWINS BUILD AUDIT REPORT

- Audited: this repository (local checkout), branch `main`, HEAD `4646ee7` (2026-10-24), audit run 2026-10-29.
- Method: read source, schema, migrations, compose/CI, tests; ran `npx vitest run` (unit) once. Nothing else was executed and no repo file was modified (this report is the only file written).
- Verified directly: **72 unit test files / 938 tests pass** (12.7 s). **Integration tests (real Postgres+Redis) were NOT run** by this audit → their status is UNKNOWN (CI workflow `.github/workflows/ci.yml` defines them; a hosted CI run is not evidenced, see §9).
- The repo already contains self-audits (`docs/twins/*`, 127-requirement matrix). I treated them as claims, not evidence; where I cite them it is only to say my code reading agrees. My percentages are independent.
- Vocabulary used throughout: **EXISTS** (code present) / **WORKS** (runs, observed) / **TESTED** (automated test) / **SAFE** (production-safe).

---

## 1. EXECUTIVE SUMMARY

**What TWINS actually is today:** a well-engineered, security-conscious *Telegram options-claim intake and record-keeping pipeline* (stages 0–1, part of 2), plus a thin, deterministic, equity-only "evidence sufficiency" validator that is switched off in staging. It is **not** yet a trading-intelligence or capital-protection platform. There is no risk engine, no research-agent engine, no source scorecard, no trade lifecycle, no broker, no kill switch, no P&L, no learning loop.

| Metric | Value | Basis |
|---|---|---|
| Overall completion of the full master flow (stages 0–10) | **≈ 9 %** | Stage-weighted (see §3 table). Intake is ~55 % of one stage; everything downstream of the claim is ≤ 5 %. |
| Production-readiness | **≈ 3 %** | Intake/backup/hardening are good; but no CI evidence on hosted runner, no off-host backup, no alerting drill, no execution/risk code at all. |
| Safest operating mode today | **PAPER-equivalent "record-only" (effectively DRY_RUN of intake)** | `TRADING_MODE=paper`, `LIVE_TRADING=false` are literals in `infrastructure/staging/docker-compose.staging.yml:29-33`. There is no paper-trading engine either — "paper" currently means *nothing can trade because nothing exists that trades*. |

### Top 5 critical risks
1. **No execution-side safety layer exists to protect the *future* build** — `packages/risk/` and `packages/market/` are empty `.gitkeep` dirs; `risk_decisions`, `orders`, `fills`, `positions` tables exist (`packages/database/src/schema/{decisions,execution}.ts`) but **no code writes them**. The moment someone adds an order path, nothing structural (privilege, import boundary, kill switch) stops it except convention. (CRITICAL for the roadmap, not for today's behaviour.)
2. **`LIVE_TRADING` guard is inconsistent across processes.** Worker and scheduler `process.exit(1)` if true (`services/worker/src/index.ts:66`, `services/scheduler/src/index.ts:34`). The **API only reports it** (`apps/api/src/index.ts:282`), and the **approval bot and capture client never read it** (grep: no match in `services/approval-bot/src`, `services/telegram-capture`). `loadConfig` also lets `LIVE_TRADING=true` + `TRADING_MODE=live` through (`packages/config/src/index.ts:44`). There is no second independent gate (signed flag, DB row, human-typed confirmation).
3. **Equity validator can emit `APPROVE` without a stop-loss.** `validateSignalStructure` flags only the *fully bare* signal (no entry, no SL **and** no targets) and even that is non-blocking (`packages/decision-intelligence/src/structuralValidation.ts`, `isBare`). A signal with entry+target but **no SL** passes. This contradicts the master spec ("reject missing SL"). Mitigation today: staging runs `TWINS_TELEGRAM_OPTIONS_ONLY=true` so this path is unreachable there (`docker-compose.staging.yml`, worker `index.ts` gate 2). The *code* still contains it, and `APPROVE` naming collides with human "Approve" (finding F-003 in repo's own docs).
4. **Single-copy durability gap on intake** — API acknowledges (HTTP 200) after enqueueing to Redis; PostgreSQL write happens later in the worker (`apps/api/src/internalIngest.ts` ~:124; no outbox table). A Redis loss between ack and worker insert loses a captured message permanently. Backups are **local only** (`infrastructure/staging/twins-backup.sh`: "LOCAL ONLY… off-host copy needs owner's Drive/OAuth setup").
5. **Audit trail is not actually immutable where it matters.** Only `claim_reviews`, `approval_bot_events`, `telegram_message_events` have append-only triggers (migrations 0007/0008). `audit_events`, `signal_validations`, `telegram_messages`, `options_claims` have **no** UPDATE/DELETE-blocking trigger (comments say "application must not update", enforcement is convention). `audit_events` is written by only 3 call sites (`ingestion/market.ts:148`, `ingestion/macro.ts:105`, `entities/events.ts:163`) — decisions, approvals, config changes are not in it.

### Top 5 highest-value next build items
1. **Phase-0/1 safety kernel**: a single fail-closed `executionGate` module + DB-backed kill-switch/halt flag + import-boundary test proving only one package may touch `ExecutionProvider`; make *every* process (api, bot, capture) refuse `LIVE_TRADING=true`.
2. **Immutable audit**: append-only triggers + hash chain on `audit_events`, `signal_validations`, `telegram_messages`, `options_claims`; route approvals, validations, mode changes through it.
3. **Durable intake (outbox)**: write raw event + outbox row to Postgres in the same transaction before ack; off-host encrypted backup + a timed restore drill on a schedule.
4. **Risk policy & sizing core (pure, tested)**: max-loss ₹/%, daily loss, open-risk, correlation, event blackout, margin; fail-closed when budgets unset. Everything else (cards, paper execution) depends on it.
5. **Source intelligence on the existing archive**: signal-case reconstruction + outcome labelling (needs a verified option-premium/market-data source) → first real `SOURCE_SCORE`. Currently `assessSourceReliability()` returns the constant `UNKNOWN`.

---

## 2. REPOSITORY MAP

### 2.1 Structure (npm workspaces monorepo, TypeScript ESM + one Python service)
Root `package.json`: workspaces `apps/*, services/*, packages/*, adapters/*`; Node ≥ 20; vitest; Drizzle ORM; BullMQ/Redis; Fastify.

| Area | Path | Role | Real / stub |
|---|---|---|---|
| API | `apps/api/src/index.ts`, `internalIngest.ts`, `internalIngestValidation.ts` | Fastify: `/health`, `POST /webhooks/telegram` (Bot API secret), `POST /internal/ingest/telegram-user` (capture token), `GET /signals/:id/validation`, `GET /options-claims/:messageId` (bearer `TWINS_API_KEY`) | Real |
| Viewer | `apps/web/src/{server,page,view}.ts` | Loopback-only read-only options-claim viewer (Node `http`) | Real, dev tool |
| Worker | `services/worker/src/index.ts` (741 l), `telegramEvents.ts`, `ingestionDispatch.ts` | BullMQ consumer: `signal_queue` (Telegram) + `market_queue` | Real |
| Scheduler | `services/scheduler/src/index.ts` | `node-cron` enqueues Yahoo daily bars for `MARKET_WATCHLIST` | Real; **off** in staging (profile, watchlist forced empty) |
| Approval bot | `services/approval-bot/src/*` | Telegram bot: cards for options claims, Approve/Reject **recorded only**; HMAC-signed callbacks; restricted DB role | Real, narrow scope |
| Capture | `services/telegram-capture/` (Python, TDLib) + `tools/t1-feasibility/` | **Read-only** Telegram *User API* capture + bounded history import; allowlist of 14 TDLib request types (`twins_capture/tdlib.py:11`) | Real |
| Packages | `database` (Drizzle schema + 9 migrations), `ingestion`, `signals` (extract, options parse/assess), `entities`, `dataquality`, `decision-intelligence`, `shared` (retry, correlation, structuredLog, crypto compare, adapter registry), `config`, `types` (provider contracts) | | Real |
| Stubs | `packages/ai` (21 lines: empty registry), `packages/risk/.gitkeep`, `packages/market/.gitkeep`, `packages/analytics/.gitkeep`, `adapters/broker` (contracts + empty registry), `adapters/macro` (empty registry), `tests/{e2e,adversarial,failure}` (`.gitkeep`) | | **Empty** |
| Adapters | `market` (Yahoo, daily bars, no key), `news` (GDELT, offline parser, **not registered/enabled**), `telegram` (Bot API webhook + user-capture normalisation + intake policy) | | Partial |
| Infra | `infrastructure/staging/*` (compose, hardened Dockerfiles, egress firewalls, backup service/timer, bot role SQL), `docker/docker-compose.test.yml`, `.github/workflows/ci.yml` | | Real |
| Docs | `docs/SPECIFICATION.md`, `docs/twins/*` (baseline, 127-req traceability, 13 phase plans, gates), `docs/implementation/*` (evidence, rehearsals) | Heavy documentation | |
| Untracked | `TWINS_Planning_Pack/` (17 planning docs), `.vscode/` | Not in git — **no durable copy** (repo's own STATUS.md says so) | |

### 2.2 Actual runtime architecture (as deployed in staging compose)
```
Telegram channel ──(TDLib User API, read-only, Telegram-only egress firewall)──> capture (Py) 
      └─ POST /internal/ingest/telegram-user (token) ─> api ─enqueue─> Redis/BullMQ signal_queue ─> worker
Bot API webhook (secret) ──────────────────────────────> api ─────────┘      │
                                                                              ├─ gate1 chat allow-list, gate2 options-only
                                                                              ├─ INSERT telegram_messages (+ append-only events)
                                                                              ├─ parse (regex, deterministic, NO LLM)
                                                                              └─ options → options_claims (UNVERIFIED, approval_possible=false CHECK)
                                                                                 equity  → signals → Yahoo bars → decision-intelligence → signal_validations (disabled in staging)
Postgres 16 (internal net) ◄── approval-bot (role twins_bot, cannot read raw_text) ◄── Telegram (cards/buttons, record only)
systemd timer: daily encrypted pg_dump (AES-256-GCM, verified, local only)
```
Queues: `signal_queue`, `market_queue` (BullMQ). Cron: `MARKET_CRON_EXPRESSION` (scheduler, off in staging); systemd `twins-backup.timer` 02:30 UTC. Entry points: `apps/api/src/index.ts`, `services/worker/src/index.ts`, `services/scheduler/src/index.ts`, `services/approval-bot/src/index.ts run`, `services/telegram-capture/main.py run`.
Env: `.env.example` (generic; `TRADING_MODE=paper`, `LIVE_TRADING=false`), `infrastructure/staging/{staging,bot}.env.example`. Deployment: hand-built Docker image on a VPS behind existing Coolify/Traefik (`twins.theja.tech`, `/health` only publicly routed). Observed staging data (docs dated 2026-10-24, not re-verified): 45 captured messages, 45 options claims all `INSUFFICIENT_EVIDENCE`, 0 signals/validations/orders.

---

## 3. FLOW-BY-FLOW COMPLETION AUDIT

Percentages are of the *stage as specified in your master flow*, honestly discounted for "exists ≠ works ≠ tested ≠ safe".

| Stage | Status | % |
|---|---|---|
| 0 Signal sources | PARTIAL | 25 |
| 1 Intake & capture | PARTIAL | 55 |
| 2 Parser & claim builder | PARTIAL | 40 |
| 3 Source intelligence & scorecard | MISSING | 2 |
| 4 Research / validation / capital protection | PARTIAL (stub) | 6 |
| 5 Approval card | PARTIAL (different thing) | 12 |
| 6 Approved-trade lifecycle | MISSING | 1 |
| 7 Adaptive trade management | MISSING | 0 |
| 8 Exit, reconciliation, P&L | MISSING | 0 |
| 9 Outcome attribution & learning | MISSING | 0 |
| 10 Safety & compliance | PARTIAL | 25 |
| **Weighted overall** | | **≈ 9** |

### Stage 0 — Signal sources · PARTIAL · 25 %
- **Implemented:** external Telegram channels only (User API read-only + Bot API webhook). Files: `services/telegram-capture/twins_capture/*`, `adapters/telegram/src/{botApi,userCapture,intakePolicy}.ts`.
- **Working/tested:** channel allow-list fail-closed (`adapters/telegram/src/intakePolicy.ts`, `tests/unit/telegram/intakePolicy.test.ts`); source identity by chat.id (`telegram_sources.chat_id` unique).
- **Missing:** TWINS AI-generated signals (India/US/Japan) — nothing; user-connected channels/APIs/watchlists — nothing; a source registry with type/permitted-use/tier (only `telegram_sources` identity + free-text `trustNotes`). Market scope is hard-wired to NIFTY/BANKNIFTY/SENSEX options (`options/types.ts`) and NSE/BSE equities via Yahoo; **no US/Japan anywhere**.
- **Unsafe/hardcoded:** exchange default `NSE`, `TELEGRAM_SIGNAL_EXCHANGE`; supported underlyings hardcoded.
- **Fix:** source registry table (type, permitted use, owner, tier, status); defer AI-generated/US/JP until Phase-7 research engine exists.

### Stage 1 — Intake & capture · PARTIAL · 55 %  (strongest part of the repo)
- **Implemented/WORKS/TESTED:** immutable raw message rows with `raw_text`, `raw_payload`, message id, chat id, timestamps (`schema/telegram.ts`); source time vs observed vs imported vs received kept separate with CHECK constraints (migration 0007); edit revisions as distinct rows (`ingestion/telegramRevisions.ts`, id `<id>_edit_<ts>_<hash>`); deletions recorded as append-only *events*, never removing the message (`ingestion/captureEvents.ts`, trigger `telegram_message_events_append_only`); duplicates blocked by unique indexes + deterministic BullMQ job ids; correlation ids end-to-end (`shared/correlation.ts`, `tests/integration/runtime/correlation.test.ts`); egress firewall, canary check, flood-wait hold; crash-recovery test (`tests/integration/runtime/crashRecovery.test.ts` — not re-run).
- **Partial:** history import is a bounded pilot (50 msgs / 7 days / 6 pages, `history.py`); durable intake (see risk 4); media is not captured (grep for media handling: only `raw_payload`).
- **Missing:** reply/forward linkage; cancellation/amend/"exit update" classification & linking; delay/gap detection; per-source health (lag, gap count, last-message age); source-health alerting (only an on-demand `scripts/ops/capture-watch.sh`); the cancelled-signal concept.
- **Unsafe:** `telegram_messages`/`telegram_message_events` are immutable only by convention (messages) / trigger (events); `audit_events` not append-only; intake guard = allow-list + options-only literal (good) but no "intake kill switch" row to pause at runtime (bot has `approval_bot_state.paused`; nothing for capture/API).
- **Note on `UNKNOWN`:** whether staging capture is currently running/healthy is UNKNOWN (docs say start/stop is an owner action). Verify: `docker compose ps` + `twins-backup --status` + `capture-watch.sh`.
- **Fix:** Phase-2 plan in `docs/twins/phases/02-*`; add outbox + gap detector + source-health view.

### Stage 2 — Signal parser & claim builder · PARTIAL · 40 %
- **Implemented/TESTED:** deterministic regex parsers, no LLM (`signals/src/extract.ts` v2, `signals/src/options/parse.ts` 324 l). Output is a *claim* row, not an order: `options_claims` has `approval_possible=false` enforced by CHECK (`schema/optionsClaims.ts:41`). Missing SL/targets/entry/expiry/basis are *flagged* with explicit reason codes in `options/assess.ts` (`levels.stop_missing`, `expiry.year_missing`, `levels.entry_missing`, `contract.unverified`…); 2-digit year and "WEEKLY"-style expiry are left unresolved (not guessed); wrong-side SL and non-monotone targets → `REJECT`. Prompt-injection text yields no action (`tests/unit/signals/extract.test.ts:87`).
- **Gaps:** options-only: NIFTY/BANKNIFTY/SENSEX, BUY-presumed-long; SELL left unresolved; no spreads/multi-leg/multi-signal messages (reports `ambiguous`); no validity/condition/time-window parsing; no labelled accuracy (no precision/recall on a human sample — TG-10); equity path `structuralValidation` does **not** reject missing SL (risk 3); contract verification only against *manual/provider snapshot files*, not an exchange master (`options/referenceMaster.ts`, `dhanImport.ts`); premium source = none (`premium.ts: unavailablePremiumProvider`) → every real claim is `INSUFFICIENT_EVIDENCE` (observed: 44/44).
- **Fix:** verified instrument master (NSE/Kite instruments dump) + labelled corpus + SL-required rule for all paths.

### Stage 3 — Source intelligence & scorecard · MISSING · 2 %
- Only evidence: `assessSourceReliability()` returns constant `UNKNOWN` (`decision-intelligence/src/sourceReliability.ts`), enum `source_reliability`, free-text `trustNotes`. Tables `backtests`/`backtest_results` exist but are unused (no writer). No win rate, expectancy, drawdown, reachability, SL discipline, edit/delete behaviour metric (raw data for edits/deletes *is* captured — good foundation), regime analysis, SEBI/red-flag check, `SOURCE_SCORE`, or `SOURCE_TRUST_TIER`. The `sourceTierEnum` A–E is an *evidence-provider* tier (Telegram = E), not a channel trust tier.
- **Blockers:** no outcome ground truth (needs premium/OHLC history for options; none), outcome conventions undecided (D-005 per STATUS.md).

### Stage 4 — Research, validation & capital protection · PARTIAL (stub) · 6 %
- See §4. What exists: a deterministic bull/bear/counter-thesis evidence-count validator (`decision-intelligence/src/decide.ts`) producing `APPROVE | REJECT | INSUFFICIENT_EVIDENCE` into `signal_validations`; equity-only; staging-disabled. None of WAIT/CONDITIONAL/QUALIFIED/NO_TRADE/ALTERNATIVE_CANDIDATE exist as states. No dual-plan record (original vs TWINS proposal): `signals` stores the external levels only; no `trade_proposals` table.
- **Calibration warning:** `decisionConfidence` is a *supporting/total factor count ratio* (`decide.ts`), explicitly "not a probability" (`confidenceLabel`). It must not be shown on a card as "confidence score" without that caveat.

### Stage 5 — TWINS Telegram approval card · PARTIAL · 12 %
- **Exists/TESTED:** `services/approval-bot` — plain-text cards (no parse mode), HMAC-signed single-use callback data with nonce, card TTL, rate caps per hour/day, single approver id, restricted DB role (`approval-bot-role.sql`, `tests/integration/approvalBot/rolePrivileges.test.ts`), append-only decision log, refuses to start if egress is open. "Approve" is labelled *"recorded only — nothing is traded"*.
- **Missing vs spec:** no "why this trade", market context, TWINS entry/SL/targets, position size, ₹ max loss & %, R:R, confidence, evidence links, MODIFY. The card is about a *claim*, not a *trade proposal*. No approval-to-proposal binding (hash of exact levels/size/expiry; approval invalidated on revision/staleness). Approvals reference `options_claims.id`, which can never be approvable (`approval_possible=false`) — **by design there is no path from the bot to an order**, which is the correct current state.
- **Reuse:** the bot is excellent plumbing for the real card (callback signing, TTL, idempotency, privilege model).

### Stage 6 — Approved-trade lifecycle · MISSING · 1 %
- Only contracts + empty registries: `adapters/broker/src/index.ts`, `packages/types/src/providers/broker.ts` (`PlaceOrderRequest` has `orderType: string`, no SL/target/product/validity/tag fields), tables `orders`, `fills`, `positions`, `portfolio_snapshots`, `risk_decisions`. No pre-flight, order construction, Kite order-type rules, slippage band, partial-fill policy, fill verification, protection-leg verification, or emergency flatten. No Zerodha/Kite code at all (grep for `kite|zerodha`: only `tests/unit/approvalBot/static.test.ts`, which asserts their *absence* from the bot).
- `PlaceOrderRequest` lacks a mandatory `protectiveStop`/`riskDecisionId`; `ExecutionProvider.placeOrder` is callable by anything holding the registry. `orders.risk_decision_id` is **nullable** "for manual orders" (`schema/execution.ts`) — a hole for the future.

### Stage 7 — Adaptive trade management · MISSING · 0 %
- No monitor, target ladder, trailing, invalidation, time-decay, EOD square-off. No tick/websocket feed. No code.

### Stage 8 — Exit, reconciliation, P&L · MISSING · 0 %
- Only empty tables (`fills`, `positions`, `portfolio_snapshots`). No charges/tax model, no R-multiple, no broker reconciliation, no open-risk release.

### Stage 9 — Outcome attribution & learning · MISSING · 0 %
- No outcome tags, no scorecard updates, no calibration, no review reports. `packages/analytics` empty.

### Stage 10 — Product safety & compliance · PARTIAL · 25 %
- **Exists/TESTED:** default-safe `LIVE_TRADING` parse (`config/src/index.ts`, `tests/unit/config.test.ts`); worker/scheduler hard exit; test/rehearsal target guards that fail if `LIVE_TRADING!=false` (`tests/integration/targetConfig.ts`); secrets via env, constant-time compare, JSON body never logged (`shared/crypto.ts`, `structuredLog.ts`); network guard in tests forbids real egress (`tests/support/networkGuard.ts`); container hardening (read-only FS, cap_drop ALL, no-new-privileges, internal DB/Redis network, loopback publish); AES-256-GCM verified daily backup + a restore drill with evidence (`docs/implementation/evidence/r0b-backup-restore-drill-2026-10-19`); Telegram-only egress firewalls.
- **Missing:** kill switch (pause intake / cancel / flatten) — none; circuit breakers (daily loss, API failure, data gap) — none; encrypted *broker* credentials (no broker); immutable audit across decisions; off-host backup; alert delivery drills; disclaimer / no-guaranteed-returns text in any user-facing surface (grep `not investment advice|informational` in code: no hit in `apps/` or `services/` cards — the bot card says "Nothing is traded", which is not a disclaimer); SEBI disclosure/compliance checks; independent security review (F1 unresolved — assistant-produced package only).

---

## 4. AGENT ENGINE AUDIT (A–O)

**Headline: 0 of 15 agents exist as agents. There is no orchestration engine, no agent registry, no agent-output table.** What exists is one monolithic pure function (`decide()`) and a few data-quality rule sets that happen to map loosely onto agent topics. `packages/ai` is an empty registry; no LLM is called anywhere (`grep openrouter|anthropic|openai` in non-test source: no hit). Contrast: the only "agent-like" output persisted is `signal_validations` (bull/bear/counter thesis JSON).

| # | Agent | Exists? | Real / stub | Inputs → outputs | Wired to orchestration? | Stored/auditable? | Affects final decision? | Reuse potential / missing work |
|---|---|---|---|---|---|---|---|---|
| A | Signal integrity | Partial, not an agent | **Real logic**: `structuralValidation.ts` (instrument resolved, direction, timestamp stale/future, bare) + `options/assess.ts` (level ordering, missing SL/expiry/entry, REJECT on wrong-side SL) | signal row / OptionsClaim → issues[] / reasons[] | Called inside `decide()` (equity) and worker options path | Yes (`signal_validations`, `options_claims.reasons`) | Equity: yes (blocking→REJECT). Options: records only | **Reuse as-is** as agent A core. Add: SL-required rule on equity, edit/delete-since-signal check, duplicate-signal check, source-lag check |
| B | Instrument/contract verification | Partial | **Real but offline-file based**: `options/master.ts`, `referenceMaster.ts`, `dhanImport.ts`; equity: `ingestion/instruments.ts`, `entities/instrumentMapping.ts` | strike/expiry/type → verified/not_found/ambiguous | Options path only | Yes (`verification` jsonb) | No (cannot approve) | Reuse with refactor; **needs authoritative master** (NSE/Kite `instruments`), lot size, tick size, expiry calendar |
| C | Market calendar & event risk | **Missing** | – | – | – | – | – | `news_event_type` enum (exchange_halt, rate decision…) and `entities/events.ts` give schema scaffolding; no holiday/session/expiry-day/result-date calendar, no blackout |
| D | Macro & global | Skeleton | `packages/ingestion/src/macro.ts` + `macro_observations` + `dataquality/rules/macro.ts`; **no concrete provider** (`adapters/macro` empty) and `signals/src/context/macro.ts` reads rows if any | observations → context | Via `assembleSignalIntelligence` | Yes (rows) | Contributes bull/bear factors only if rows exist (none in staging) | Reuse; need RBI/FRED/other provider |
| E | News & sentiment | Skeleton | `ingestion/news.ts`, `adapters/news/gdelt.ts` (offline parser; **not registered or enabled**), `entities/newsMentions.ts`, `eventClassification.ts` (keyword rules). **No sentiment model.** | news items → mentions/events | Via intelligence assembly | Yes | Weakly (event type "negative-convention" → counter-thesis HIGH → REJECT) | Reuse GDELT parser/entity linking; sentiment & credible-source tiering missing |
| F | Index-constituent impact | **Missing** | – | – | – | – | – | `entity_relationships` (BELONGS_TO/AFFECTS) is a possible store; no NIFTY/BANKNIFTY weights data |
| G | Technical structure | **Missing** | `signals/src/context/market.ts` only pulls recent bars/returns | – | – | – | – | Daily Yahoo bars only; no S/R, trend, ATR, MA. Build on a TA lib (§10) |
| H | Price action / candlesticks | **Missing** | – | – | – | – | – | needs intraday OHLC (Yahoo daily only) |
| I | Liquidity & spread | **Missing** | – | – | – | – | – | needs depth/bid-ask (Kite quote) — no feed |
| J | Options risk | Partial | Level-ordering/basis checks in `assess.ts`; **no greeks, no premium, no OI, no delta/theta** | – | worker options path | Yes | No | Needs option chain + premium feed |
| K | Volatility & IV | **Missing** | – | – | – | – | – | needs India VIX/IV history |
| L | Historical pattern/archive | **Missing** | Raw archive exists (45 msgs); `telegramMessages` + events are the substrate; `signals/context/priorSignals.ts` fetches prior signals only | – | – | – | – | Biggest asset to reuse after outcome labelling exists |
| M | Risk-reward & position sizing | **Missing** | `risk_decisions.max_position_size/risk_per_trade` columns only; `packages/risk` empty | – | – | – | – | Build new (pure functions, property-tested) |
| N | Independent challenger | Partial, deterministic | **Real**: `counterThesis.ts` + `thesis.ts` (bear vs bull factor counting) | theses → severity low/med/high | In `decide()` | Yes (`counter_thesis` jsonb) | Yes (high → REJECT) | Reuse concept; it is *not independent* (same inputs/same code path), not a separate model |
| O | Final eligibility & capital protection | **Missing** | `decide()` returns `APPROVE/REJECT/INSUFFICIENT_EVIDENCE` — explicitly "evidence sufficient for analysis… does not authorise execution" (`decide.ts` header) | – | – | – | – | Build new: states WAIT/REJECT/CONDITIONAL/QUALIFIED/NO_TRADE/ALTERNATIVE_CANDIDATE |

Orchestration: `validateSignal()` (`decision-intelligence/src/engine.ts`) is a linear function: load signal → assemble evidence → `decide()` → persist. No concurrency, per-agent timeouts, versioning, calibration, agent-disagreement handling, or per-agent output rows.

---

## 5. REUSE AUDIT

### REUSE AS-IS
| Need | Asset |
|---|---|
| Telegram capture | `services/telegram-capture/*` (+tests), `adapters/telegram/src/{userCapture,intakePolicy,revisionId}.ts`, egress firewall scripts, `Dockerfile.capture`, pinned TDLib notes |
| Parsing (options claim) | `signals/src/options/{parse,assess,types}.ts` + 228+136 lines of tests |
| Telegram approval bot plumbing | `approval-bot/src/{callback,telegramApi,egress,config,log}.ts`, role SQL, append-only trigger pattern (migration 0008) |
| Safety controls | `shared/{correlation,structuredLog,retry,crypto}.ts`, test target guards, `networkGuard`, staging hardening, backup script + restore drill scripts |
| Audit/idempotency patterns | idempotency-key + unique-index pattern (`signal_validations`, `telegram_message_events`), append-only trigger functions |
| Data-quality rules | `packages/dataquality/src/rules/*` |

### REUSE WITH REFACTOR
| Need | Asset | Refactor |
|---|---|---|
| Research agents | `decision-intelligence/{thesis,counterThesis,structuralValidation}.ts`, `signals/{engine,evidence,intelligence}.ts`, `entities/*` | Split into a typed `Agent` interface + per-agent output table + versions; move equity-specific logic out |
| Source scorecard | `telegram_sources`, `telegram_message_events`, revision states (`getRevisionStates`), `backtests` tables | Add case/outcome tables; compute edit/delete/late-signal metrics |
| Zerodha Kite integration | `ExecutionProvider`/`BrokerProvider` types, `createAdapterRegistry`, `ProviderError` classes, `withRetry` | Redesign `PlaceOrderRequest` (SL, product, validity, tag, riskDecisionId mandatory); add read-only adapter first |
| Risk engine | `risk_decisions` table, `config` loader | Replace `approved:boolean` with structured per-check results + policy version |
| Trade lifecycle / exit mgmt / P&L | `orders/fills/positions/portfolio_snapshots` tables | Add state machine, `trades`, `exits`, `pnl`, `charges`; make `risk_decision_id` NOT NULL |
| Learning loop | `backtests`, `backtest_results`, `signal_evidence` lineage | Needs outcome labels first |
| Market data | `adapters/market/yahoo.ts` | Daily, unofficial, no SLA → use only for research; production needs Kite/vendor feed |

### REPLACE
- `sourceReliability.ts` constant `UNKNOWN` (replace with computed tier).
- `decisionOutcomeEnum BUY/SELL/WAIT/REJECT` and `signalValidationOutcomeEnum APPROVE/...` naming (collision with human APPROVE; target states differ).
- Yahoo as sole market provider for anything beyond research.
- `.env.example` free-form broker vars (`BROKER_API_KEY/SECRET` plaintext) with an encrypted-secret scheme.

### BUILD NEW
Source registry; case/claim-version identity (T6 design exists in `docs/implementation/phase1/T6_SIGNAL_LIBRARY_DESIGN.md`); all agents C,F–M,O; risk core; kill switch; trade proposal + approval binding; execution state machine; protection verifier; monitor; reconciliation; P&L/charges; learning loop; alerting; AI provider adapter + budget guard.

---

## 6. API & EXTERNAL INTEGRATION AUDIT

| Integration | Status | Files | Missing / concerns | Env vars |
|---|---|---|---|---|
| Telegram **User API (TDLib)** capture | **Working** (read-only; 14-request allow-list), WORKS in staging per repo docs (not re-verified) | `services/telegram-capture/*` | Flood-wait handled by exit+hold (`service.py`); session DB encrypted in a volume **excluded from backup** (loss = re-login); history bounded; no reply/forward/media | `TWINS_TELEGRAM_API_ID/HASH/SESSION_DB_KEY`, `TWINS_CAPTURE_INGEST_TOKEN/URL`, `TWINS_TELEGRAM_ALLOWED_CHAT_IDS` |
| Telegram **Bot API** (webhook in; bot out) | Working | `adapters/telegram/src/botApi.ts`, `apps/api` webhook, `approval-bot/src/telegramApi.ts` | Webhook secret via constant-time compare ✔; public route intentionally not exposed; bot long-polls | `TELEGRAM_WEBHOOK_SECRET`, `TWINS_BOT_TOKEN`, `TWINS_BOT_APPROVER_ID`, `TWINS_BOT_HMAC_KEY`, `TWINS_BOT_DATABASE_URL`, `TWINS_BOT_ACTIVE` |
| **Zerodha Kite Connect** (login, session, profile, margins, orders, positions, holdings, historical, ticks) | **MISSING entirely** | none | Needs: daily OAuth login flow (request token → access token, expires ~6 AM IST daily — operationally critical), read-only adapter first; order API ~10 orders/s, ~3000/day limits; historical-data add-on (paid); WebSocket ticks (3000 instruments); static-IP requirement for order APIs (SEBI retail algo rules) — **verify current Kite terms before design (UNKNOWN: not checked here, no network access in this audit)** | `BROKER_PROVIDER/API_KEY/API_SECRET` in `.env.example` — must become encrypted store, never `.env` plaintext |
| Market data | Yahoo daily bars only | `adapters/market/src/yahoo.ts`, `scheduler` | Unofficial endpoint, ToS/stability risk, 1-day granularity, bar timestamp convention unverified (docs TG-09); no intraday/option chain/depth/IV; 429/5xx → typed errors + retry ✔ | `MARKET_*` |
| News | GDELT parser offline, **no default transport, not enabled** | `adapters/news/*` | No credible-news provider; no sentiment; | `NEWS_PROVIDER_API_KEY` (unused) |
| Economic calendar | **Missing** | – | – | `MACRO_DATA_PROVIDER` (unused) |
| AI/LLM | **Missing** (empty registry) | `packages/ai` | Budget vars exist (`AI_DAILY_BUDGET_USD`) but nothing reads them; prompt-injection posture is "no LLM sees message text" — must be re-proved when added | `OPENROUTER_API_KEY` (unused) |
| DB/cache/queue | Postgres 16 + Redis 7 (AOF, noeviction, password), pinned digests | compose | Redis holds the only copy between ack and worker (risk 4); pool bounded (`createBoundedDb`) ✔ | `DATABASE_URL`, `REDIS_URL` |
| Notifications | Telegram only (bot alerts); `capture-watch.sh` ad-hoc | `scripts/ops/capture-watch.sh`, bot `alert` | No pager/email/SMS channel; no alert drill; no dead-man's switch for backup | – |
| Hosting/VPS | Hand-deployed Docker on Coolify host | `infrastructure/staging/*` | No CI/CD deploy, image provenance gap (tag→commit mapping unverified, F-009), `/root/twins-offsite-keys/...` hard-coded in `twins-backup.sh`; domain hard-coded in Traefik labels; shared host with other stacks | `POSTGRES_*`, `REDIS_PASSWORD`, `TWINS_API_KEY` |

**Recommended production setup:** dedicated host (or at minimum dedicated Docker daemon) with static IP (broker requirement), secrets in a manager (not env files) with envelope encryption for broker tokens, off-host encrypted backups (object storage, different account), uptime/dead-man alerting to a second channel, read-only Kite adapter in its own container/role.

---

## 7. DATABASE & DATA MODEL AUDIT

### Existing (24 tables, 9 migrations 0000–0008)
`users, accounts, broker_connections, telegram_sources, telegram_messages, telegram_message_events, instruments, market_observations, macro_observations, news_evidence (+ news tables), entities/relationships/events, signals, signal_evidence, signal_validations, options_claims, claim_review_cards, claim_reviews, approval_bot_events, approval_bot_state, decisions, risk_decisions, orders, fills, positions, portfolio_snapshots, analyses, quality_assessments, provider_health, jobs, audit_events, backtests, backtest_results`.

**Written by code today:** telegram_*, options_claims, signals, signal_evidence, signal_validations, market/macro/news observations, entities, jobs, provider_health, quality_assessments, audit_events (3 sites), approval bot tables.
**Never written by any code:** `decisions, risk_decisions, orders, fills, positions, portfolio_snapshots, analyses, backtests, backtest_results, broker_connections, accounts, users`.

### Gap vs required entities
| Required | Status |
|---|---|
| signals | ✔ (equity) / `options_claims` (options) — two parallel models, no unified `signal_case` |
| revisions | ✔ for raw messages (`telegram_messages.origin_message_id/edit_date`); ✘ claim-version table |
| evidence | ✔ `signal_evidence` (market/macro/news only) |
| source scorecards | ✘ |
| research reports | ✘ (`analyses` unused, requires AI fields) |
| agent outputs | ✘ |
| approval cards | partial (`claim_review_cards` – claims only) |
| trades / trade proposals | ✘ |
| orders / fills / positions | schema only, unused |
| exits | ✘ |
| P&L (gross/charges/tax/slippage/net/R) | ✘ |
| risk events / limits / policy versions | ✘ |
| learning records | ✘ |
| audit logs | partial (generic `audit_events`, not append-only, barely used) |
| kill-switch / system-mode state | ✘ |

### Recommended migration plan (additive, each with forward-only migration + preflight, following the existing R0B rehearsal pattern)
1. `0009_audit_immutability`: append-only triggers + `prev_hash/hash` chain on `audit_events`; triggers on `signal_validations`, `options_claims`, `telegram_messages` (block UPDATE/DELETE/TRUNCATE except a named maintenance role).
2. `0010_system_controls`: `system_state(mode, live_enabled, kill_switch, paused_reason, changed_by, changed_at)` single-row + history table; `risk_policies(version, params jsonb, effective_from, approved_by)`.
3. `0011_source_registry`: `sources(type, permitted_use, tier, status)` ↔ `telegram_sources`; `source_scorecards(source_id, as_of, metrics jsonb, score, tier, method_version)`.
4. `0012_cases`: `signal_cases`, `claim_versions` (immutable, linked to message revisions), `case_events` (cancel/amend/exit/target-update).
5. `0013_research`: `agent_runs(case_id, agent, version, input_hash, output jsonb, started/finished)`, `research_reports`, `eligibility_decisions(state enum WAIT…ALTERNATIVE_CANDIDATE)`.
6. `0014_proposals_approvals`: `trade_proposals` (original-plan jsonb + TWINS-plan jsonb, size, max_loss, content_hash), `approvals(proposal_id, hash, approver, decision, expires_at)`.
7. `0015_execution`: make `orders.risk_decision_id` NOT NULL (+ `approval_id`), `order_events`, `protection_legs`, `trades`, `exits`, `pnl_entries`, `broker_reconciliations`, `risk_events`.
8. `0016_learning`: `outcome_tags`, `calibration_snapshots`, `review_reports`.

**Indexing/retention:** keep all raw/audit data indefinitely (no auto-prune is already a stated decision); partition `audit_events`/`market_observations` by month once > ~10 M rows; index `(case_id, created_at)`, `(source_id, as_of)`, partial indexes on open orders/positions. **Immutability:** DB triggers + role separation (writers cannot UPDATE), not just application convention. **Money:** use `numeric` + currency (already `numeric`), never float.

---

## 8. RISK & SAFETY AUDIT

### 8.1 Can an order be placed without approval/protection today?
**No — because no code path can place an order.** Evidence: `executionProviders` registry is empty and never `.register()`ed outside tests; `placeOrder` appears only in the interface and a test double (`tests/unit/adapters/providerContracts.test.ts`); no concrete broker adapter; `schema.orders` is only inserted in a schema test; `options_claims.approval_possible` is DB-constrained to `false`; the bot role cannot touch claims. This is safety-by-absence, not safety-by-design.

### 8.2 Unsafe / risky paths and gaps
| # | Finding | Severity |
|---|---|---|
| S1 | No structural boundary for future order path: `ExecutionProvider` is a global registry callable from anywhere; `orders.risk_decision_id` nullable; no DB privilege separation for an execution role; no import-boundary lint | **CRITICAL** (for next phases) |
| S2 | No kill switch (pause intake / cancel / flatten) anywhere (grep `kill.?switch|flatten` in non-test source: none) | **CRITICAL** before any live |
| S3 | No daily-loss, open-risk, correlation, margin, event-blackout, circuit-breaker logic (`packages/risk` empty) | **CRITICAL** before paper-with-sizing / live |
| S4 | No protective-SL placement/verification, no emergency flatten, no broker outage handling | **CRITICAL** before live |
| S5 | `LIVE_TRADING` enforced in worker/scheduler only; API reports; bot/capture ignore; no second independent gate; `LIVE_TRADING=true` + `TRADING_MODE=live` is accepted by `loadConfig` | **HIGH** |
| S6 | Equity `decide()` can `APPROVE` with no SL (`structuralValidation.ts`) and uses 30-day "freshness" horizon (header admits it is not an executable-freshness policy) | **HIGH** (latent; staging gate masks it) |
| S7 | Redis-only window between HTTP 200 and Postgres insert; local-only backups | **HIGH** (data loss) |
| S8 | Audit trail not immutable for `audit_events`, `signal_validations`, `telegram_messages`, `options_claims`; approvals/mode changes not routed to `audit_events` | **HIGH** |
| S9 | Independent security review (F1) unresolved; security-critical code (webhook auth, crypto compare, DB pool) reviewed only by the authoring assistant | **HIGH** |
| S10 | API single static bearer key for all operator routes; no rotation, no per-route scope, no rate limit in-app (Traefik rate-limit only on `/health`) | **MEDIUM** |
| S11 | Approval bot: one approver id, no 2-person rule, callbacks can be replayed only once (nonce) ✔, but card says "Approve (record only)" — future reuse for real approval would need re-binding to a content hash | **MEDIUM** |
| S12 | Capture session volume excluded from backup & single host: Telegram re-login needed on loss | **MEDIUM** |
| S13 | Image/commit provenance unverified (tag `capture-8cb22f9` doesn't map to deployed code, F-009) | **MEDIUM** |
| S14 | `.env.example` encourages plaintext broker key/secret in env | **MEDIUM** (future) |
| S15 | Yahoo as data source: unofficial, bar timestamp semantics unverified → any research built on it inherits look-ahead risk | **MEDIUM** |
| S16 | No disclaimer / no-guaranteed-returns text anywhere user-facing | **LOW→MEDIUM** (becomes HIGH when cards show trade ideas) |
| S17 | Hard-coded host paths/domain (`/root/twins-offsite-keys/...`, `twins.theja.tech`) | **LOW** |

### 8.3 What *is* well done (verified in code)
Fail-closed intake policy; options claims never approvable (CHECK); bot cannot read channel text (column-level grants); no LLM touches untrusted text; secrets never logged (`describeErrorSafely`, `<BotConfig redacted>`); bounded queue/pool/body sizes; containers hardened; test harness forbids real network.

---

## 9. TESTING & OBSERVABILITY AUDIT

**Existing:** 72 unit files / 938 tests (**ran: all pass**); ~35 integration files requiring Postgres+Redis (**not run here → UNKNOWN current status**; evidence logs in `docs/implementation/evidence/*` show passes on 2026-10-19, assistant-produced); Python tests for capture (`services/telegram-capture/tests/*`, 3 files, not run); infra packaging tests (compose/firewall/backup string-level tests); CI workflow on Node 20/22 with service containers — **no evidence it has ever run on GitHub** (no remote verified; STATUS.md lists "hosted CI" as P01 not started).
**Empty:** `tests/e2e`, `tests/adversarial`, `tests/failure` are `.gitkeep`. `tests/integration/runtime/e2ePipeline.test.ts` is a signal→validation pipeline on synthetic bars, not a trading e2e.
**Not covered because code doesn't exist:** risk limits, sizing, kill switch, order construction, fills, protection, reconciliation, P&L, learning, scorecards, agents.
**Observability:** structured JSON logger with correlation id/request id (`shared/structuredLog.ts`, tested); `provider_health` and `jobs` tables; backup status file + `twins-backup --status`; `capture-watch.sh` event streamer. **Missing:** metrics (no Prometheus/OpenTelemetry), tracing, dashboards, alert routing/on-call, heartbeat/dead-man, queue-depth/lag alarms, worker HTTP health (compose notes "no HTTP health check for the worker").

### Recommended test plan before ANY live deployment
1. Property tests for sizing/risk (max loss never exceeded under any rounding/lot/tick combination; zero/NaN/negative inputs fail closed).
2. Contract tests: execution adapter against a recorded Kite sandbox/fake with injected: reject, partial fill, timeout-then-success (idempotency), duplicate ack, SL-leg reject → assert emergency flatten.
3. State-machine model test: every order/position state × every event (including broker outage and restart mid-flight).
4. Reconciliation tests: broker positions ≠ local → halt + alert.
5. Kill-switch drill: with open paper positions, assert pause/cancel/flatten within N seconds, and that restart does not resume trading.
6. Chaos: kill Redis/Postgres/worker mid-ingest and mid-order; assert no loss/duplication.
7. Prompt-injection / adversarial corpus into every parser and (later) LLM path → no tool call, no state change.
8. Replay/backtest with strict as-of clock (look-ahead tests).
9. 4–8 weeks paper trading with daily reconciliation report reviewed by a human; written go/no-go.
10. Independent security review (F1) completed and recorded.

---

## 10. GITHUB / CODE REUSE OPPORTUNITIES

Only the **internal repo** was inspected; no network access was used, so external projects below are *candidates from general knowledge* and must be license/version-verified before adoption (UNKNOWN until checked). `TWINS_Planning_Pack/09_GITHUB_AND_LICENSES.md` exists locally and was **not reviewed in depth** by this audit — start there.

| Category | Candidate | Internal / External | License-safe? | Suitability |
|---|---|---|---|---|
| Telegram ingestion | existing `services/telegram-capture` (TDLib) | Internal | Own code; TDLib is Boost (BSL-1.0) — permissive | **Keep.** Telethon/Pyrogram are alternatives (MIT/LGPL — check) but TDLib is already hardened here |
| Broker adapter | `zerodha/pykiteconnect` / `kiteconnect` npm (official clients) | External | MIT (verify) | Suitable; wrap behind `BrokerProvider`/`ExecutionProvider` |
| Technical analysis | `technicalindicators` (npm), `ta-lib` bindings, `pandas-ta` | External | MIT / BSD (TA-Lib) / MIT — verify | Suitable for agents G/H/K; deterministic, testable |
| Backtesting | `vectorbt` (Apache-2.0 + Commons Clause restriction — check), `backtrader` (GPL-3.0 → **avoid linking**), `nautilus_trader` (LGPL-3.0) | External | Mixed | Prefer a small in-house as-of-clock replay engine (the repo's `backtests` table + docs call for one); vendor libs only for indicators |
| Options analytics | `py_vollib`, `QuantLib` (BSD), `mibian` | External | Permissive (verify) | IV/greeks for agents J/K |
| News/sentiment | GDELT (already), FinBERT (`ProsusAI/finbert`, check model license) | Mixed | Verify | Sentiment is optional and must be isolated from raw-text-to-action paths |
| Job queue | BullMQ (already) | External | MIT | Keep; add repeatable jobs for monitors |
| Risk engine | none to adopt wholesale | – | – | Build in-house, small and pure |
| Audit logging | in-house append-only trigger pattern (0007/0008) | Internal | – | Extend; consider hash-chain |
| Deployment scripts | `infrastructure/staging/*`, rehearsal scripts | Internal | – | Reuse; add CI/CD with provenance (image digest ↔ commit) |
| Market-data/option chain | Kite Connect / vendor feeds | External paid | Contractual | Required for stages 4+ |

I did not find reusable agent code, backtesters, or broker adapters elsewhere in this repository.

---

## 11. PRIORITIZED BUILD ROADMAP

Effort: S ≤ 2 d, M ≤ 1.5 wk, L ≤ 4 wk, XL > 4 wk (one engineer). "Blocks LIVE" = must be done before `LIVE_TRADING` can ever be true.

### Phase 1 — Safety and correctness
| Task | Goal | Reuse | New | Deps | Acceptance | Eff. | Risk | Blocks LIVE |
|---|---|---|---|---|---|---|---|---|
| 1.1 Uniform live-guard | Every process (api, bot, capture, scripts) refuses `LIVE_TRADING=true` until gate passes; second gate (DB `system_state.live_enabled` + signed approval) | `config`, worker guard pattern | `packages/safety/{gate,systemState}.ts` | – | Test per process; flipping env alone never enables anything | S | Low | Yes |
| 1.2 Kill switch + system mode | DB-backed `halt` honoured by intake, bot, (future) execution; CLI + Telegram `/halt` | bot `paused` pattern | `packages/safety/killSwitch.ts`, migration | 1.1 | Halt stops new cards/intake in < 5 s; survives restart | M | Med | Yes |
| 1.3 Audit immutability | Triggers + hash chain; route validations/approvals/mode changes through it | 0007/0008 triggers | migration 0009, `shared/audit.ts` | – | UPDATE/DELETE/TRUNCATE blocked; chain verify command passes | M | Med | Yes |
| 1.4 SL-required & exec-freshness rule | Equity+options reject missing SL; explicit executable-freshness policy separate from 30-day horizon | `structuralValidation`, `assess` | rule + tests | decision on windows | Fixtures: no-SL ⇒ REJECT in all paths | S | Low | Yes |
| 1.5 Rename outcome states | Remove `APPROVE` collision; introduce eligibility enum | enums | migration | – | No code path uses `APPROVE` for machine verdict | S | Low | No |
| 1.6 Execution import boundary | Lint/test that only `packages/execution` imports `ExecutionProvider`; `orders.risk_decision_id` NOT NULL | `static.test.ts` pattern | eslint rule, migration | – | CI fails on violating import | S | Low | Yes |

### Phase 2 — Signal capture and parsing hardening
| 2.1 Durable intake (outbox) | No ack before Postgres commit | `internalIngest.ts`, jobs | `intake_outbox` table + relay | 1.3 | Redis flushed post-ack ⇒ zero loss (chaos test) | L | Med | Yes |
| 2.2 Reply/forward/cancel/amend/exit linking | Case-aware follow-ups | revisions code | `signal_cases`, classifier | – | Labelled fixtures linked or explicitly unlinked | L | Med | Yes (for stage 7/8) |
| 2.3 Gap/delay & source-health | lag, id-gap, silence alarms | `provider_health`, capture-watch | `sourceHealth` view + alerts | alert channel | Injected gap raises alert | M | Low | No |
| 2.4 Labelled parser corpus + accuracy | Precision/recall per field | parse tests | `tests/corpus/*` | human labeller | Reported per field, target set by owner | M | Low | Yes |
| 2.5 Verified instrument master | NSE/Kite instruments incl. lot/tick/expiry | `referenceMaster`, `dhanImport` | importer + versioning | Kite or NSE file | Exact contract match; unknown ⇒ REJECT | M | Med | Yes |

### Phase 3 — Source intelligence and historical learning
| 3.1 Source registry | typed sources, permitted use | `telegram_sources` | migration 0011 | – | row per source | S | Low | No |
| 3.2 Case reconstruction + outcome conventions | Entry-reached, SL/T hit, ambiguity flags | revisions, bars | `outcomes` pkg | 2.2, 2.5, premium/OHLC data, owner decision D-005 | Replayed on archive with as-of clock; ambiguous stays ambiguous | XL | High | No |
| 3.3 Scorecard & trust tier | win rate, expectancy, DD, reachability, SL discipline, edit/delete, late-signal; **confidence intervals**, min-sample gate | `backtests` tables | `source_scorecards`, job | 3.2 | Tier assigned only above sample floor; else UNRATED | L | Med | Yes |
| 3.4 SEBI/red-flag checks | disclosure, guaranteed-return, tipster flags | – | rule set | legal input | Flags stored with evidence | M | Med | No |

### Phase 4 — Validation agent engine
| 4.1 Agent framework | typed agents, timeouts, versions, `agent_runs`, deterministic replay | `decide()` pieces | `packages/research/*` | 1.3 | Each run persisted w/ input hash | L | Med | Yes |
| 4.2 Data feeds | intraday, option chain, depth, VIX/IV, calendar, news | Yahoo/GDELT adapters | adapters | vendor choice | Freshness/gap detection per feed | XL | High | Yes |
| 4.3 Agents A,B,C,I,J,K,M,O first (capital-protection critical), then D–H,L,N | – | existing A,B,N | agents | 4.1, 4.2 | Per-agent fixture suite; missing input ⇒ WAIT/REJECT never fabricated | XL | High | Yes |
| 4.4 Eligibility states + dual plan | WAIT…ALTERNATIVE_CANDIDATE; keep original & TWINS plan | – | `eligibility_decisions`, `trade_proposals` | 4.3 | Both plans stored side-by-side | M | Med | Yes |

### Phase 5 — Approval and execution
| 5.1 Risk policy core | ₹/% max loss, daily loss, open risk, correlation, margin, blackout, size; fail-closed w/o budgets | `risk_decisions` | `packages/risk` (pure) | owner budgets (D-007) | Property tests; unset budget ⇒ deny | L | High | Yes |
| 5.2 Proposal card + approval binding | Full card w/ MODIFY; approval bound to content hash, expiry, revision invalidation; disclaimer | approval-bot | `approvals` | 4.4, 5.1 | Changed levels/size ⇒ approval void | L | Med | Yes |
| 5.3 Kite read-only adapter | profile, margins, positions, holdings, instruments, daily login | broker types | `adapters/kite` | Kite account, static IP | Read-only creds cannot place orders (verify scopes) | M | Med | Yes |
| 5.4 Paper executor | simulated fills incl. slippage/partials/rejects | `orders/fills` | `packages/execution/paper` | 5.1 | Same code path as live up to adapter | L | Med | Yes |
| 5.5 Live executor + protection + flatten | order construction, SL placement & verify, emergency flatten | – | `execution/live` | 5.3, 5.4, 1.2 | Fault-injection suite passes; SL reject ⇒ flatten | XL | **Critical** | Yes |

### Phase 6 — Adaptive exits and reconciliation
| 6.1 Monitor & ladder | T1/T2/T3 SL moves, invalidation, time exits, EOD square-off | – | `execution/manager` | 5.x, ticks | Every action logged w/ reason+snapshot | XL | High | Yes |
| 6.2 Reconciliation & P&L | broker vs local, charges/taxes/slippage/net/R | `fills/positions` | `pnl`, `reconcile` | 5.3 | Mismatch ⇒ halt; P&L ties to contract note | L | High | Yes |

### Phase 7 — Learning loop and analytics
| 7.1 Outcome attribution tags | good/bad signal/execution/risk, correct skip… | – | `learning` | 6.2 | Tagged for every closed trade & skipped case | M | Med | No |
| 7.2 Calibration & weekly/monthly reports | agent calibration, rule effectiveness | scorecards | reports job | 7.1 | Reports reproducible from DB | L | Low | No |

### Phase 8 — Production hardening
| 8.1 Hosted CI + provenance | CI green on runner; image digest↔commit | `ci.yml` | deploy workflow | repo remote | Every deployed image traceable | M | Low | Yes |
| 8.2 Off-host backup + scheduled restore drills | encrypted off-site; monthly timed restore | backup scripts | offsite uploader | owner storage | Restore proven < RTO, alert on staleness | M | Med | Yes |
| 8.3 Monitoring/alerting | metrics, traces, dead-man, on-call channel, drills | structuredLog | OTel, alert rules | – | Drill: pager fires for each critical alarm | L | Med | Yes |
| 8.4 Independent security review (F1) | close F1 | review package | – | reviewer | Findings closed | M | Med | Yes |
| 8.5 Secrets mgmt for broker tokens | encrypted at rest, rotation, daily Kite token refresh | – | `secrets` | – | No plaintext secret on disk | M | Med | Yes |

---

## 12. FINAL VERDICT

- **Can this system safely run in paper mode today? — Yes, in the narrow sense**, as a *record-only intake system*: it can capture, store and parse claims and cannot trade (no execution code exists; claims are DB-constrained unapprovable). **No**, if "paper mode" means paper trading: there is no sizing, risk, execution simulation, P&L or reconciliation.
- **Can it safely run live today? — NO.** No risk engine, no approvable proposals, no broker integration, no protective-stop logic, no kill switch, no reconciliation, no immutable audit, no tested restore off-host, no independent review.
- **Minimum mandatory work before `LIVE_TRADING=true`:** Phase-1 items 1.1–1.4, 1.6; 2.1, 2.2, 2.5; 3.3 (a scored source or an explicit decision to trade unscored at minimum size); 4.1–4.4 (at least agents A,B,C,I,J,K,M,O); 5.1–5.5; 6.1–6.2; 8.1–8.5; plus ≥ 4–8 weeks of reconciled paper trading and a written owner go/no-go. Sizing must default to the smallest lot with a hard ₹ daily loss cap until live statistics exist.
- **Recommended first 10 implementation tasks, in order:**
  1. 1.1 Uniform live-guard + second gate (all processes).
  2. 1.3 Audit immutability (triggers + hash chain) and route approvals/validations through it.
  3. 1.2 DB-backed kill switch / system mode.
  4. 1.4 SL-required + explicit executable-freshness rule across equity and options paths.
  5. 1.5/1.6 Rename `APPROVE`; execution import-boundary test; `orders.risk_decision_id` NOT NULL.
  6. 8.1 Get CI running on a hosted runner (unit + integration) and tie image digests to commits; also run the integration suite once locally to replace the UNKNOWN in this report.
  7. 2.1 Outbox for durable intake + 8.2 off-host encrypted backup with scheduled restore drill.
  8. 5.1 Risk policy core (pure, property-tested, fail-closed on missing budgets) — requires owner to supply budgets.
  9. 2.2 + 2.5 Case linking (cancel/amend/exit) and a verified instrument master.
  10. 3.2 Case reconstruction + outcome conventions on the existing archive (needs a premium/OHLC source decision) → first real scorecard.

### Honest caveats
- Percentages are judgement, weighted by how much of each stage's *specified behaviour* is implemented, tested and safe; the repo's own matrix (10 of 127 requirements verified-implemented) is consistent with this.
- Integration tests, Python tests, staging runtime state, CI-on-GitHub and `TWINS_Planning_Pack` contents were **not** verified by this audit (UNKNOWN). To verify: run `docker compose -f infrastructure/staging/docker-compose.test.yml` equivalent + `npm run test:integration`; `python -m unittest` in `services/telegram-capture`; check `git remote -v` and the Actions tab; read `TWINS_Planning_Pack/00_START_HERE.md`.
- Broker/regulatory facts about Kite Connect (token expiry, rate limits, static IP, costs) are from general knowledge and must be verified against current Zerodha/SEBI documents before design.
