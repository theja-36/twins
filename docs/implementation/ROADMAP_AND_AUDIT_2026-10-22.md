# TWINS - read-only audit and implementation roadmap (2026-10-22)

Scope: read-only. Nothing was built, deployed, migrated, restarted, pulled, committed, pushed or configured; no provider, Telegram, broker, DNS, firewall, Traefik, Ollama or secret change. `LIVE_TRADING=false` throughout. F1 and R0B are treated as OPEN (no independent evidence of closure was found).
Evidence labels: **[V]** verified by a command in this audit; **[R]** read in code/docs; **[I]** inference (stated as such). Anything I did not check is listed as unknown.

Research confidence is not profitability. No component below can guarantee or predict profit. "Confidence" in TWINS means how well-supported a conclusion is by recorded evidence; "calibrated risk" means a historical frequency with an uncertainty interval; profitability exists only as measured paper/live results net of costs, and can be zero or negative.

---------------------------------------------------------------------------------------------------------------------------
## A. VPS state verification (2026-10-22 ~11:00Z, root@168.231.114.40, alias `hostinger-vps`)

| # | Item | Result |
|---|---|---|
| 1 | SSH | Works with the existing key [V]. sshd allows `PermitRootLogin yes` and `PasswordAuthentication yes` [V]. The non-root alias `hostinger-agentops` is still refused ("Permission denied (publickey,password)") [V]. |
| 2 | TWINS containers | api (healthy, up 24h), postgres 16 (healthy, 34h), redis 7 (healthy, 24h), worker (up 24h; no health check). 0 restarts, no OOM [V]. Image `twins-staging:local` (id `e41f6a71...`, built 2026-10-21; older than the local tree: it has no intake guards). |
| 3 | PostgreSQL / Redis | No host ports; only on `twins_data` which is `internal=true` (no internet, no other stacks); named volumes `twins_pgdata`, `twins_redisdata`; pinned image digests; memory/CPU limits; `cap_drop ALL`, `no-new-privileges`; redis, api, worker read-only root fs; api/worker run as `node` [V]. |
| 4-5 | Reachability | API -> Redis 10.0.21.2:6379 and worker -> Redis (4 connections) [V]; API uses unique hostnames `twins-staging-postgres-1/redis-1` (fixes the 2026-10-21 bare-name incident) [V]. Worker has no DNS/egress (EAI_AGAIN): providers fail closed [V]. |
| 6 | Migrations / tables | 7 applied (matches the repo chain) [V]. 32 application tables. Rows: telegram_sources 1, telegram_messages 1, options_claims 1, jobs 1, provider_health 1; EVERYTHING else is 0 (signals 0, signal_validations 0, market_observations 0, orders/fills/positions/backtests 0). DB size 9 MB [V]. The staging database holds one test message, not real data. |
| 7 | Secrets | `staging.env` root:root 0600; variable NAMES: POSTGRES_DB/USER/PASSWORD, REDIS_PASSWORD, TWINS_API_KEY, TELEGRAM_WEBHOOK_SECRET, TWINS_API_HOST_PORT. No bot token, no provider/broker/AI keys [V]. Redis password was rotated 2026-10-21 after an 18-minute misrouting; the old value remains in a protected backup file. |
| 8 | LIVE_TRADING | `false` in api and worker; `TRADING_MODE=paper` [V]. Also a compose literal. |
| 9 | Exposure | DNS A twins.theja.tech -> 168.231.114.40 (DNS-only). Traefik v3.6 (shared Coolify proxy) healthy. Only `Host(twins.theja.tech) && Path(/health)` is routed (HTTP redirects to HTTPS) with a rate limit; Let's Encrypt cert valid to 2027-01-19 [V]. `/webhooks/telegram` and all bearer routes answer 503 (not routed) [V]. UFW active, default deny incoming, allows 22/80/443 and `10.0.0.0/16` (docker bridges); iptables INPUT/FORWARD policy DROP [V]. From the Mac, ports 11434, 4110, 5432, 6379, 4000 are closed/filtered (IPv4 only; IPv6 not tested) [V]. No Telegram bot, token or webhook registered by TWINS [V]. |
| 10 | Backup / restore / monitoring | Two dumps + one encrypted copy from 2026-10-21; a restore drill passed (pg_restore rc=0, checkpoint identical) [V]. The "offsite" copy is a directory on the SAME server [V]. No scheduled backup (only the OS dpkg timer); backups are paused by instruction. No TWINS monitoring/alerting found (only healthchecks; unattended-upgrades running) [V]; I did not inventory other tenants' monitoring. |
| 11 | Open issues | **F1** open (R0A-era API/crypto/DB-client code never independently reviewed; agent self-review does not count) [R]. **R0B** open [R]. **Loopback 500**: fixed and verified 2026-10-21 (unique hostnames) [V]. **Build context**: fixed in the LOCAL compose (`../../src`); NOT deployed. Build is further blocked: the pinned `node:22-bookworm-slim` digest is no longer on the VPS [V]. **Non-root access**: still refused [V]. **Ollama**: running, enabled, `OLLAMA_HOST=0.0.0.0:11434`, listening on all interfaces, one model (qwen2.5-coder:3b); unauthenticated API. Blocked from the internet by INPUT DROP (external probe closed), but allowed from `10.0.0.0/16` docker bridges, which includes the API's `coolify` network [V]. TWINS does not use it [R]. |

