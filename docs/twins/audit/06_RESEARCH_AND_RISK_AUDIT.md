# 06 Research engine and risk audit

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

## Research engine (packages/decision-intelligence, packages/signals)
- Deterministic: structural validation, source reliability, bull/bear/counter-thesis, evidence disposition, immutable persistence. Fail-closed (REJECT / INSUFFICIENT_EVIDENCE).
- Outcome vocabulary: `APPROVE | REJECT | INSUFFICIENT_EVIDENCE` (`types.ts:11`). `APPROVE` means "evidence sufficient for analysis" and collides with human approval (F-003). WAIT and QUALIFIED do not exist.
- Confidence is count-based and documented as not a probability; no calibration exists.
- Challenge is deterministic counter-thesis (not an independent agent).
- Inputs are thin: 0 signals/validations/market rows on staging; options claims bypass the stack (F-014).

## Risk and sizing
`packages/risk` is a placeholder. No capital snapshot, sizing, reservation, limits, correlation, stressed-loss, pre-flight or emergency-control code exists; the supporting tables are unused. Every SZ requirement and EX-08 is MISSING and Critical because any later phase that proposes or executes depends on them.

## Required properties to preserve when building (from the baseline)
Planned stop-based risk is not guaranteed maximum loss (separate fields); LLM text cannot override deterministic limits (static import rule); concurrency-safe reservations; zero lots means no proposal.
