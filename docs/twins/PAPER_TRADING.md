# Paper trading (simulation only)

> Built 2026-11-06 at the owner's instruction (the "No Stage 6" constraint was lifted for **paper-only** work, 2026-11-05). **Simulation only.** No broker call, no order endpoint, no `orders` / `fills` / `positions` row, no change to `LIVE_TRADING` (false), `TWINS_AGENT_ENGINE_ENABLED` (unset) or the approval bot (inactive). Off by default.

## What it does
`packages/paper` turns a **human-approved** risk decision into a *simulated* trade and manages it:

| Step | Rule |
|---|---|
| Intake | A `risk_approvals` row with `action = APPROVE` (not lapsed), whose decision is still `APPROVED_FOR_REVIEW` (not superseded), with side, entry, stop, a whole-number quantity and 1-3 coherent targets, and no paper trade yet, becomes a `PENDING_ENTRY` paper trade. Anything incomplete or incoherent is counted as `invalid` and skipped. |
| Entry | Simulated limit at the planned entry: fills when the price is at or better than it, **never worse than the limit** (slippage is adverse but capped at the limit). Cancelled after `TWINS_PAPER_ENTRY_EXPIRY_MIN` (also with no price) or if the stop level is breached first. |
| Stop loss | Checked **before** targets on every price. A gap through the stop fills at the gap price, not the stop. |
| Targets | Partial exits at target 1/2/3 (default 50/25/25 of the original quantity; the last target takes the rest). A gap over several targets books each in order at its own price. |
| Break-even | After target 1 the stop moves to the fill price (default on). |
| Trailing | `none`, `percent:<x>` or `points:<x>` behind the best price; starts after N targets (default 1); **tighten-only**. |
| Square-off | At `TWINS_PAPER_SQUAREOFF_IST` (default 15:20) open trades are closed at the last price and pending ones cancelled. An open trade with no price at all stays open: nothing is guessed. |
| P&L | Realised + unrealised, and **R multiples** of the initial risk. |
| Learning loop | Every closed trade yields one immutable `paper_outcomes` row (WIN / LOSS / BREAKEVEN, R, MFE/MAE, holding time, close reason, source trust tier, confidence, research assessment). `computeStats` gives win rate, expectancy, profit factor, max drawdown (R) and breakdowns. **It only measures; it changes no weight, threshold or agent.** Below 30 outcomes the API says the sample is not meaningful. |

Prices come from the local `last-price` snapshot (index / cash-segment prices only, read-only mount). A price older than `TWINS_PAPER_MAX_PRICE_AGE_SEC` (120 s) is ignored. Option contracts have no price in that snapshot yet, so option paper trades stay unmonitored (pending trades still expire).

## Safety properties (all tested)
* **Two keys.** `TWINS_PAPER_TRADING_ENABLED=true` (host arming) AND the audited database switch (`paper_switch`, seeded OFF by migration 0031; changed only through the `twins_paper_set_switch` function, whose every change is an append-only event; the admin API route `POST /admin/paper/switch` is its only caller and exists only when a separate admin token is configured). Either one off: the cycle writes nothing. See `docs/api/README.md`.
* Refuses to run if the shared live-trading guard fails, `TRADING_MODE` is not `paper`, or the kill switch is set / state unreadable.
* Writes only `paper_trades` (mutable until finished), `paper_trade_events` and `paper_outcomes` (append-only triggers). A finished trade cannot be changed or deleted (trigger). `orders` / `fills` / `positions` stay read-only for the runtime roles (migration 0029) and are never touched.
* The package imports no Kite client, network library or order/fill/position table (static test). The Kite request allow-list is unchanged: there is still no order, GTT or portfolio-write path.
* The API (`/paper/*`) is bearer-protected and **read-only**; there is no route to create, change or cancel anything.
* **Order gateway:** the paper simulator is the *only* execution implementation. A real broker gateway does not exist and would need its own reviewed task, role, migration and owner approval (and the F1 external review recommended in D-097).

## Settings (all optional; host `staging.env` / compose)
`TWINS_PAPER_TRADING_ENABLED` (false), `TWINS_PAPER_SLIPPAGE_BPS` (5), `TWINS_PAPER_ENTRY_EXPIRY_MIN` (30), `TWINS_PAPER_TRAIL` (percent:0.5), `TWINS_PAPER_TRAIL_AFTER` (1), `TWINS_PAPER_BREAKEVEN` (true), `TWINS_PAPER_EXIT_FRACTIONS` (0.5,0.25,0.25), `TWINS_PAPER_SQUAREOFF_IST` (15:20), `TWINS_PAPER_MAX_PRICE_AGE_SEC` (120). A malformed value throws (the worker logs `paper.config.invalid` and runs without the loop).

## API (read-only, bearer token)
`GET /paper/status`, `/paper/summary`, `/paper/positions?state=&limit=`, `/paper/trades/:id/events`, `/paper/outcomes?limit=`, `/paper/outcomes/stats`. Prices in responses are the last price the worker stored with each trade.

## Not built / next
Option-contract prices; an operator "square off now" action (needs an authenticated write route and its own review); alert rules for `paper.cycle.failed`; calibrating slippage and the trail from real outcomes once there are 30+; a real broker gateway (not planned).