Other facts: the host is shared (about 80 other containers; several published on 0.0.0.0, partly blocked by DOCKER-USER rules) [V] - not audited. Free: 57 GB disk, about 8 GB RAM available, 8 GB swap [V]. Docker build cache 19.9 GB (17 GB reclaimable) [V].

---------------------------------------------------------------------------------------------------------------------------
## B. Audit findings by severity

### Critical
| ID | Finding | Why it matters / status |
|---|---|---|
| C1 | **Provenance and single-copy risk.** HEAD `b2ad592` (11 commits, no git remote) lacks the deployed and tested code: 65 modified and 58 untracked entries, including required source (e.g. `adapters/telegram/src/intakePolicy.ts`, `packages/ingestion/src/history.ts`, `apps/web/src/`, migrations 0004-0006, `optionsClaims.ts`) [V]. All work exists only in this working tree on one Mac. | A disk failure or accidental clean destroys the product and the running image cannot be reproduced from Git. Needs a branch, split commits and an off-machine remote (owner decision). |
| C2 | **F1: security-critical code unreviewed.** `apps/api/src/index.ts` (auth/webhook), `packages/shared/src/crypto.ts`, DB client, decision code were rewritten in R0A and never independently reviewed [R]. | Must be reviewed by someone other than the implementing agent before any public exposure or real data. |
| C3 | **Deployed code has no source restriction on Telegram intake.** Anyone holding the webhook secret could create sources/messages/jobs from arbitrary chat ids [R, V]. The fix (allowlist + options-only) is implemented and tested locally (unit 685/685, integration 170 passed) but NOT deployed. | Mitigated today only because `/webhooks/telegram` is not routed. Must not be exposed until the guarded image is deployed. |
| C4 | **"APPROVE" naming collision.** The decision engine's `APPROVE` means "evidence sufficient for analysis", explicitly not authorisation to trade; executable freshness is undefined [R]. The product's APPROVE/REJECT is a different, human action. | A future execution component could mistake one for the other. Rename the engine outcome and define separate states before any approval workflow. |

### High
| ID | Finding |
|---|---|
| H1 | Host SSH: root login and password authentication enabled; 22 open to the world; no non-root deploy user (agentops refused) [V]. Brute-force and shared-credential exposure on a host that will later hold broker credentials. |
| H2 | Ollama bound to all interfaces, unauthenticated; reachable from docker bridges including the API's network; not reachable externally [V]. Prompt-injection/data-exfiltration path if any LLM feature is added later. |
| H3 | No reproducible build: pinned base image absent on VPS; image built by hand from an unversioned tree; compose build context was wrong (fixed locally, undeployed) [V]. |
| H4 | Backups: no schedule; the "off-site" copy is on the same server; nothing off-host; paused [V]. Acceptable at 9 MB of test data; unacceptable once real archive data exists. |
| H5 | No monitoring or alerting for TWINS (worker has no health check; failures are silent) [V]. |
| H6 | Market data is Yahoo's unofficial chart endpoint [R]: no SLA, terms-of-use risk, daily/limited history, no Indian option chains, OI/IV, or option premium history. The schema has `open_interest` but nothing populates it for options [R]. |
| H7 | Resource and blast-radius coupling with ~80 other containers on one host; API joins the shared `coolify` network [V]. |
| H8 | Diagnostic data retention: `jobs.error` stores full error text and BullMQ keeps failed reasons; an open security item from the R0B closure review [R]. |

