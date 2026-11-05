# TWINS operator API

Machine-readable description: [`openapi.json`](openapi.json) (OpenAPI 3.0.3, hand-written in `apps/api/src/openapi.ts`; a unit test fails if a route exists that is not described, or the reverse, or if this file is stale). The running API also serves it at `GET /openapi.json` (bearer token).

To browse it: paste `openapi.json` into <https://editor.swagger.io> or run `npx @redocly/cli preview-docs docs/api/openapi.json`.

## Access
* The API listens on the VPS loopback (port 4000). From a laptop use a tunnel: `ssh -L 4000:127.0.0.1:4000 hostinger-vps`.
* Every route except `/health` needs `Authorization: Bearer <TWINS_API_KEY>`. The admin route needs a *different* token (`TWINS_ADMIN_API_KEY`) and does not exist unless that token is configured.
* Errors are fixed bodies: `{ "error": "invalid_input" | "Unauthorized" | "not_found" | "internal_error" | ... }`. Server logs carry the route, the error class and a code, never a message or a row value.

## What it can and cannot do
* Reads: decisions, approvals, intelligence, paper positions / P&L / outcomes / statistics, agent status, system notifications, configuration, health.
* Writes: only (a) the human approval door (`POST /risk/decisions/{id}/approval`, which records a decision after the database re-checks every gate and creates **no order**) and (b) the audited **paper-trading switch** (`POST /admin/paper/switch`, admin token only; no effect unless the host has armed paper trading; refused while the live-trading guard fails).
* There is no route that places, modifies or cancels an order, and none that reads a broker account.

## The paper-trading switch (two keys)
1. **Host arming:** `TWINS_PAPER_TRADING_ENABLED=true` in `staging.env` (default false).
2. **Audited switch:** `POST /admin/paper/switch { "enabled": true, "actor": "operator:<name>", "reason": "..." }` (default OFF, seeded by migration 0031; every change is an append-only event).
Paper trading runs only when both are on. Either one off stops it at the next cycle. `GET /paper/status` shows `armedByHost`, `switch`, `switchHistory` and the effective `enabled`.
