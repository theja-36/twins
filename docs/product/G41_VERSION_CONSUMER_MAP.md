# G-41: research-package version, producers and consumers

**Status:** consumer trace DONE. Two code defects found and FIXED (tests written; integration tests run only in CI). G-41 closes when CI is green for the introducing commit.

## Storage
`research_packages` (migration 0033): append-only, unique (candidate_id, version), `version` is a per-candidate counter; `agent_results.packageVersion` ("research-package-v1") is a separate schema tag. `user_decisions.research_package_id` (migration 0038, FK, NOT NULL for a QUALIFIED decision, immutable) and `risk_assessments.research_package_id` (0037) record the exact package used by id. The version number is recoverable by joining on the id.

## Producers
One production writer: `storeResearchPackage` (advisory-locked, version = max + 1), called through the opportunity cycle. Pure builders in `packages/agents/src/research/package.ts`. Tests write packages directly.

## Consumers
| Consumer | Reads | Needs | Result |
|---|---|---|---|
| planning `evaluate.ts` | latest package at evaluation time; stores its id on the risk assessment | the package at evaluation time | correct |
| `hasRecentRiskAssessment` | compares package ids | a new version forces re-evaluation | correct |
| **decision cycle** | **was: latest package, separately from the evaluation bundle** | the package the risk assessment and confidence used | **DEFECT, FIXED** |
| attribution (`outcomeStore.ts:55`) | package by the decision's stored id | decision-time package | correct |
| funnel counts | count of candidates researched | version-agnostic | correct |
| **`researchReportsForDecisions`** (agent analytics, insights) | **was: latest package per candidate** | the package each decision used | **DEFECT, FIXED** |
| frontend `packageVersion` | fixtures only (no route) | undefined until `GET /research/cases` exists | define then |

## Fixes
1. **Decision cycle:** the decision now loads the package named by the evaluation bundle (`getResearchPackageById(bundle.researchPackageId)`), so a decision never records a package its risk, confidence and sizing did not use. A newer version makes planning re-evaluate (its dedupe compares package ids) and the next cycle decides on that new evaluation. No persisted record changes.
2. **Agent analytics:** `researchReportsForDecisions` now returns, per candidate, the package of the user's most recent decision (immutable `user_decisions.research_package_id`). A decision with no recorded package contributes none; a package stored after the decision is never read. Evidence: `tests/integration/outcomes/stage08.test.ts` "research packages are read as of the decision (G-41)" (two tests, CI only).

## Compatibility policy
Package versions are never rewritten or renumbered; readers that need decision-time state read by stored id, never "latest"; "latest" is only correct for a decision being made now from the current evaluation. `research-package-v1` stays the schema tag; a schema change needs a new tag and readers that accept both. Remaining note: decisions store the package id, not the version number (display needs a join).