### Medium
- Single static bearer token for the private API: no rotation, expiry, per-client identity or audit of reads; the `users` table is unused [R].
- `audit_events` has only three writers (market/macro ingestion, entity events); there is no audit of approvals, reads or admin actions because those features do not exist yet [R].
- No dependency vulnerability scanning in CI or the image (`NPM_CONFIG_AUDIT=false`; CI steps: install, typecheck, lint, unit, build, guard) [R]. Six packages have install scripts (esbuild variants, msgpackr-extract, fsevents) [V].
- Test credentials committed in CI/compose (test-only) and untracked `.vscode/`, `TWINS_Planning_Pack/` (F4 hygiene) [R].
- Dead/unused code: broker, macro and AI adapter packages are contracts/registries with no vendor; tables accounts, users, analyses, decisions, risk_decisions, orders, fills, positions, portfolio_snapshots, broker_connections, backtests, backtest_results are never read or written by runtime code [V by grep]; scheduler is off [R].
- Duplication/monitoring: two similar servers (API, viewer) with separate hardening; three scripts for options tooling [R].
- Parser: regex-based, single-directive; real-world accuracy has never been measured (one real message in staging) [V].

### Low
- `dist/` directories and `.DS_Store` in the tree (ignored by `.dockerignore`) [V]; 56 lint warnings, 0 errors [V]; viewer UI is minimal read-only [R].

### Reliability notes (verified in code/tests unless marked)
Good: idempotency keys (deterministic job ids per message revision), unique indexes as correctness boundary, bounded producer enqueue (503 on dependency failure), retries with backoff (3 attempts), crash-recovery and concurrency integration tests, correlation logging. Gaps: no dead-letter handling policy or alert, no stale-data alarms, no partial-fill/reconciliation logic (no execution exists), no queue-depth monitoring.

### Data/model risks (design-level; the capabilities do not exist yet)
1. **Hindsight via edits**: a Telegram export contains the FINAL text of edited messages; the original (pre-edit) text, possibly posted before the move, is lost. Live capture preserves revisions; archive import cannot [I].
2. **Survivorship**: deleted messages and unannounced exits are invisible in an archive [I].
3. **Look-ahead/leakage**: the code enforces explicit as-of time and excludes synthetic data in analysis [R, tested], but any new feature store must keep that rule.
4. **Outcome ambiguity**: daily bars cannot tell whether stop or target was hit first; option premium history is unavailable through the current layer ("expired-option premium data is not available") [R].
5. **Overfitting/multiple testing** when "discovering strategies" from a few hundred signals [I].
6. **Unverified claims**: options claims are stored as UNVERIFIED with `approval_possible=false` enforced by the database [V]; contract master is only an offline Dhan CSV import, not configured on staging [R].
7. Backtest accounting (fees, slippage, taxes, lot sizes, liquidity, fill model) is undefined [R].

---------------------------------------------------------------------------------------------------------------------------
## C. Existing strengths
- Fail-closed safety posture: `LIVE_TRADING=false` literal, paper mode, providers off, worker has no egress, webhook secret verified before the body is read, constant-time comparisons, bounded bodies, minimal-metadata rejection logs [V/R].
- Idempotent, revision-aware Telegram ingestion (original, edited, redelivered updates distinct and deduplicated) with database-level uniqueness; immutable raw message store [R, integration-tested].
- Options handling that refuses to over-claim: claims stored UNVERIFIED, never approvable (database check constraint), contract master/premium default to "unavailable" [V].
- Deterministic decision pipeline with bull/bear/counter-thesis, source reliability and structural validation, fail-closed outcomes, confidence stated as count-based and not a probability [R].
- Data-quality engine, as-of context windows, synthetic-data exclusion, lineage-ish `signal_evidence` links with unique constraints [R].
- Strong test discipline: 685 unit tests (52 files), 175 integration tests against guarded local PostgreSQL/Redis (170 pass, 5 skipped by design), mutation-checked packaging tests, backup/restore drill, crash-recovery tests [V].
- Hardened, isolated staging deployment: internal network, pinned digests, least privilege containers, rate-limited single public health route, TLS [V].
- Connector-independent history primitive for UNDERLYING bars with explicit provenance/as-of semantics (`packages/ingestion/src/history.ts`), and an offline Dhan contract-master importer [R].
- Detailed specification (`docs/SPECIFICATION.md`, 55 sections) covering paper trading, backtests, shadow mode, risk engine, kill switch, live mode [R].

