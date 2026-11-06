# Design: shadow wiring of #3 reduce-only sizing and #1 adaptive management

**Status: DESIGN FOR REVIEW. No code in this PR beyond this document. Nothing is wired, no flag is added, nothing is deployed.** Written 2026-11-06 for the owner, to be reviewed before Monday's Kite run. Constraints throughout: engine enforcing OFF, shadow ON, `LIVE_TRADING=false`, paper trading OFF, no orders, no Stage 6.

## 0. What I found in the code (these shape the design)
1. **Sizing hook point.** `recordPendingRiskDecision` in `services/worker/src/index.ts` runs: create decision -> source intelligence -> (enforcing agents) -> **shadow agents (log-only, errors swallowed)** -> `size()` (`sizeLatestRiskDecisionFor...`, engine `sizing-v1`) -> portfolio evaluation. The existing agent shadow already sets the pattern: observe, log, never throw, never halt.
2. **Management hook point.** The only place trades are managed is the paper tick loop `packages/paper/src/service.ts` (`step(before, price, config)` for each OPEN trade). **Paper trading is OFF, so there are no OPEN trades and no live management to shadow.**
3. **Staging has nothing to observe today.** In the last 24 h the worker recorded 0 risk decisions, 0 shadow assessments and 0 sizing events, and `TWINS_SIZING_AVAILABLE_CAPITAL` is not set (the sizing engine returns no size without capital). So a log-only shadow on live staging traffic would produce no data until signals flow and a capital figure exists.
4. **Inputs for #3 are partly available.** Drawdown: the circuit-breaker module holds loss events (synthetic/manual only; no broker). Volatility ratio: no source yet. Hours to a high-impact event: the economic-calendar file the agents already read. Unusable-source count: `buildSourceHealth` over the worker's read-only provider mount. Thin evidence: source-intelligence `dataSufficiency` / sample size. Anything unavailable stays `null` and the function already treats null as "no change, listed as unknown".
5. **Architecture test** allows `@twins/risk` imports only in named files; the worker index is allowed. `@twins/paper` already depends on the risk decision reader.

## 1. Principle: observe, record, never act
Shadow output is **log-only evidence** (durable storage is HB-25, still deferred). The reduce-only functions are not called from any code path whose result is used: the shadow call sits after `size()` returns and its return value is discarded except for the log line. The v1 decision, its quantity, its status and everything downstream are byte-identical with the flag on or off.

## 2. #3 reduce-only sizing in the shadow decision path
**Where:** one new helper `shadowReduceOnly(log, db, sizingOutcome, ctx)` in the worker, called immediately after `size()` when `sz.sizingStatus === "SIZED"`, wrapped in `try/catch` exactly like `shadow(latestId)`, with the same kind of hard timeout.

**Flow:**
1. Gate: new env `TWINS_REDUCE_ONLY_SHADOW` (default `false`, strictly `true|false` like `TWINS_AGENT_ENGINE_SHADOW`), refused to be `true` while `enabled` (enforcing) is true or `LIVE_TRADING` is true, so it can never coexist with an acting engine.
2. Build `ReduceOnlyInputs` from read-only sources: `v1Quantity` from the sizing outcome; `unusableSources` from `buildSourceHealth(observeProviderFiles(dir))`; `hoursToHighImpactEvent` from the calendar file; `thinEvidence` from the decision's source-intelligence; `drawdownPct` from the breaker module read (null if capital unknown); `volatilityRatio` null until a source exists.
3. Call `reduceOnlySize(inputs, DEFAULT_POLICY)`.
4. **Self-check (belt and braces):** assert `result.adjustedQuantity <= v1Quantity` and `usedForDecisions === false`; on any violation log `risk_sizing.shadow.violation` (CRITICAL-class) and discard the result. The function is also property-tested (5000 random cases) never to exceed v1.
5. Emit one structured log line `risk_sizing.shadow.reduce_only` with: decision id, version, `v1Quantity`, `shadowQuantity`, `multiplier`, reasons (codes), `unknownInputs`, policy version. No message text, no prices beyond quantities. `usedForDecisions:false` on every line.

**Never:** writes to `risk_decisions`, calls `supersedeRiskDecision`, changes `status`, feeds the portfolio gate, the approval card or any order path.

