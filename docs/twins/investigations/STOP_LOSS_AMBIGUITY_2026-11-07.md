# Investigation: why 66 of 70 live decisions had a stop-loss problem (read-only, sanitized)

Counts and causes only; no message text or excerpts are included (the repositories are public). Method: read-only queries on staging (counts, codes, parsed fields). Data: 126 captured options claims (2026-10-21 to 2026-11-06) and 70 risk decisions. Findings describe THIS capture; other channels may differ.

## Result
The "stop-loss ambiguity" was mostly not a stop-loss extraction bug. It was three different things.

| # | Cause | Size | Verdict |
|---|---|---|---|
| 1 | Reports of past results (performance adverts) were parsed as options claims: they name a contract, but have no action, entry, stop or targets | 57 of 119 parsed claims (48%); 39 of 70 decisions ended `UNSUPPORTED_TRADE_SIDE` | Classification gap |
| 2 | Real signals state the stop without saying what it is quoted in (option premium or underlying); the mandatory-stop rule correctly refuses to guess | 29 decisions `STOP_LOSS_BASIS_UNSPECIFIED` (47 buy claims) | Working as designed; the channel's convention is implicit |
| 3 | Missing or invalid stops | 4 missing, 3 invalid | Genuine data problems |

Concentration: one source produced 109 of the 126 claims (44 buy claims with a stop but no stated basis, 64 with no action); a second source states "premium" explicitly (10 claims).

Evidence for the premium convention: in all 58 buy claims that carry a stop, the stop is below 10% of the strike (three-digit stops against five-digit strikes). That is an inference, not something the messages state.

## Other findings
* Expiry: 22 of 62 buy claims carry no expiry at all, and the year is often missing; contract lookup needs the instrument catalog.
* Approval was impossible regardless: every claim lacked a contract master and premium data (both arrive with the Kite catalog and quotes).
* 7 claims use an unsupported form for an index outside the supported set.
* 126 claims came from 126 distinct messages (no duplicates).

## Fixes (owner decisions 2026-11-07; built in the same PR as this note)
1. Parser v3 classifies a report of past results as "no signal" (rule and guards in `PARSER_V3_RESULT_REPORTS_AND_SOURCE_BASIS.md`).
2. Per-source default basis = premium, only for an owner-configured source, only when the message is silent and the stop is below 10% of the strike; recorded on the claim.
3. The capture exporter skips result reports by default.
4. Not done: expiry resolution from the Kite catalog (after Monday); the unsupported index form.

## Effect on the reduce-only sizing shadow
It observes only SIZED decisions. Sizing also needs a source trust tier (scorecards from evaluated history) and a resolvable contract, so it stays idle until those exist.