---------------------------------------------------------------------------------------------------------------------------
## D. Capability gap analysis (target product vs reality)

Classes: **IV** implemented and verified | **PI** partially implemented | **M** missing | **U** incorrect or unsafe | **BE** blocked by external integration | **BA** blocked by missing approval.

| # | Required capability | Class | Reality |
|---|---|---|---|
| 1 | Live Telegram signal ingestion | PI, BA | Webhook, normalisation (4 update types), idempotency, allowlist (local only). Deployed image lacks the allowlist; no bot, no public route (approvals needed). |
| 2 | Historical archive import | M | No importer. `sinceExternalMessageId` exists in a type but is unused. |
| 3 | Structured parsing/validation, options + equity | PI | Regex parser v2 for single BUY/SELL directive, entry/SL/targets/timeframe/confidence; options parser for supported index underlyings; unsupported/ambiguous flagged. Never measured on real data; no multi-leg, free-form, image/chart signals. |
| 4 | Contract and premium verification | PI, BE | Offline contract master import exists, not configured; no premium/OI/IV feed. |
| 5 | Outcome tracking (entry, SL, T1/T2, P&L, drawdown, time-to-target) | M | No outcome model or evaluator; `signals` stores entry/SL/targets only. Tables for backtests/positions are empty and unused. |
| 6 | Strategy discovery | M | None. |
| 7 | Reliability scorecards (channel vs TWINS) | M | None (zero code). |
| 8 | Market research: price, volume, OI, IV | PI, BE | Yahoo daily bars + quality checks; OI column unpopulated; no IV, no option chains. |
| 8b | Technicals | M | No indicator code at all. |
| 8c | News | PI | GDELT adapter stores article metadata as unverified evidence; no sentiment by design. |
| 8d | Sentiment / market mood | M | None. Macro adapter is an empty registry. |
| 9 | Assessment of incoming signals with failure-risk estimate | PI | Deterministic evidence validation exists; no failure-probability estimate (needs outcome data, item 5). |
| 10 | TWINS self-generated signals | M | None. |
| 11 | Alternative candidate when Telegram risk is high | M | None. |
| 12 | Telegram recommendation cards | M | No outbound Telegram, no bot token, no message builder. |
| 13 | APPROVE/REJECT interaction | M, BA | No callbacks, no approver identity, no approval ledger. |
| 14 | Paper trading | M | Spec section 36 only; tables unused. |
| 15 | Broker execution (controlled) | M, BE, BA | Provider contracts only; no vendor, risk engine, kill switch, reconciliation. |
| 16 | SL, T1, T2 management; adaptive profit booking | M | Nothing; fields exist on `signals`. |
| 17 | Evidence/reasoning stored for every exit | PI | Primitives (`signal_evidence`, `audit_events`, idempotency) exist; no exit logic. |
| 18 | Feedback loop without overfitting | M | None; governance design needed first. |
| 19 | Security baseline | PI / U | Strong app-layer controls; host SSH, Ollama, F1 review, secrets rotation/audit gaps (Section B). |
| 20 | Operations: backups, monitoring, reproducible deploy | PI / U | Drill proven; nothing scheduled, off-host or monitored; build path broken. |

---------------------------------------------------------------------------------------------------------------------------
## E. Recommended target architecture

Principle: separate a **research plane** (no broker credentials, no order path) from an **execution plane** (separate service, credentials, network and database role; accepts only an approved, risk-checked, idempotent instruction). Every arrow stores evidence; every model/parameter is versioned; nothing self-modifies in production.

