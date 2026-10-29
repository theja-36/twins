# Source intelligence in the live risk flow (Stage 4 / Task 5)

> Decision [D-065](DECISION_LOG.md); requirement [SZ-14](REQUIREMENTS_TRACEABILITY.md) (new). Builds on [SOURCE_SCORECARDS.md](SOURCE_SCORECARDS.md), [PATTERN_LIBRARY_AND_CONFIDENCE.md](PATTERN_LIBRARY_AND_CONFIDENCE.md), [RISK_DECISIONS.md](RISK_DECISIONS.md), [POSITION_SIZING.md](POSITION_SIZING.md) and [RISK_APPROVAL_WORKFLOW.md](RISK_APPROVAL_WORKFLOW.md). Code: `packages/historical/src/intelligence/` (service), `packages/risk/src/intelligence/record.ts` (recorder), sizing (`sizing/engine.ts`, `sizing/record.ts`), `approval/eligibility.ts`, `apps/api/src/intelligenceApi.ts`, `scripts/ops/source-intelligence.ts`, migration `0024_risk_source_intelligence`.

Historical source trust and calibrated confidence now feed the live risk-decision flow - **without letting unverified historical data create trade eligibility by itself**. Intelligence can only *restrict* (it picks the sizing tier and can block); it never raises the per-trade cap or relaxes any limit, and every earlier gate still runs. Nothing here places an order, calls a broker, creates executable trade state or enables live trading (no order, fill, position or approval card is written by this code; tested).

## Flow

```
live signal parsed + stop-loss validated
  -> v1  PENDING   (service:risk-decision)            existing
  -> v2  PENDING   (service:source-intelligence)      NEW: point-in-time intelligence recorded, valid or UNAVAILABLE with a reason code
  -> v3  SIZED / REJECTED (service:position-sizing)   reads the resolved confidence + trust tiers; invalid intelligence => no size
  -> portfolio limits -> market gates -> APPROVED_FOR_REVIEW        existing, unchanged
  -> approval eligibility: ALSO requires valid intelligence         NEW (TypeScript and inside the database)
```
Each step is an append-only, hash-chained risk-decision **version** (never an UPDATE); the recorded intelligence is carried forward in `output_snapshot.intelligence` through every later version. The worker runs the step between the PENDING decision and sizing, and sizes with `requireIntelligence: true`.

## Service contract (read-only; `packages/historical/src/intelligence`)

