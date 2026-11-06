# Source health profile and explainable decision card (P0 #2 and #6)

> First P0 work package, built 2026-11-06 from [discovery/P0_DISCOVERY.md](discovery/P0_DISCOVERY.md). **Read-only evidence.** Neither feature changes a decision, a size, an order, a provider, a schema or a safety flag, and neither is read by any risk gate. Not deployed until the owner approves a deploy. No migration.

## Source health profile (#2)
Code: `packages/providers/src/sourceHealth.ts` (pure), `sourceHealthFs.ts` (read-only file observation), route `GET /market/sources`, CLI `scripts/ops/source-health.ts`.

* **Inputs: provider files and the exporter's pass log only.** For each of the seven provider files: present, readable, the document's own `as_of`, the file's modification time, source label and entry count. The pass log (`provider.published|failed|skipped` lines) adds the last pass result and consecutive failures. Nothing is stored; the profile is rebuilt on every read.
* **Statuses**, worst first: `INVALID` (file unreadable or no usable `as_of`), `MISSING`, `FAILING` (two or more consecutive failed passes), `STALE` (data older than its horizon, or the file not rewritten for 150 minutes), `DEGRADED` (one failed pass, or a skipped pass), `OK`. `usable` is true only for OK and DEGRADED.
* **Horizons** (`DEFAULT_HEALTH_POLICY`): 6 hours for news, sentiment, calendar, holidays and constituents (their `as_of` is the export time); 72 hours for macro and market quotes, whose `as_of` is the oldest index timestamp and only advances on a Kite feed run. Macro is therefore expected to show STALE once its data is older than 72 hours, until a feed run; that is correct, not a bug.
* A skipped pass is a configuration state, not a failure. A provider absent from a supplied log is flagged `no_pass_logged`, never assumed healthy.
* **No leakage:** reason codes are fixed words; a log reason that is not a plain code becomes `unrecognized`, so a URL, key or message cannot reach the profile (tested).
* **The API route has no pass log** (the exporter's journal is on the host), so it reports file state only and says `passLogAvailable: false`. The CLI takes the log: `docker logs <exporter> 2>&1 | node --import tsx scripts/ops/source-health.ts --log -`.
* Historical signal-source scorecards are a different thing and are not mixed in.

## Decision card (#6)
Code: `packages/agents/src/decisionCard.ts` (pure), route `GET /risk/decisions/:id/decision-card`.

* **Assembled only from stored records:** the latest stored synthesis for the decision plus the planned-sizing columns of the decision row. It computes nothing new and writes nothing. Shadow runs are log-only (HB-25), so a decision with no stored assessment returns 404 `no_assessment`; the card never invents one. An unreadable stored result returns 422.
* **Content:** assessment and the rule that decided it, score, halt reason; one row per agent (verdict, status, confidence, weight, required, codes); blockers; agents that produced no result (required ones marked); close calls; sizing facts; sources not usable now (when a profile is supplied).
* **Close calls** are plain arithmetic: an evaluated score rule whose value is within 0.15 of its threshold, shown as value, threshold and margin. It is not a prediction of what would happen.
* **No free text:** only codes and numbers pass through (agent finding text, inputs and message text are never copied); sentences are fixed templates. `grantsApproval` is always false and the last sentence of every card says it is not an approval.
* The existing `POST /risk/decisions/:id/approval-card` (the Telegram approval card) is unrelated and unchanged.

## Not in this package
* Feeding source health into the card on the API (needs the exporter log or a stored history; history was ruled out for now, so the card takes the profile as an optional input).
* Any use of source health by sizing or by agents.
* Deploy, which needs the owner's go-ahead.
