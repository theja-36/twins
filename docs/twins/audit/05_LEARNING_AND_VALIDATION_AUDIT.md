# 05 Learning and validation audit

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

## State
No outcome engine, labels, scorecards, hypothesis registry, validation protocol, strategy states, calibration or drift monitoring exists (CR-02, CR-04, CR-05, SV-01..05, OL-02..05, RE-05). Tables `backtests`/`backtest_results` exist and are unused.

## What can be reused
- As-of discipline: `selectMarketContext` with `asOf`/`receivedBy` bounds and synthetic exclusion (`packages/signals/src/context/market.ts`), covered by integration tests (CR-06 partial).
- Evidence links (`signal_evidence`) with unique indexes.
- The T6 design (proposal) for `signal_outcomes` with `unresolved`, point-in-time rules and the research-only barrier for historical imports (`docs/implementation/phase1/T6_SIGNAL_LIBRARY_DESIGN.md`).

## Risks recorded for the future work (design-level)
1. Hindsight via edited messages in history imports (first_seen_edited flag helps; pre-edit text is unrecoverable).
2. Survivorship: deleted messages invisible before capture.
3. Same-bar stop/target ambiguity with daily bars; option premium history unavailable.
4. Multiple-testing on small samples: only 45 messages exist; the number of *outcome-labelled* cases is currently zero.
5. Presenting uncalibrated scores as probabilities; claiming agent independence from prompt changes (both prohibited by the baseline).

## Verdict
The learning chain is entirely unbuilt. It cannot be started before P04 (data) and P05 (conventions + outcomes); nothing about historical learning blocks building the deterministic safety and paper pipeline (P06, P09A, P10).