## 3. #1 adaptive management: two tracks, because paper is OFF
**Track A: Replay (available now, no paper needed).** `replayManagement(start, ticks, cfg, policy)` runs the fixed paper rules versus fixed rules plus the proposals over a tick series and reports `deltaR` and violations. Feed it from historical bars (Kite bars after Monday via `buildBarsDataset`, plus the archive's labelled signals as synthetic entries with their stated stop/targets). Output: per-scenario fixed-vs-adaptive R, aggregate delta, and the count of proposals by reason. This is the evidence for whether the rules help, and it needs no live trading of any kind.

**Track B: Live shadow in the paper tick loop (only if you later turn paper ON; separate approval).** In `service.ts`, after `step()` for an OPEN trade, call `proposeManagement(trade, price, ctx)`, log `paper.shadow.management` (action, new stop or fraction, reasons, unknown inputs, `executed:false`), and **never** apply it: the persisted trade is the output of `step()` only. Because paper is OFF this track stays dormant; I recommend building it only when paper is turned on, so there is no dormant code path in the paper loop in the meantime.

**Reduce-only enforcement (management):** `isReduceOnly()` re-checks every proposal (stop strictly tighter, behind the price by the buffer, exit fraction in (0,1], never a size increase, never a widened stop); a failed check is logged as a violation and dropped. Replay counts `violations`, which must be 0.

## 4. Shadow comparison: old versus new behaviour
* **Sizing:** a tally script `scripts/ops/shadow-diff.ts` reads the worker journal (`docker logs`) and aggregates `risk_sizing.shadow.reduce_only` lines: decisions seen, share reduced, mean and minimum multiplier, v1 versus shadow quantity totals, planned-max-loss avoided (quantity difference x per-unit risk), reasons and unknown-input frequencies, and `summarizeReduceOnly`. Same style as the Friday tally.
* **Management:** replay report as above (fixed R versus adaptive R, delta, by-reason).
* **Honest reading:** reduce-only can only lower exposure, so on sizing the comparison is "how much risk would have been avoided and how often", not P&L skill; on management it is the R delta from replay, including the cases where tightening costs R (one such case is already in the tests).

## 5. Test plan
1. **Unit (exists):** reduce-only property tests (size never above v1), management property tests (stop always tighter, behind price), `replayManagement` cases.
2. **Wiring unit tests (new):** `shadowReduceOnly` with fakes: flag off => no call and no log; flag on => exactly one log line; function throws => swallowed and logged, flow continues; timeout => abandoned; violation injected (a fake returning a larger size) => discarded and logged; `LIVE_TRADING=true` or enforcing => refuses to enable.
3. **Equivalence integration test (new, real PostgreSQL):** run the same synthetic signals through the pipeline with the flag off and on; assert every table's row contents (risk decisions, approvals, cards, orders, fills, positions) are identical and the only difference is the extra log lines. This is the proof that shadow has no live impact.
4. **No-write check:** a test that the shadow module imports no write function and no order module (architecture-test style), and that `@twins/paper` shadow code calls only `proposeManagement`.
5. **Replay run on real bars:** after Monday's Kite bars exist: `replayManagement` over the index signals the archive can supply, reviewed with the owner.
6. **Staging canary (after merge):** deploy with the flag still `false`; verify no behaviour change; then set `true` with your go-ahead and confirm log lines appear only when a decision is sized, with 0 errors and identical decision rows.

## 6. Rollout sequence (each step reviewable)
1. Merge this design (docs).
2. PR A: sizing shadow helper + flag + wiring tests + equivalence test + `shadow-diff` tally script. Flag default `false`; deploy dark.
3. After the Kite feed run and once signals flow and a capital figure is set (your decision): flip the flag in staging; observe.
4. PR B: replay harness script + report over Kite bars (no live path).
5. Track B only if/when paper trading is turned on.

## 7. Decisions needed from the owner
1. **Capital figure:** `TWINS_SIZING_AVAILABLE_CAPITAL` is unset on staging, so nothing is ever sized. Do you want a staging capital value set (a number of your choosing) so sizing and the sizing shadow can produce data? This changes sizing output on staging (still planning only, no order).
2. **Dormant Track B:** agree to leave the paper-loop shadow unbuilt until paper is ON?
3. **Policy defaults:** accept the reduce-only defaults (floor 0.25, drawdown 2->6%, volatility 1.5->3x, event within 4 h = 0.5, 0.9 per unusable source, thin evidence 0.75) for the first shadow period, or change any?
4. **Volatility source:** no volatility ratio exists yet; accept `null` (that factor off) until Kite bars give one?

## 8. Risks
* **Log-only evidence is lost with the journal (about 7 days)** until HB-25 makes it durable; the tally script should be run on a schedule, or HB-25 prioritised.
* **No traffic:** with 0 decisions per day the shadow could stay empty; replay (Track A) is the dependable evidence source.
* **Null inputs:** with drawdown, volatility and events mostly unknown at first, the shadow will often equal v1; the log lists unknowns so that is visible, not hidden.
* **Staging canary is not live evidence:** no real orders exist anywhere in this design.