```
Telegram (live webhook, allowlisted chat)  \
Telegram archive export (owner-supplied)    >-> immutable raw store -> parser (versioned) -> signal store
                                                                                   |
Market data (EOD -> intraday, underlying + options, OI)  -> as-of price store ------+
News/macro (evidence only) -------------------------------> feature store (as-of)   |
                                                                                   v
                            outcome engine (deterministic replay, explicit conventions) -> outcomes
                                                                                   v
          scorecards (channel vs TWINS) + strategy discovery (out-of-sample, multiple-testing guards)
                                                                                   v
   assessment service (evidence + calibrated historical risk with intervals) -> candidate generator (research/shadow first)
                                                                                   v
   recommendation service -> Telegram card (owner only) -> APPROVE/REJECT -> approval ledger (signed, expiring, idempotent)
                                                                                   v
                        paper engine + position manager (SL/T1/T2, adaptive rules)  ==> exit decision evidence store
                                                                                   v
          risk engine + kill switch + reconciliation -> broker adapter (read-only first, then controlled orders)
```
Cross-cutting: Postgres (partition large series), job queue (BullMQ), per-plane DB roles, secrets outside Git, structured audit log, health/queue/data-freshness monitoring and alerts, off-host encrypted backups, reproducible versioned images, LLM use limited to summarising untrusted text under strict injection defences and never deciding (optional).
Honest limits: the system can rank and describe evidence and measure historical frequencies; it cannot predict outcomes. Small samples produce wide intervals and the product must show them.

---------------------------------------------------------------------------------------------------------------------------
## F. Phased roadmap (each phase = one approval boundary or more; never one approval for several)

Complexity: S (days), M (1-2 weeks), L (3-6 weeks), XL (>6 weeks). Estimates are rough, for a single developer plus this assistant, and exclude waiting for vendors/approvals.

### Phase 0 - Checkpoint, review and operational hardening (prerequisite)
- **Goal:** make the code reproducible, reviewed, backed up and deployable.
- **User-visible outcome:** the product code is in Git with a remote copy; a reviewer's sign-off on F1; the guarded image can be built; nightly off-host backups; basic alerts.
- **Work:** 0A Git branch + split commits + private remote (owner chooses), F4 hygiene; independent F1 review (not me). 0B restore pinned base image (one approved digest pull), build `tg-intake-...`, deploy per existing plan, verify. 0C ops: resume scheduled backups, encrypted off-host copy, alerting (container health, queue depth, disk, cert expiry), non-root deploy user, decision on Ollama binding/firewall, SSH hardening (owner/host decision).
- **External:** git host account; off-host storage; (optional) uptime service. **Keys:** storage credentials (new, scoped).
- **Tests/acceptance:** reviewer findings closed or accepted in writing; build from a tagged commit reproduces the manifest hash; restore drill from the off-host copy; alert fires on a controlled test; all existing tests green.
- **Rollback:** each 0x step has its own: compose/tag revert to `local`; backups are additive.
- **Complexity:** M. **Risks:** reviewer availability; host changes affect other tenants. **Depends on:** nothing.
- **DoD:** F1 closed by independent review; tagged commit = running image; one successful off-host restore; alerts live.
- **Approval boundary:** 0A, 0B, 0C separately (0C items individually where they touch the host).

### Phase 1 - Capture and research dataset
- **Goal:** accumulate trustworthy Telegram data: forward (live) and historical.
- **Outcome:** messages from the approved channel appear in the system with original text, edits as revisions, and parse results; a parse-quality report on a hand-labelled sample.
- **1A live capture (already built):** approved numeric chat id, Traefik `POST /webhooks/telegram` only (rate limit, body cap, optional Telegram IP allowlist after verifying the source ranges), webhook secret handoff, owner-run registration with `allowed_updates` restricted. Options-only guard on. No bot token on the server.
- **1B archive importer (new build):** offline CLI reading a Telegram Desktop JSON export; maps to the existing normalised message with provenance `archive_export`; handles edits recorded in the export, replies/forwards, entities; idempotent per (chat, message id); dry-run counts; import first into the local rehearsal DB, then staging after a backup. Schema: import batch table + provenance column (migration, approved separately).
- **1C parser accuracy baseline:** labelled sample harness (owner labels ~200-300 messages), precision/recall per field, taxonomy of unparsed messages; parser versions never silently replaced.
- **External:** a bot (BotFather) for 1A; the export file from the channel owner. No paid services.
- **Tests:** unit + guarded integration (idempotent re-import, edit handling, no network); deploy checks as before. **Acceptance:** re-import creates 0 new rows; counts reconcile with the export; parse report reproducible.
- **Rollback:** 1A remove route/webhook, tag back to `local`; 1B restore from the pre-import backup (restore drill proven) - batch-delete is deliberately not offered because raw messages are immutable.
- **Complexity:** 1A S/M, 1B M, 1C M. **Risks:** Telegram ToS/privacy and channel-owner permission; edit-history hindsight in archives; export format drift. **Depends on:** Phase 0A/0B.
- **DoD:** forward capture running for one approved chat; archive loaded and reconciled; parse report accepted by owner.
- **Approval boundary:** 1A steps, 1B build, 1B import to staging, 1C each separately.

