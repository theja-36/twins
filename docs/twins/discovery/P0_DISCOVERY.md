# P0 discovery notes (2026-11-06)

> Written for the owner. **Documentation only: no code, schema, host, provider or safety-flag change, and nothing here is scheduled or authorized.** Companion to [PRODUCT_VISION_BACKLOG.md](../PRODUCT_VISION_BACKLOG.md). Facts below come from reading the repository at `origin/main` (docs and package source, not a run); where a statement is a judgement it says so. No estimates are given. Numbering follows the vision list (#1 adaptive management, #2 source health, #3 dynamic sizing, #4 options risk, #5 outcome attribution, #6 decision card); the 2026-11-06 reply called options risk "#8", which is #4 in the list.

## Owner order
1. #2 source health + #6 decision card (lowest risk, inspectable).
2. #1 adaptive management + #3 dynamic sizing (shadow first).
3. #4 options risk + #5 outcome attribution.

## Rules every P0 feature follows
* Read-only or advisory first; a feature may tighten risk but never relax a limit, and never promote itself (baseline section A, rule 7).
* Shadow before anything is allowed to affect a decision; shadow output must be inspectable.
* Missing data stays unavailable. Thin samples are labelled, never treated as strong evidence.
* No order, paper trade or live call is introduced by any first slice. Engine enforcing, paper trading and `LIVE_TRADING` stay as they are.

---

## #2 Source health profile

**What exists today**
* Three different notions of "source", none joined up:
  * *Provider-file health*: the exporter logs `provider.published` / `provider.failed` / `provider.skipped` per pass with a reason code; the worker reads files and an unreadable or stale file becomes UNAVAILABLE for that agent. There is no stored history; the record is the host journal (about 7 days).
  * *Signal-source quality, historical*: `packages/historical/src/scorecards` plus `docs/twins/SOURCE_SCORECARDS.md` (D-063): per-channel win/loss/expectancy, SL discipline, revision conflicts, data quality, evaluated only from imported historical outcome labels. Trust tiers exist. The doc states that no risk decision reads it.
  * *Per-run source reliability*: `packages/decision-intelligence/src/sourceReliability.ts` returns `UNKNOWN` for every source, by design, with a comment naming the future phase that should change it.
* `/intelligence/source` and `/health/status` endpoints exist in the API; the sizing engine takes a `sourceTrustTier`.
* The news rule `minReliability` already uses a per-item reliability number (Marketaux adapter uses a fixed 0.4).

**Smallest first slice (read-only)**
A *profile document* assembled on demand, no new table: for each provider file (calendar, macro, quotes, holidays, constituents, news, sentiment) report `last_ok_at`, `as_of` age, `last_failure_reason`, and consecutive failures, read from the files' own metadata plus the exporter's pass log. Expose it as one read-only API route and a section on the status surface. The historical scorecard tier is shown beside it, labelled as a different thing.

**Shadow plan**
It is read-only, so it is its own shadow: it changes nothing a decision reads. A later step could feed it into the decision card (#6) and, only with owner approval, into sizing as a *reduce-only* input (#3).

**Open questions**
1. One profile model covering providers *and* signal sources (Telegram channels), or two profiles that the card shows side by side?
2. Where does history live: derive from files and journal only (no retention), or a small append-only table so trends survive the 7-day journal? (A table needs a migration and your approval.)
3. Should a degraded source tier ever downgrade a decision automatically, or only be shown? Recommended: only shown, until there is evidence.

---

## #6 Explainable decision card

**What exists today**
* `/risk/decisions/:id/approval-card`, `/summary`, `/intelligence`, `/approval-eligibility` already return card-like data for the approval workflow (`RISK_APPROVAL_WORKFLOW.md`, `RISK_DECISIONS.md`).
* The agent engine stores every run append-only and hash-chained with findings, evidence references, input snapshot hashes and a *synthesis* record: `decidedBy` (blocking verdict, required agent missing, adverse veto, weighted score), per-agent verdict summaries, unavailable reasons and per-rule threshold checks (`packages/agents/src/synthesis.ts`). This is most of the explanation content already.
* Sizing records store tier, caps, per-unit risk, max loss and the config used. Stop-loss validation, expiry and portfolio checks are stored per decision.
* The shadow run output is currently log-only (HB-25: durable shadow-run table deferred, D-094).

**Smallest first slice (read-only)**
A single read-only view assembled from existing records for one decision: verdict and `decidedBy`, each agent's verdict plus top findings, what was unavailable and why, risk gates and sizing facts, and a "what would change this" list derived from the threshold checks that were close to flipping. No new computation of a decision; text built from stored fields only, with no model-generated prose.

**Shadow plan**
Render the card for decisions that already exist (including synthetic ones); compare the card against the stored records in a test so it can never state something the records do not say. The card is evidence for the human, not an approval.

**Open questions**
1. Is the card a new route or an extension of `/approval-card`? Extending avoids two sources of truth.
2. Does the card need the durable shadow table (HB-25) to explain shadow runs, or only enforced decisions at first?
3. Audience and form: the web app, a Telegram message, or both?

---

## #1 Adaptive trade management

**What exists today**
* Paper trade manager (`packages/paper/src/manager.ts`) already implements simulated management: stop-first conservative checks, three partial targets with configurable fractions, break-even stop after target 1, percent or points trailing stop after N targets, time-based square-off at 15:20 IST, adverse slippage. Configured by `TWINS_PAPER_*` variables; **paper trading is off and nothing runs it**.
* `MANDATORY_STOP_LOSS.md`, `packages/stop-loss` (validation and option-premium stops).
* Outcome records capture MFE/MAE in R, which is the raw material for evaluating management rules.
* Management is *rule-fixed*, not adaptive: the trail and break-even rules ignore regime, volatility, news or time to event.

**Smallest first slice (offline, replay only)**
A pure function `proposeManagement(trade, context) -> proposal` that suggests (never executes) a stop move, a partial exit or a hold, always toward safety (stops only tighten). Evaluated by *replaying* the existing deterministic tick tests and any historical outcomes, comparing proposals with what the fixed rules did. No wiring to the paper cycle.

**Shadow plan**
Run the proposal function beside the fixed rules on paper or replay data, log both, and measure R difference. Stage: replay only, then paper shadow (needs paper trading, a separate owner decision), then owner-approved amendments. Never automatic stop widening.

**Open questions**
1. Proposals only, or owner-approved amendments? (Recommended: proposals only.)
2. Inputs allowed: volatility, regime (#7, P1), upcoming-event proximity from the calendar, news (#12, blocked)? Which are in the first slice? (Recommended: volatility and calendar proximity only; both exist.)
3. Without trade history the evaluation is replay-only; is replay on the imported historical archive acceptable as the first evidence?

---

## #3 Dynamic position sizing

**What exists today**
* `packages/risk/src/sizing`: `sizing-v1`, a pure deterministic engine. Size comes from the planned *maximum loss*, never from the target or signal strength, rounded down to whole lots, and refuses if one lot exceeds the risk. Tier logic: confidence tier and source trust tier, the lower applies; tier shares of the per-trade cap (HIGH 100%, MEDIUM 50%, LOW 25%); per-trade cap 1% of capital by default, hard ceiling 5% (`HARD_MAX_RISK_PCT`), config via `TWINS_SIZING_*`, malformed values throw. Records are stored.
* `packages/risk/src/portfolio` (portfolio limits), `packages/risk/src/market` (market and session gates), `packages/risk/src/breakers` (circuit breakers), `PORTFOLIO_RISK_LIMITS.md`.
* Capital is `TWINS_SIZING_AVAILABLE_CAPITAL`, default null, meaning nothing can be sized until the owner sets it.
* Missing today: volatility, regime, drawdown state and correlation are not inputs; the tier shares are fixed constants.

**Smallest first slice**
A *pure multiplier* in `[0,1]` computed from extra inputs (recent drawdown state, a volatility ratio, source health from #2, thin-evidence flags) and applied *after* `sizing-v1`, so it can only reduce quantity. Returned beside the v1 result (`v1 quantity`, `multiplier`, `reasons`), v1 unchanged and still authoritative.

**Shadow plan**
Compute the adjusted size for every sizing record and store/log it beside v1's, without using it. Review the distribution: how often it would have reduced, by how much, for which reasons. Promotion to "used" is a separate owner decision with its own gate.

**Open questions**
1. Reduce-only (recommended) or may it ever increase above v1's tier size? Increasing touches the "never relax" rule, so it would need a distinct owner policy.
2. Capital: when will `availableCapital` be set, and is it the full account or a TWINS allocation?
3. Which drawdown definition and window (R-based, rupee-based, daily, rolling)? This interacts with the P1 drawdown breaker (#11).

---

## #4 Options-specific risk

**What exists today**
* `options-risk-v1` agent (Stage 5 / Task 6, `packages/agents/src/agents/optionsRisk.ts`): premium, spread, IV and IV change, theta, gamma, vega, delta, strike distance, expiry proximity, OI, volume and premium stop-loss, all from *injected* option quote and chain providers. Verdicts UNAVAILABLE, BLOCKING, ADVERSE, CAUTION, NEUTRAL, SUPPORTIVE; `canBlock: true`; non-option signals are NEUTRAL, not applicable.
* `packages/signals/src/options`: contract parsing, instrument master, premium handling, provider snapshot, Dhan import; `packages/stop-loss/src/options.ts` and expiry modules (`packages/risk/src/expiry`, `market/expiry.ts`).
* **No option quote or chain provider is wired in staging**, so the agent returns UNAVAILABLE in practice. HB-16 (volatility surface, implied-versus-realised) and HB-17 (exchange-calendar expiry) are open.

**Smallest first slice**
Not new risk logic. First the data: decide the option quote/chain source and add a read-only provider file in the same exporter pattern (hostname-pinned, firewall go-ahead, no key in chat). Then the existing agent has real input and its output can be viewed on the decision card.

**Shadow plan**
Once quotes flow, the agent already runs in shadow with the rest of the engine; review its verdicts on option signals before anything else is added (portfolio-level delta/vega exposure belongs with #10 in P1).

**Open questions**
1. Option data source: Kite (token refresh deferred, so blocked), a free chain feed, or the owner's existing Dhan data? Terms and access need checking, as with Marketaux.
2. Which option strategies first: long calls/puts only (what the agent assumes), or spreads?
3. Scope of NIFTY/BANKNIFTY weeklies versus stock options.

---

## #5 Outcome attribution

**What exists today**
* Historical archive import and **outcome evaluation** (`packages/historical/src/outcomes`, `HISTORICAL_OUTCOME_EVALUATION.md`): per-signal labels (WIN_T1..T3, LOSS_SL, NO_ENTRY, EXPIRED, UNVERIFIABLE) in a fixed R model, with dataset hashes.
* Source scorecards (above) and a pattern library (`PATTERN_LIBRARY_AND_CONFIDENCE.md`, `packages/historical/src/patterns`) with calibrated confidence.
* Paper learning loop (`packages/paper/src/learning.ts`): each closed paper trade becomes one immutable outcome (R, MFE/MAE, close reason, holding time, source trust tier, confidence, research assessment) with stats by close reason, trust tier and assessment, and a minimum-sample flag. It "only measures" and changes nothing. There are `/paper/outcomes` and `/paper/outcomes/stats` routes.
* No live or paper trade history exists (paper off), so attribution has only the imported historical set.

**Smallest first slice (offline, historical only)**
A decomposition report over existing labels: outcome by source, market, side, time-of-day, expiry proximity, confidence tier and (where stored) agent verdicts at decision time, each with its sample size and a "too thin to read" flag. Report only; no weights change.

**Shadow plan**
It is a report. The shadow element is to compare the factors it surfaces against what the engine's agents already weigh, to see whether the engine's verdicts predicted outcomes (a calibration check, HB-19). Nothing adaptive without owner approval.

**Open questions**
1. Attribution method: simple stratified tables (recommended; honest on small samples) or model-based factor attribution? The latter overfits quickly here.
2. Minimum sample before any factor is shown as a finding (the paper code uses a `minSampleForMeaning`; what value do you want)?
3. Should execution effects (slippage, fill delay) be part of attribution now, or wait for #18?

---

## Suggested slice sequence (for approval, not started)
1. #2 profile view and #6 card view share one read-only "evidence assembler" over existing stored records. Both can be built with no migration, no provider call and no change to any decision.
2. #3 multiplier and #1 proposal function as pure, tested functions with a replay or shadow comparison and no wiring.
3. #4 starts with the data-source decision; #5 starts with the historical-only report.

## Cross-cutting dependencies
* Paper trading is off, so #1 and #5 have no live-ish data until you decide otherwise.
* Kite token refresh and feed run are deferred, so option data from Kite (#4) and fresh macro context are limited.
* News impact (P1 #12) stays blocked on the Marketaux permission reply; none of the P0 first slices need it.
* HB-25 (durable shadow table) would make #3's and #1's shadow comparisons durable; it is currently deferred by D-094.
