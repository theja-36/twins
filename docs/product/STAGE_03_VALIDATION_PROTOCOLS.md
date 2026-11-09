# Stage 03 validation protocols (what real data must be supplied, and how it will be judged)

Nothing here has been run on real data. Synthetic and fixture tests prove behaviour (rules, refusals, idempotency), not accuracy or channel quality.

## M02-15: classifier and parser accuracy on real channel messages
**Today:** unit tests with hand-written messages (`tests/unit/telegramCandidates/adversarial.test.ts`, parser and classifier suites) and fixture archives. These are correctness tests, not an accuracy measurement.
**Dataset (needs explicit approval before any real message is read):** a versioned file of real channel messages, one row per message: `datasetVersion`, `messageId` (pseudonymous), `channelRef` (masked), `timestamp` (IST, tz-aware), `text` (kept outside the repository), edit/revision linkage, and the human labels: `isTradeClaim` (claim / ambiguous / noise), and for claims `underlying`, `strike`, `optionType`, `expiry` (or "unstated"), `entryKind` (the five kinds or "unstated"), `entryLow/High`, `stopLoss`, `targets[]`, `levelBasis`.
**Labelling:** at least two independent human reviewers; disagreements adjudicated by a third; inter-annotator agreement (Cohen's kappa) reported; labels frozen and hashed per `datasetVersion`.
**Splits and leakage:** chronological: the evaluation set is strictly later than anything used to tune rules or thresholds; near-duplicate and forwarded messages grouped so they cannot straddle the split; the evaluation set is touched once per rule version.
**Metrics:** per field and per outcome class: precision, recall, F1 and a confusion matrix; separately the rate of WRONG VALUES (a wrong number is worse than an abstention) and the rate of invented values (must be 0). Report counts with Wilson intervals; no figure from fewer than 200 labelled claims is published as accuracy.
**Acceptance to close M02-15:** the above report exists for a named dataset version and parser version, reviewed by a human, with the invented-value rate 0 and every contradiction in the labelled set refused.

## M01-14: channel reliability and outcome validation
**Distinguish:** (1) recorded claims: exist; (2) resolved outcomes: need real prices (G-30); (3) attributed outcomes: need claim -> candidate -> decision -> position -> outcome linkage in the live path (Stages 04-08 produce this only on paper positions priced from FIXTURE data today); (4) verified channel performance: needs (3) over a real-price window with enough resolved cases.
**Today:** claim counts and pipeline funnel only (`/intelligence/channels/:id/performance`); `outcomes` and `reliability` are always NOT_AVAILABLE; imported-history score tables are keyed by the archive's own label and are not linked to live channels.
**Required data:** a real or historical price source for the instruments claimed (G-30/G-32, Stage 10); resolved outcomes with resolution timestamps (see G-39); a mapping from archive labels to live channels approved by the owner.
**Acceptance to close:** per channel, at least 30 resolved out-of-sample outcomes on real prices (the existing playbook activation floor), computed point-in-time (G-39 closed), with intervals, drift checks and the limitations shown; fixtures never counted.
