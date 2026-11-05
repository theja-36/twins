# Paper trading: the enable checklist

Paper trading is **OFF**. It is simulation only (no broker, no order, no `orders` / `fills` / `positions` row). It runs only when **both** keys are on, and turning them on is the owner's explicit decision (a "GO"). The frontend page Settings, and `GET /paper/readiness`, show this checklist live; `readyToEnable` means nothing blocks a GO, not that anything is on.

## Must be true (the API computes these; any failure is a blocker)
1. **Kill switch clear** (an unreadable switch counts as NOT clear).
2. **Live-trading guard passes and the mode is paper.**
3. **Paper tables and the switch row readable** (migrations 0030 and 0031 applied).
4. **The admin token is configured** (otherwise the audited switch cannot be turned on): generate 32+ random characters on the host, put `TWINS_ADMIN_API_KEY` in `staging.env`, recreate the api. Never in chat.
5. **A complete Kite snapshot generation exists** (needs a feed run, which needs a fresh Kite login), **and a fresh index price while the market is open** (09:15-15:30 IST, weekdays; limit 120 s).

## Worth knowing (informational, never blocking)
- Approved decisions on record (with none, nothing is simulated), Telegram intake on, the worker mounts the snapshots read-only and shadow mode is on (manual check), and an external human review (F1) is still recommended before enforcing mode or any live use.
- Option contracts have no price in the snapshot, so option paper trades stay unmonitored (pending entries expire); index and cash-segment trades work.

## GO (two separate actions, in this order, each logged)
1. **Arm:** set `TWINS_PAPER_TRADING_ENABLED=true` in `staging.env` and recreate the worker (the loop starts but does nothing while the switch is OFF).
2. **Switch on:** `POST /admin/paper/switch` with the admin token, `{ "enabled": true, "actor": "operator:<you>", "reason": "..." }`. Every change is an append-only audited event.

## First day: what to watch
`GET /paper/status` (effective on, switch history), Positions and P&L pages, `/notifications` (paper trades, stop-outs), the worker log for `paper.cycle` lines (`invalid`, `noPrice`, `stalePrice` counts), and that nothing appears in `orders` / `fills` / `positions` (it never should).

## STOP (either one is enough)
Switch OFF (`POST /admin/paper/switch` with `enabled:false`) or unset the host setting and recreate the worker. Open simulated trades stay in the database as they are; at 15:20 IST an enabled cycle squares off the open ones, a stopped cycle leaves them untouched.
