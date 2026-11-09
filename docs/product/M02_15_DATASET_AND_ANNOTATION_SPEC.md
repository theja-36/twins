# M02-15: real-message classifier validation program

**Status:** harness IMPLEMENTED and TESTED on synthetic data (`packages/signals/src/evaluation/classifierEval.ts`, 12 unit tests). No dataset exists; real-world accuracy is NOT VERIFIED and NOT CLAIMED. Fixture and adversarial tests (`tests/unit/telegramCandidates/adversarial.test.ts`) remain correctness tests only.

## 1. Dataset (lives OUTSIDE Git; one JSONL file per `datasetVersion`)
Row fields (`DatasetRow`): `datasetVersion`, `rowId` (pseudonymous), `channelRef` (masked), `messageTimestamp` (ISO 8601 with offset; a bare local time is refused), `revisionOf` (original row id for an edit), `dupGroup` (near-duplicate or forwarded group), `split` (train, validation, test), `label` (claim, ambiguous, noise), `annotators[]` (at least 2), `annotatorLabels[]`, `adjudicated`, and for claims `fields` (underlying, strike, optionType, expiry, entryKind, entryLow, entryHigh, stopLoss, targets, levelBasis; JSON null = "unstated", an explicit label). The message text is held in a separate access-controlled store keyed by `rowId` and is never committed, logged or put in CI.

## 2. Label taxonomy and annotation guide
- **claim:** states an option trade idea with at least an underlying and a direction/contract. **ambiguous:** looks like a trade idea but a reviewer cannot determine the contract or direction (kept; it tests refusal). **noise:** greetings, results, charts, promotions.
- **Fields:** label only what the text states. If the entry, stop, target, strike or expiry is not written, label it null; never infer, never use market knowledge. "Near X" is labelled as the text says (it is not a stated entry; see G-37).
- **Edits:** an edited message is its own row with `revisionOf`; the superseded original stays labelled. A forward of an earlier message shares its `dupGroup`.
- **Uncertain:** a reviewer who cannot decide marks ambiguous and writes a short reason in the (external) annotation notes.
- **Process:** two reviewers label independently without seeing the classifier output; disagreements go to a third adjudicator; Cohen's kappa is reported per class and per field; labels are frozen and hashed per `datasetVersion`.

## 3. Splits and leakage
Chronological: train < validation < test by message time, with duplicate groups wholly inside one split (`leakageProblems`). Rules, thresholds and parser changes are tuned only on train/validation; the test split is evaluated once per parser/classifier version. A pilot of about 300 messages sizes the labelling effort and checks the guide; it is not treated as sufficient to establish accuracy.

## 4. Metrics and report
Per class: confusion matrix, precision, recall, F1, false-positive and false-negative review lists (by `rowId`). Per field: correct, wrong value, missed, abstained correctly and INVENTED counts with Wilson intervals; the invented-value rate must be 0 and every labelled contradiction must be refused. Accuracy is published only with at least 200 labelled claims (`reportable`); below that the report says INSUFFICIENT_SAMPLE. Confidence scores are not calibrated by this program (limitation stated in the report). The report is reproducible: dataset hash, parser/classifier versions, config and code commit are in its header.

## 5. Secure storage and retention
Encrypted store outside the repository, access limited to named annotators and the engineer running the evaluation; no text in logs, CI artifacts, issue trackers or prompts to hosted AI; retention fixed by the owner (recommended: delete texts at the end of the validation unless re-approved; keep labels and hashes); import only from channels the owner is entitled to read, by a method the owner approves; no scraping.

## 6. Acceptance criteria
A named dataset version of at least 200 labelled claims, validated with no `DatasetProblem` and no `LeakageProblem`; kappa reported; the report above exists, reviewed by a human; invented-value rate 0; labelled contradictions all refused. Then M02-15 may be marked VERIFIED for that parser version only.

## 7. Approval needed
See `STAGE_03_DECISION_PACKAGE.md` item A.
