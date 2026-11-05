# Q-009 privacy question: draft answer for owner approval

> Prepared 2026-11-05. **Not approved.** The owner must approve (or change) this before the engine is enabled in ANY mode, including shadow. Question text (OPEN_QUESTIONS.md Q-009): model use - none yet / local model / external provider / mixed - and, for anything but "none yet", whether any channel text may be disclosed.

## Proposed answer
1. **Model use: none.** No model component is activated. All twelve agents are deterministic code (D-026: agents are logical responsibilities). No provider is selected, purchased or called.
2. **Channel text disclosure: none.** Agents receive parsed fields, tiers and numbers only (`risk_decision`, `source_intelligence`, `stop_loss_validation`, `signal_features`, `signal_context`). The inputs builder never reads message text; agent text is redacted and bounded before it is logged; engine log events are allow-listed.
3. **Market data disclosure: inbound only.** Kite market data is fetched into snapshots by the ticker; the engine reads snapshot files. The engine package opens no network connection and imports no network or LLM code (as documented in AGENT_ENGINE.md, section Safety and privacy; the reviewer should confirm).
4. **What is written where in shadow mode:** only structured log lines (decision id, assessment, counts, agent ids and verdicts) to the host journal, retained 7 days. No message text, no prices of the signal, no personal data. In enforcing mode the existing append-only tables hold the same fields plus finding codes.
5. **Alerts** carry fixed templates and the allow-listed detail keys only (no text, no secrets); destination is the owner's Telegram chat through the loopback relay.

## What would change this answer
A local or external model, or any use of channel text by an agent, is a new proposal needing a separate decision (provider, data classification, retention, redaction proof) and is **not** covered by approving the above.

## What approval authorizes
Running the deterministic engine in shadow mode on real decisions with the output limits above. It does not authorize enforcing mode, a model, or disclosure of any kind.