### Phase 2 - Market data foundation
- **Goal:** reliable as-of price data for underlyings and, where available, options.
- **Outcome:** price/OI series for every instrument referenced by archived signals, with quality scores and gaps shown.
- **Work:** vendor decision and adapter (historical + EOD at minimum; intraday for options if affordable), instrument/contract master (existing Dhan importer), expiry calendar and lot sizes, corporate actions for equities, ingestion jobs on the scheduler (watchlist from signals), partitioning/size planning, data-quality dashboards in the viewer. NSE bhavcopy (end-of-day, official) can seed free daily data [I - verify format/licence].
- **External/keys:** market-data vendor account (paid likely); egress for the market worker only (new network rule, approval).
- **Tests/acceptance:** golden-file adapter tests; gap/stale detection; as-of replay returns identical results across runs; no synthetic data in analysis.
- **Rollback:** disable scheduler; data tables are additive.
- **Complexity:** L. **Risks:** vendor cost and terms (redistribution), option history availability and survivorship (expired contracts), timestamp conventions (open vs close stamps are unverified today). **Depends on:** Phase 1 (instrument list).
- **DoD:** documented coverage matrix (% of archived signals with usable price series); owner accepts coverage.
- **Boundary:** vendor choice, key custody, egress change, each separate.

### Phase 3 - Outcome engine
- **Goal:** deterministic outcome for every historical signal.
- **Outcome:** per signal: entered?, SL/T1/T2 hit, first-hit order (or "ambiguous"), P&L before and after assumed costs, max adverse/favourable excursion, drawdown, time-to-target; viewer pages and CSV export.
- **Work:** outcome schema (migration), explicit written conventions (entry-fill rule, same-bar ambiguity, expiry handling, lot sizes, fees, slippage), versioned evaluator in a worker job, ambiguity flags instead of guesses, reconciliation with a hand-checked sample.
- **External:** none beyond Phase 2 data. **Tests:** property tests (monotonic, reproducible), hand-calculated fixtures, no-look-ahead tests; **acceptance:** 100% of sampled outcomes match hand computation; ambiguous cases counted, not hidden.
- **Rollback:** versioned results; discard a version. **Complexity:** L. **Risks:** convention choices change results materially; option data gaps. **Depends:** 2.
- **DoD:** outcome table covers all signals with data; ambiguity rate reported.
- **Boundary:** conventions document approved by owner BEFORE coding; build; run on staging data.

### Phase 4 - Scorecards and strategy discovery (descriptive)
- **Goal:** know how reliable the channel actually is, and in which conditions.
- **Outcome:** channel scorecard (hit rates with confidence intervals, expectancy after costs, drawdown, by underlying/time/regime), and ranked, documented recurring patterns.
- **Work:** train/validation/test split by time, pre-registered hypotheses list, multiple-testing correction, minimum sample sizes, "insufficient data" states, shadow comparison framework (spec sections 37-39).
- **Tests/acceptance:** results reproduce from a versioned run; a null/shuffled-label control shows no spurious "strategies"; every pattern states sample size and interval.
- **Rollback:** descriptive only; delete runs. **Complexity:** M/L. **Risks:** overfitting, small samples. **Depends:** 3.
- **DoD:** reviewed report; owner agrees which patterns (if any) are credible.
- **Boundary:** analysis design, then runs, separately.

### Phase 5 - Market research features
- **Goal:** technical, news, sentiment and mood context per signal and per day, as-of correct.
- **Outcome:** each signal shows indicators (trend, momentum, volatility, volume, OI/IV where data exists), news evidence, a transparent mood measure (e.g. VIX level/percentile, breadth) with sources.
- **Work:** indicator library with tests, feature store keyed by as-of time, news ingestion expansion (sources need approval; GDELT only gives metadata), sentiment approach decision (rule-based vs model; untrusted-text defences if an LLM is used), mood from market series.
- **External:** news/sentiment sources, optionally an LLM provider (decision; Ollama local is an option after the exposure fix). **Tests:** golden values vs reference implementations; leakage tests; prompt-injection tests if an LLM is used.
- **Rollback:** features are derived and versioned. **Complexity:** L. **Risks:** feature count vs sample size, vendor terms. **Depends:** 2 (and useful after 3-4).
- **DoD:** documented feature dictionary; leakage tests green.
- **Boundary:** each source and any LLM use separately.

