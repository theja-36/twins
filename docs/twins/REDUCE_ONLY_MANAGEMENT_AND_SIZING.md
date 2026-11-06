# Reduce-only adaptive management and dynamic sizing (P0 #1 and #3)

> Second P0 work package, built 2026-11-06 per the owner's decisions: **strictly reduce-only** (never a larger size, never a wider stop; only a smaller size, a tighter stop or an earlier exit), **shadow/replay only**, **not wired into anything**. Nothing calls these functions in the worker, API, paper cycle or sizing path; nothing stores their output; no gate reads it. No migration, no deploy needed to keep it inert. Engine off, shadow on, `LIVE_TRADING=false`, paper off are untouched.

## #3 Dynamic sizing (`packages/risk/src/sizing/reduceOnly.ts`)
`reduceOnlySize(inputs, policy)` takes the quantity `sizing-v1` produced and returns an adjusted quantity that cannot exceed it. `sizing-v1` stays authoritative and unchanged.

* **Factors** (each a multiplier in (0, 1], combined by product, then clamped to `[floor, 1]`): drawdown (ramp 2% to 6% of capital, down to 0.5), volatility ratio (ramp 1.5x to 3x baseline, down to 0.5), a high-impact event within 4 hours (0.5), each source the health profile reports unusable (0.9 each, compounding), thin supporting evidence (0.75). Floor 0.25: this is not a halt; stopping new trades is the P1 drawdown circuit breaker (#11).
* **Rounding:** always down to whole lots; a result of zero is reported (`ROUNDED_TO_ZERO`), never rounded up.
* **Unknown inputs change nothing and are listed** (`unknownInputs`). They are not treated as good news (no increase) and not as bad news (no penalty).
* **Policy is validated:** any multiplier outside (0, 1], a non-increasing range or a bad window throws (`ReduceOnlyPolicyError`); a policy that could scale up cannot be constructed.
* `summarizeReduceOnly(results)` is the shadow comparison: how often it would have reduced, the mean multiplier, which factors acted.
* Inputs it expects from elsewhere (not wired): drawdown (definition open, see P1 #11), a volatility ratio, event proximity from the calendar, the unusable-source count from the source-health profile (#2), a thin-evidence flag.

## #1 Adaptive trade management (`packages/paper/src/adaptiveManagement.ts`)
`proposeManagement(trade, price, context, policy)` returns a **proposal** (`executed: false`), never an action.

* **Rules** (all conservative, defaults in `DEFAULT_MANAGEMENT_POLICY`): volatility spike (>= 2x) with the trade at least 0.5R in profit locks 0.5R; a high-impact event within 60 minutes with profit moves the stop to breakeven; square-off within 30 minutes with profit moves the stop to breakeven; after a best excursion of 1.5R, giving back 40% of it locks 0.5R. The safest valid candidate is proposed.
* **A proposed stop** is valid only if strictly tighter than the current stop and at least 0.1% of price behind the current price. Otherwise the candidate is dropped and listed as `..._NOT_APPLICABLE`.
* **Partial exit:** if a high-impact event is within 60 minutes and the trade is not in profit, it proposes exiting half of the remaining position (only when more than one unit remains). That is the only protective move left; it is recorded but not simulated in this slice.
* **Nothing is assumed:** unknown context never produces a proposal; a pending, closed or priceless trade gets `HOLD`.
* `isReduceOnly()` re-checks any proposal (tighter stop behind the price, real exit fraction, or an empty hold).
* `replayManagement(trade, ticks, config, policy)` replays a recorded tick series twice with the same pure paper manager: fixed rules, and fixed rules plus each stop-tightening proposal applied. It returns both outcomes, `deltaR` (adaptive minus fixed), the proposals made and a `violations` count (always 0; counted so a regression shows). The tests include a case where the tighter stop costs R when the market dips and recovers: the comparison is meant to show that honestly, not to flatter the idea.

## How the shadow comparison becomes evidence
1. Replay over recorded or synthetic tick series now (tests).
2. Replay over the imported historical outcomes, when we agree how to build ticks from them.
3. Paper shadow (needs paper trading, a separate owner decision): log fixed versus adaptive side by side.
4. Any use in a decision or in the paper cycle is a separate owner approval with its own gate. Durable storage of shadow output depends on HB-25.

## Not in this package
Wiring, storage, any API route, drawdown/volatility feeds, partial-exit simulation, and any use of these results by agents or gates.
