# Historical leakage validation report (Stage 03 closure)

Principle: a historical evaluation as of T may use only information that was available at T: messages sent by T, revisions made by T, bars closed and retrieved by T, outcomes resolved by T, research and playbook versions that existed at T. Everything below is proven on SYNTHETIC fixtures only; nothing is proven on a real archive (protocol at the end).

| Path | Time boundary now | Defect found | Fix and evidence |
|---|---|---|---|
| Similarity matcher (`similarity/`) | message time, resolution time, revision group | future cases, own-message revisions, outcomes unknown at decision time | fixed earlier; `temporalIntegrity.test.ts` (16), as-of integration test |
| Source scorecards / trust tiers | outcome resolution time, revision `editedAt` | counted outcomes resolved after as-of and later revisions (G-39) | `source-scorecard-v2` default; a touch is known when its bar CLOSES; unit `scorecardPointInTime.test.ts`; CI run 42686591238 (window assertions 50/30/50 -> 46/26/46; as-of 6/46/60) |
| Pattern training (`patterns/`) | embargo AND outcome resolution time | embargo (30 d) shorter than label horizon (up to 365 d): outcomes resolving after as-of were training evidence (G-40) | `selectTraining` + `asKnownAt`, `pattern-metrics-v2`; REPRODUCTION test failed before the fix (4 of 6 failed), passes after: `patternTrainingTemporal.test.ts` (7) |
| Confidence (single / batch) | pattern run as-of <= signal time; batch rejects in-sample runs | none (batch throws `pattern_not_point_in_time`) | existing integration tests `patterns.test.ts` |
| Live calibration, drift (`outcomes/`) | `confidenceAt <= openedAt`; chronological holdout by `closedAt` | none; note: fit and holdout position lifetimes can overlap (no embargo) | `tests/unit/outcomes/integrity.test.ts` |
| Attribution inputs | regime `as_of <= decision created_at`; package by stored id | regime bound not pinned by a test | open: add a test when the learning cycle is next touched |
| Research package in analytics and decisions | decision-time package (G-41) | decision cycle and agent analytics read "latest" | fixed; `stage08.test.ts` (CI) and `G41_VERSION_CONSUMER_MAP.md` |
| Price bars | bar close + retrieval time (`barsKnownAt`) | the outcome evaluator uses bar start times and does not read retrieval time; datasets do not record retrieval time | helper + tests added; wiring into the evaluator waits for a real provider (G-30/G-32) |
| Telegram revisions and candidacy | revision state, claim message time | none known | `SUPERSEDED_REVISION`, adversarial and stage03 integration tests |
| Caches and run keys | run key hashes as-of, algorithm version, config, input hash | none | scorecard and pattern runs are idempotent per key |

## Legacy runs
Stored `source-scorecard-v1` and `pattern-metrics-v1` runs are NOT point in time. They stay in the append-only tables, distinguishable by `algorithm_version`. Tier lookups now return `algorithmVersion` and `pointInTime` (false for v1, with reason `SCORECARD_LEGACY_NOT_POINT_IN_TIME`), and the as-of trust record carries `pointInTime` too, so a legacy tier is never presented as point-in-time. A rebuild under v2 creates new runs (the algorithm version is part of the run key); old runs are never edited.

## Known limitations
Archive import time is ignored (a case is assumed available at message time plus resolution time). Resolution times come from the evaluator's bar stamps; a label without them is treated as unknown and unused. The scorecard "all time" window now excludes very recent outcomes by design.

## Real-archive validation protocol (needs an approved archive)
1. For each of the paths above, run the build at several as-of dates T1 < T2 < T3 over the real archive.
2. Property A (monotone knowledge): a result at T1 must not change when later data is added; rebuild T1 after importing data dated after T1 and require identical run keys and metrics.
3. Property B (no future outcome): for every counted outcome, resolution time <= as-of; report violations (must be 0).
4. Property C (revisions): for every counted revision, `editedAt <= as-of`.
5. Property D (bars): every bar used has close and retrieval time <= decision time.
6. Property E (cross-version): v1 and v2 results are compared and the difference reported, to size the legacy contamination.
7. A reviewer signs the report; failures keep the requirement open.