### Phase 6 - Assessment of incoming signals and TWINS research signals (shadow only)
- **Goal:** for each new Telegram signal, an evidence card with calibrated historical risk; a rule-based TWINS candidate generator evaluated in shadow mode.
- **Outcome:** viewer/card data: failure-risk estimate with interval and sample size, supporting/contradicting evidence, "insufficient data" when appropriate; TWINS candidates logged, never sent for approval yet.
- **Work:** calibration (reliability curves), minimum evidence thresholds, rename the legacy engine outcome (C4), candidate generator versions, scorecards for TWINS signals kept separate from the channel's.
- **Tests/acceptance:** calibration on held-out data; shadow results scored by the Phase 3 engine for at least an owner-set period; no candidate reaches users automatically.
- **Rollback:** feature flag off. **Complexity:** L/XL. **Risks:** poor calibration on small data; temptation to present risk as probability. **Depends:** 3, 4, 5.
- **DoD:** shadow track record published with intervals; owner decides whether candidates are worth showing.
- **Boundary:** assessment build; generator build; shadow period; each separately.

### Phase 7 - Recommendation cards and APPROVE/REJECT (no execution)
- **Goal:** a safe human-in-the-loop channel.
- **Outcome:** a Telegram card (evidence, confidence label, entry, SL, T1, T2, risks, expiry time) sent to the owner; two buttons; decisions recorded.
- **Work:** outbound bot (token custody), owner-only authorisation by numeric user id and chat, callback signature/nonce, expiry, idempotent decisions, approval ledger, audit events, stale-card handling, anti-replay, rate limiting, kill switch for the bot.
- **External:** bot token (new, scoped); egress for the notifier only. **Tests:** replay/forgery/expiry/duplicate-click tests; chaos test (API down mid-approval). **Acceptance:** an approval can never be applied twice or after expiry; only the owner can approve.
- **Rollback:** disable notifier; ledger retained. **Complexity:** M/L. **Risks:** token compromise, social-engineering of the owner, alert fatigue. **Depends:** 6 (or 3 for channel-only cards), 0C.
- **DoD:** end-to-end approvals recorded with evidence snapshot; no order path exists.
- **Boundary:** bot creation/token custody, build, staging trial separately.

### Phase 8 - Paper trading and position management
- **Goal:** simulate the full lifecycle incl. SL, T1, T2 and adaptive rules with realistic costs.
- **Outcome:** approved recommendations become paper positions; the system monitors them and records each decision (hold, move SL to T1, tighten, book) with evidence and reasoning, then the result.
- **Work:** paper account/orders/fills (existing tables), fill model (spread, slippage, lot sizes, liquidity), monitor job (quote polling or stream), rules engine versioned and deterministic (T1 reached: re-evaluate momentum, volatility, technicals, news, mood -> if favourable move SL to T1 and keep part for T2, else book/tighten; T2: book rest), full exit-decision evidence store, daily reconciliation report.
- **External:** intraday/near-real-time quotes (vendor). **Tests:** scenario suite (gap through SL, partial fills, halted symbol, data outage, duplicate ticks); determinism; failure injection. **Acceptance:** every exit has stored evidence; outages fail to a safe state (e.g. flag position, never silently continue).
- **Rollback:** disable monitor; paper only. **Complexity:** XL. **Risks:** simulated fills flatter reality; rule overfitting. **Depends:** 7, 2.
- **DoD:** paper track record over an owner-set period, compared with the shadow baseline; costs included.
- **Boundary:** rule design review, build, paper period.

### Phase 9 - Broker integration, read-only then controlled execution
- **Goal:** controlled real orders, only after paper evidence.
- **Outcome:** read-only account/positions view first; later, small-size orders after explicit per-order approval.
- **Work:** vendor adapter, separate execution service and credentials, risk engine (position/day loss limits, instrument allowlist, max size), kill switch, reconciliation with broker state, order idempotency, partial fills, rejects, static-IP/registration requirements if applicable. Multi-step enabling gates; `LIVE_TRADING` stays false until a separate decision.
- **External:** broker account/API subscription; regulatory/compliance check (I have not verified current Indian algo-trading rules; treat as an open question). **Tests:** broker sandbox/mocks, failure injection, reconciliation drills, kill-switch drills. **Rollback:** kill switch + credential revocation.
- **Complexity:** XL. **Risks:** financial loss, regulatory, credential custody. **Depends:** 8, 0C, F1 closed.
- **DoD:** reconciliation clean for the owner-set period in read-only/paper-shadow mode before any live order.
- **Boundary:** read-only integration; execution build; first live order; each separate and revocable.

