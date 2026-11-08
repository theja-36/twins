# G-37 decision brief: unstated and "near" entries

**Today (safe, unchanged).** The candidate pipeline has exactly five entry kinds: `above`, `below`, `at`, `range`, `market`. A claim with no stated entry, or a vague "near" level, is recorded `INCOMPLETE` (reasons `entry_missing` or `level_basis_unclear`). It is never defaulted to `market`, and the missing information stays listed on the candidate.

**Consumers.** `packages/signals/src/telegramCandidate.ts` (policy), `packages/agents/.../candidateInput.ts` (five kinds), `packages/historical/src/strategy/profile.ts` (still tolerates near/unspecified for profiling only), the opportunity store and its schema CHECKs, and the frontend claim/candidate views. Tests: `tests/unit/telegramCandidates` (policy, adversarial).

**Options**
1. Keep as is (recommended until real data shows how often it matters): "near X" stays INCOMPLETE; a human can re-submit with a stated entry.
2. Treat "near X" as a bounded range X +/- a configured tolerance: needs a tolerance per instrument class, a new policy version, stop-validation review, and tests that it never widens a stop-loss breach.
3. Add a sixth entry kind `near`: schema CHECK, agent input, risk and stop-validation changes across Stages 03-07.

**Decision needed from the product owner:** choose 1, 2 or 3, and for 2 the tolerance. Until then G-37 stays open and nothing changes.
