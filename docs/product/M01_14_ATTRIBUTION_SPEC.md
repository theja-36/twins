# M01-14: channel reliability, attribution chain and archive-to-live mapping

**Status:** the live chain exists for paper trading and is FIXTURE-priced; the archive side is keyed by the archive's own label; the two are NOT linked; channel reliability is NOT_AVAILABLE by design. M01-14 stays NOT STARTED/OPEN.

## The chain and its existing evidence
original message -> claim / revision (`telegram_claims`, `SUPERSEDED_REVISION`) -> candidate (`telegram_claim_candidacy`, G-19) -> research package (by id, G-41) -> decision (`user_decisions`, immutable package id) -> paper position and outcome (`outcome_attributions`, FINAL only when resolved, versioned corrections) -> channel attribution (NOT BUILT: needs the candidate's origin source id carried through to attribution; the candidate carries `origin` provenance, and attribution already records `candidateSource`).
Rules already enforced: revisions are superseded, not double counted; duplicates are one candidate; contradictory claims are refused (`CONTRADICTORY`) and stay distinguishable by reason; missing entry/stop/target stays INCOMPLETE and is never invented; attribution is FINAL only after the recorded outcome; the shared funnel reports fixture data as `NOT_VALIDATED_FIXTURE`; the live API reports `reliability: NOT_AVAILABLE`.
Rules to add when real outcomes exist: a channel metric uses only FINAL, REAL-priced attributions whose resolution time is at or before the report's as-of instant (G-39 principle); the denominator and sample size are always shown with a Wilson interval; fewer than 30 resolved outcomes is labelled insufficient (the playbook activation floor); fixture outcomes are excluded and counted separately; a revised claim counts once, under its final revision, unless the owner decides otherwise.

## Archive-to-live mapping procedure (owner approves; no identity is inferred)
1. The owner provides a table: archive `channelLabel` -> live channel (by the masked identifier shown in the app) with a short justification.
2. Evidence, automated and reviewed: for a window both sources cover, at least N (proposed 20) messages must match by original message id or by (timestamp within 60 s, text hash) between the archive and the live capture; the report lists matches, mismatches and unmatched counts. Text is compared by hash only.
3. The owner signs off per channel. The mapping is stored as an append-only, versioned record (who, when, evidence report hash); an alias link is never merged silently (existing alias rule).
4. Only mapped channels may combine archive and live history; an unmapped channel stays separate.
**Approver:** the product owner. **Evidence required:** the match report in step 2. **Blocked on:** an approved archive import and real live capture (Stage 10).

## Acceptance criteria
Mapping records exist for each channel with its evidence; attribution carries the source channel; reliability is computed point-in-time on at least 30 resolved, real-priced, out-of-sample outcomes per channel with intervals and caveats; fixtures never counted; CI green.
