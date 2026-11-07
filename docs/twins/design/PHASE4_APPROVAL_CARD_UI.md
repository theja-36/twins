# Phase 4: approval card in the web UI (design only)

**Mockup with invented data:** the "Approval card" tab of `design/mockups.html` (twins-frontend PR #6). **No backend wiring, no write path.**

## What exists
* `GET /risk/decisions/:id/decision-card` (deployed, read-only): headline, agents, blockers, unavailable sources, close calls, sizing, source health. Codes and numbers only.
* Approvals are made through the Telegram approval bot (plain-text card, re-checks every gate). The API also has `POST /risk/decisions/:id/approval`, which the web proxy does not forward (the proxy is GET-only on purpose).
* Paper and live trading are off; no approval can currently lead to an order.

## Card layout (as mocked)
Header: contract, research verdict, decision version, channel, age, source trust. Then: levels (entry, stop with its basis and whether the basis was inferred, targets, reward to risk); size proposed (quantity, largest loss in rupees, share of capital, and the reduce-only check as information only); what the agents said (weighted for / neutral / against bar, per-agent view and reason codes, close-call line); data behind it (provider health pills); what blocks it (unverified contract, missing premium data, expiry); actions area.

## The decision that matters: how approval is done
* **Option A (recommended now): the card is read-only; approval stays in the Telegram bot.** The page links to the decision and shows "waiting for approval in Telegram". Nothing new to secure.
* **Option B: Approve / Reject in the web UI.** This is a new write path and needs its own safety review before it is built: a per-person login (the frontend server holds one shared API token, which cannot say who approved), a second factor or typed confirmation, CSRF protection, a server-side re-check of eligibility at click time (never trusting what the card displayed), an audit entry with the approver, an expiry on the card, and a hard refusal while live or paper trading and the kill switch say no. It should not be built before the Stage 6 constraint is lifted.

## States the page must handle
Loading; unavailable (backend down: say so, never show an old card as current); assessment not stored yet (404 `no_assessment`); unreadable assessment (422); decision superseded by a newer version (link to the latest); expired card; sizing not available (explain why, e.g. trust unknown); partial data (show the pill as missing, never as OK).

## Wording and accessibility
Plain sentences; every state carries text as well as colour; buttons say exactly what they do; the disabled actions explain why; keyboard focus visible; works at phone width (stacked sections, table scrolls inside its own container); light and dark.

## Implementation plan (after Monday, read-only only)
1. Add `risk/decisions/<uuid>/decision-card` and `.../approval-eligibility` to the proxy allow-list (GET, id pattern enforced).
2. A card view reachable from Approvals and Signals; the layout above; states above.
3. Show claim fields from the future claims endpoint (Phase 2 backend) when available.
4. No approval controls in this step.

## Open questions
Option A or B? Should the card show the reduce-only check only when the shadow is on? Should the card display the channel name or only a masked id?