### Phase 10 - Feedback loop and model governance
- **Goal:** improve quality without silently overfitting.
- **Outcome:** periodic, versioned retraining/recalibration reports; changes only promoted after out-of-sample and shadow checks and owner approval.
- **Work:** drift monitoring, walk-forward evaluation, champion/challenger, immutable model registry, rollback.
- **Complexity:** L. **Risks:** feedback contaminating evaluation sets; regime change. **Depends:** 6, 8.
- **DoD:** at least one promoted and one rejected change with documented evidence.
- **Boundary:** each promotion separately.

Parallel track: Security/Ops (rotation, scanning, audit, monitoring) is scheduled inside Phase 0C and re-checked at every phase gate.

---------------------------------------------------------------------------------------------------------------------------
## G. Recommended Phase 1 build plan (for separate approvals)

Order: **0A Git checkpoint** -> **0B restore base image, build and deploy guards** -> **1A live capture of one approved chat** -> **1B archive importer** -> **1C parser baseline**. Rationale: live capture preserves original text and edits, which an archive cannot, so forward data should start accumulating early; the importer then fills history without needing any exposure.

1B detailed build (no external access, local first):
1. New CLI `archive:import` (dry-run default; `--commit` explicit). Input: Telegram Desktop "result.json" file path. No network.
2. Mapper: export message -> existing normalised message; chat id from the export; `externalMessageId`=message id; edits from the export's edit date flagged as `archive_final_text` (original unknown); service messages skipped with counts.
3. Schema (separate migration approval): `ingestion_batches` (id, source file sha256, counts, tool version, started/finished) and a provenance column on messages; unique keys unchanged so re-import is a no-op.
4. Tests: fixtures including edits, replies, forwards, media-only, very long text, duplicates; idempotency; guarded integration against the rehearsal DB; mutation checks.
5. Run order: rehearsal DB with a sample, review counts with you, then a backup, then staging.
6. Report: counts by type, date range, parse outcomes; files and hashes retained.
Acceptance: totals reconcile with the export; second run adds 0 rows; no network calls; `LIVE_TRADING=false`.
Dependencies: 0A recommended first (so the importer lands in a commit); your export file; confirmation you may process that channel's content.

---------------------------------------------------------------------------------------------------------------------------
## H. Questions and decisions needed from you
1. **Instruments:** index options only (NIFTY, BANKNIFTY, ...), stock options, equity, or all? NSE only?
2. **Channel and archive:** which channel(s); how many messages and what period; are you the owner/admin (permission to export and process the content; privacy of members); retention policy.
3. **Market data:** budget and preferred vendor for historical and intraday option data (Dhan, TrueData, Global Datafeeds, others) vs free EOD (NSE bhavcopy) to start; is EOD-only research acceptable for the first outcomes?
4. **Outcome conventions:** entry fill rule (touch of entry price vs market at message time), what happens when SL and T1 fall in the same bar, costs/slippage assumptions, holding period (intraday vs positional), expiry handling.
5. **Telegram bot:** create a dedicated bot; your numeric Telegram user id as the only approver; where the token may be stored (my recommendation: only on the notifier service, never on the research plane).
6. **Broker:** which broker/API, existing account, and willingness to complete any registration they require; maximum capital at risk, per-trade and daily loss limits, whether option buying only.
7. **Compliance:** have you checked current SEBI/exchange rules for automated order placement and for sharing recommendations (I have not verified them; they may require static IP, registration or approval)?
8. **LLM use:** none, local Ollama only (needs the exposure fix), or an external provider? Is it acceptable to send channel text to an external provider?
9. **Infrastructure:** stay on the shared VPS or move TWINS to a dedicated host; where should off-host encrypted backups go; who holds the keys?
10. **Review and Git:** who performs the independent F1 review; may I create a branch and split commits; which private remote?
11. **Host hardening decisions** (yours/host owner's): disable root/password SSH, create the non-root deploy user, bind Ollama to localhost or firewall it.
12. **Success criteria:** what result would make you stop the project (for example a scorecard showing no edge after costs)? This keeps the research honest.