* `getSourceTrustAsOf(db, label, asOf)` / `getSourceIntelligenceSummary(db, label, asOf)` - source identity (registered?, canonical + alias members), latest trust tier **with scorecard as-of <= `asOf`**, scorecard run reference, algorithm version, configuration hash, evaluable count, data sufficiency (`SUFFICIENT` / `INSUFFICIENT` / `UNAVAILABLE`), and whether a pattern library exists.
* `getSignalIntelligence(db, { sourceLabel, signal, marketContext, asOf?, config? })` - everything above plus the deterministic confidence from the latest **pattern run with as-of <= `asOf`** (default: the signal's own timestamp): score, tier, evidence quality, sample size, matching pattern references, algorithm / feature versions, ordered explanation, limitations, a validity verdict and an input hash.
* **Never throws for missing intelligence**: an unregistered source, no scorecard, only a later scorecard, no pattern library, no matching pattern or an insufficient sample each give an explicit `UNAVAILABLE` result with a reason. **Database errors do propagate** - the caller fails closed.
* **Point in time:** a scorecard or pattern run that post-dates the signal is never used (`NO_SCORECARD_AT_SIGNAL_TIME`, `NO_LIBRARY`). The result echoes the instant it was resolved for.
* **Safe output:** identifiers, tiers, numbers, fixed codes. No message text, no decision input snapshot, no credentials.

Verdict: `VALID` only when trust is A / B / C **and** the confidence tier is HIGH / MEDIUM / LOW. Otherwise `UNAVAILABLE` with one reason, in priority order: `SOURCE_INTELLIGENCE_UNAVAILABLE` (unregistered / no scorecard at the signal time / no pattern library), `UNTRUSTED_SOURCE` (D), `UNKNOWN_SOURCE_TRUST`, `INSUFFICIENT_EVIDENCE` (sample too small), `UNKNOWN_CONFIDENCE` (no matching pattern).

## Source identity

The live source is the signal's Telegram channel identifier (`telegram_sources.channel_identifier`, e.g. `tg_chat_-100...`). It is resolved through the scorecard registry (Task 3): for intelligence to exist, the **archive's channel label must equal that identifier**, or the archive label must be explicitly **alias-linked** to the canonical identity. There is no fuzzy matching and no auto-merge; an identifier that matches nothing is `SOURCE_NOT_REGISTERED` => UNAVAILABLE.

## What is recorded on the risk decision

`output_snapshot.intelligence` (and the evidence references `scorecardRunId`, `patternRunId`, `intelligenceInputHash`): status, reason code, source identity, trust (tier, scorecard run, as-of, versions, data sufficiency), confidence (score, tier, evidence quality, sample size, primary pattern key, pattern run, **matching pattern references**), data sufficiency, explanation, limitations, the as-of instant, `sizingTrustTier` and the input hash. The version's `confidence_score` / `source_trust_tier` columns carry the score and the sizing-vocabulary trust tier. A valid record has reason `source_intelligence_recorded`; an invalid one keeps the decision **PENDING** with `source_intelligence_unavailable` / `untrusted_source` / `unknown_source_trust` / `insufficient_evidence` / `unknown_confidence`.

## Sizing integration

The sizing recorder reads the recorded intelligence and passes the **resolved confidence tier** and **trust tier** to the unchanged sizing engine (new optional input `confidenceTier`; without it the engine bands the score exactly as before). Trust mapping: A -> HIGH, B -> MODERATE, C -> LOW, D -> UNTRUSTED, UNKNOWN -> UNKNOWN. The existing **lower-of** rule applies, so B caps at MEDIUM and C at LOW. **UNKNOWN confidence, UNKNOWN trust or D = no size** (`REJECTED`; the decision keeps the explicit intelligence reason code). The per-trade cap (1% of capital, 5% ceiling), the tier shares and every portfolio limit are untouched. With `requireIntelligence` (the worker) a decision that carries **no** recorded intelligence is rejected (`source_intelligence_missing`) - it is never sized from the legacy self-reported confidence. Callers that do not set it (legacy tests / tools) keep the old behaviour for decisions without intelligence, but such a decision still cannot be approved (below).

## Approval eligibility

`assessApprovalEligibility` adds the reason `source_intelligence_not_valid` unless the decision carries intelligence with status `VALID`, trust A / B / C and a known confidence tier. The **database approval function** (`twins_record_risk_approval`, SECURITY DEFINER; replaced by migration 0024) re-checks the same three conditions at the instant an approval is recorded and returns `refused:source_intelligence_not_valid`. All earlier conditions are unchanged: current version, validity window, latest stop-loss VALID, sizing SIZED, portfolio passed, market passed, no open circuit breaker, kill switch off, readable runtime state.

## Failure behaviour

* Intelligence unavailable / UNKNOWN / D => the decision stays PENDING (then sizing REJECTS with the reason); it never reaches `APPROVED_FOR_REVIEW` through the pipeline and is never approval-eligible. Never defaults to HIGH; never guesses a tier.
* Kill switch, disabled intake or unreadable runtime state => `safety_refused` before any read or write. A database error while resolving propagates: the worker job fails and is retried (the decision is untouched).
* Retries are idempotent (same inputs => the existing version; a retry after sizing is a no-op); concurrent workers record exactly one version.

## API (internal, bearer-protected, read-only)

`GET /intelligence/source?label=<channel>&asOf=<ISO>` (source summary) · `POST /intelligence/estimate` (confidence for a normalized signal; body = source label + parsed fields, no message text; evaluated as of the signal's own timestamp) · `GET /risk/decisions/:id/intelligence` (the snapshot recorded on a decision version). No unauthenticated route; invalid input is a 400 before the database; errors are fixed codes. Nothing is written.

## Commands

```
npm run intelligence -- resolve --signal <live-signal-uuid> [--json]    resolve (not record) point-in-time intelligence
npm run intelligence -- show    --decision <risk-decision-uuid> [--json] the snapshot recorded on a decision version
npm run intelligence -- list    [--json]                                 sources with latest tier and confidence availability
npm run intelligence -- export  --format json|csv [--out file]           safe report (identifiers, tiers, numbers)
```
Read-only; output never contains message text. Exit codes: 0 ok, 1 failure, 2 usage, 3 refused.

## Limits and remaining risks

* **Nothing will be sized until intelligence exists:** without scorecards and a pattern library for the live channel identifiers, every live signal is UNAVAILABLE and rejected at sizing (the specified fail-closed behaviour). The archive must be imported under the live channel identifier (or alias-linked) and scored first.
* Live signals carry one entry price, so the entry type feature is `level`; historical `breakout` / `pullback` patterns are not matched at the levels in use (levels 1-4 do not include entry type). Market context is treated as unavailable (0.9 factor), as in Task 4.
* Point-in-time uses scorecard / pattern **as-of** dates; outcomes that resolved after a scorecard's as-of are excluded only by the 30-day training embargo (Task 4), not tracked individually.
* A signal processed late is still evaluated as of its own timestamp, so scorecards built after it arrived are not used for it.
* Intelligence is not refreshed on an existing decision (a new scorecard does not re-open old decisions); decisions expire on their own validity windows.
* Thresholds, caps and the trust-tier mapping (C -> LOW sizing) are defaults awaiting owner review on real data.
