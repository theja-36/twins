#!/usr/bin/env python3
"""One-off: records what already exists (Phase 00 audit, re-verified in Stage 00) in docs/product/tracker.json. Marks IMPLEMENTED only; VERIFIED stays reserved for evidence gathered in the testing stage."""
import json
T = "docs/product/tracker.json"; d = json.load(open(T)); R = d["requirements"]
EV = "Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5"
def rule(mod, key, existing, status="IMPLEMENTED", pk=(), db=()): return (mod, key.lower(), existing, status, list(pk), list(db))
RULES = [
 rule("M01", "multiple telegram channel", "telegram_sources + capture reads approved chats", pk=["services/telegram-capture", "packages/ingestion"], db=["telegram_sources"]),
 rule("M01", "real-time message listener", "services/telegram-capture listener and POST /webhooks/telegram", pk=["services/telegram-capture", "apps/api"], db=["telegram_messages"]),
 rule("M01", "channel management", "read-only: GET /telegram/channels; the allow-list is a host setting (no write route)", "NOT_STARTED"),
 rule("M01", "raw message storage", "telegram_messages, append-only evidence events", db=["telegram_messages", "telegram_message_events"]),
 rule("M01", "message parsing", "packages/signals/src/extract.ts (parser v3)", pk=["packages/signals"], db=["options_claims"]),
 rule("M01", "signal identification", "extract.ts kinds: signal / options_claim / ambiguous / unsupported / none", pk=["packages/signals"]),
 rule("M01", "message edit and delete", "telegram_message_events (seen, edited_observed, deleted_observed)", pk=["packages/ingestion"], db=["telegram_message_events"]),
 rule("M01", "duplicate detection", "packages/ingestion/src/dedupe.ts + idempotency keys", pk=["packages/ingestion"]),
 rule("M01", "malformed signal", "result kinds ambiguous / unsupported", pk=["packages/signals"]),
 rule("M01", "delayed signal", "partial: decision validity windows only (risk/src/expiry)", "NOT_STARTED"),
 rule("M01", "signal freshness", "partial: 15-minute approval window (risk/src/expiry)", "NOT_STARTED"),
 rule("M01", "channel health", "partial: last message age in GET /telegram/channels", "NOT_STARTED"),
 rule("M01", "historical message ingestion", "packages/historical import + capture-export (offline CLI)", pk=["packages/historical"], db=["historical_import_batches"]),
 rule("M01", "source reliability", "partial: offline scorecards and trust tiers, not wired to live data", "NOT_STARTED", db=["historical_trust_tiers"]),
 rule("M01", "symbol and underlying", "options_claims.underlying", db=["options_claims"]), rule("M01", "ce / pe", "options_claims.option_type", db=["options_claims"]), rule("M01", "strike", "options_claims.strike", db=["options_claims"]),
 rule("M01", "expiry", "options_claims.expiry (day/month; year often missing)", db=["options_claims"]), rule("M01", "entry price", "options_claims.entry (above/at/range)", db=["options_claims"]), rule("M01", "stop-loss", "options_claims.stop_loss + level basis", db=["options_claims"]),
 rule("M01", "multiple targets", "options_claims.targets", db=["options_claims"]), rule("M01", "signal timestamp", "telegram_messages.message_timestamp", db=["telegram_messages"]),
 rule("M02", "market and instrument identification", "options claim fields; instrument-verification agent", pk=["packages/signals", "packages/agents"]),
 rule("M02", "entry condition extraction", "partial: entry kinds above / at / range", "NOT_STARTED"),
 rule("M02", "breakout classification", "partial: breakout detection exists only inside technical/price-action agents", "NOT_STARTED"),
 rule("M03", "immutable original message", "append-only triggers on telegram tables", db=["telegram_messages"]), rule("M03", "edit and deletion history", "telegram_message_events", db=["telegram_message_events"]),
 rule("M03", "signal revision tracking", "packages/ingestion/src/telegramRevisions.ts", pk=["packages/ingestion"]), rule("M03", "evidence references", "signal_evidence, agent_evidence_references", db=["signal_evidence", "agent_evidence_references"]),
 rule("M03", "historical signal database", "historical_* tables (import, outcomes, scorecards, patterns)", pk=["packages/historical"], db=["historical_normalized_records"]), rule("M03", "pattern library", "offline pattern definitions and confidence (not live)", pk=["packages/historical/src/patterns"], db=["historical_pattern_definitions"]),
 rule("M04", "clearly defined input schema", "agent contract in packages/agents/src/contract.ts", pk=["packages/agents"]), rule("M04", "clearly defined output schema", "agent contract in packages/agents/src/contract.ts", pk=["packages/agents"]),
 rule("M04", "evidence references", "agent_evidence_references", db=["agent_evidence_references"]),
 rule("M04", "error and unavailable-state handling", "UNAVAILABLE verdict and error codes in the contract", pk=["packages/agents"]),
 rule("M05", "trending market detection", "pure detector risk/src/regime/detect.ts (needs bars)", pk=["packages/risk"]), rule("M05", "range-bound market detection", "risk/src/regime/detect.ts", pk=["packages/risk"]), rule("M05", "volatile market detection", "risk/src/regime/detect.ts (HIGH/LOW_VOLATILITY)", pk=["packages/risk"]), rule("M05", "volatility regime", "risk/src/regime/detect.ts", pk=["packages/risk"]),
 rule("M08", "maximum permissible trade risk", "sizing engine (single configured capital)", "NOT_STARTED", pk=["packages/risk/src/sizing"]), rule("M08", "risk per lot", "sizing engine", "NOT_STARTED", pk=["packages/risk/src/sizing"]), rule("M08", "number of lots", "sizing engine", "NOT_STARTED", pk=["packages/risk/src/sizing"]),
 rule("M10", "stop-loss validation", "packages/stop-loss + mandatory stop rule", pk=["packages/stop-loss"], db=["stop_loss_validations"]), rule("M10", "maximum daily loss", "loss circuit breakers", pk=["packages/risk/src/breakers"], db=["circuit_breaker_events"]),
 rule("M10", "portfolio exposure", "portfolio open-risk limits", pk=["packages/risk/src/portfolio", "packages/risk/src/exposure"]), rule("M10", "correlated index exposure", "risk/src/correlation", pk=["packages/risk/src/correlation"]), rule("M10", "drawdown controls", "risk/src/drawdown governor", pk=["packages/risk/src/drawdown"]),
 rule("M10", "event-risk restrictions", "risk/src/market/windows.ts blackout windows", pk=["packages/risk/src/market"], db=["event_blackout_windows"]), rule("M10", "low-liquidity restrictions", "risk/src/liquidity", pk=["packages/risk/src/liquidity"]), rule("M10", "market closing-time restrictions", "risk/src/market/sessions.ts", pk=["packages/risk/src/market"]),
 rule("M10", "daily loss halt", "circuit breakers", pk=["packages/risk/src/breakers"]), rule("M10", "drawdown halt", "drawdown governor", pk=["packages/risk/src/drawdown"]), rule("M10", "global kill switch", "packages/runtime-state kill switch + safety-control CLI", pk=["packages/runtime-state"], db=["system_controls"]),
 rule("M12", "decision validity window", "15-minute approval validity (TWINS_RISK_EXPIRY_APPROVED_MINUTES)", pk=["packages/risk/src/expiry"]),
 rule("M13", "telegram approval bot", "services/approval-bot (inactive on staging)", pk=["services/approval-bot"], db=["approval_bot_state"]), rule("M13", "approval cards", "risk_approval_cards", db=["risk_approval_cards"]), rule("M13", "approval expiry", "risk expiry + card expiry", pk=["packages/risk"]), rule("M13", "eligibility recheck", "assessApprovalEligibility + twins_record_risk_approval", pk=["packages/risk/src/approval"]),
 rule("M13", "mode a — paper trading: simulated order placement", "packages/paper (off by default)", pk=["packages/paper"], db=["paper_trades"]), rule("M13", "mode a — paper trading: simulated fills", "packages/paper manager", pk=["packages/paper"]), rule("M13", "mode a — paper trading: simulated trade lifecycle", "paper_trade_events", pk=["packages/paper"], db=["paper_trade_events"]),
 rule("M13", "mode a — paper trading: p&l calculation", "packages/paper/src/pnl.ts", pk=["packages/paper"]), rule("M13", "mode a — paper trading: trade history", "paper_outcomes; GET /paper/outcomes", db=["paper_outcomes"]), rule("M13", "mode a — paper trading: no real money", "live-trading guard; paper never calls a broker", pk=["packages/runtime-state"]),
 rule("M14", "stop-loss monitoring", "paper manager (paper only)", pk=["packages/paper"]), rule("M14", "target monitoring", "paper manager (paper only)", pk=["packages/paper"]), rule("M14", "trailing stop", "paper adaptiveManagement / trail config", pk=["packages/paper"]), rule("M14", "time-based exit", "paper square-off time", pk=["packages/paper"]),
 rule("M14", "partial exit handling", "paper exit fractions", pk=["packages/paper"]), rule("M14", "trade status", "paper trade states", pk=["packages/paper"]), rule("M14", "outcome recording", "paper_outcomes", db=["paper_outcomes"]), rule("M14", "live p&l", "paper pnl (paper only)", pk=["packages/paper"]),
 rule("PF", "audit logging", "audit_events + 32 hash chains + verifier", pk=["packages/audit-chain"], db=["audit_events"]), rule("PF", "configuration management", "packages/config + env guards", pk=["packages/config"]),
 rule("PF", "execution safety boundaries", "live-trading guard in every process; broker order-intent guard", pk=["packages/runtime-state", "adapters/broker"]),
 rule("PF", "ai provider interface", "contract only (packages/types/src/providers/ai.ts, packages/ai)", "NOT_STARTED", pk=["packages/ai", "packages/types"]),
]
hit = 0
for r in R:
    f = r["feature"].lower()
    for (mod, key, existing, status, pk, db) in RULES:
        if r["module"] == mod and key in f:
            r["existing"] = existing; r["status"] = status
            if pk: r["packages"] = pk
            if db: r["database"] = db
            if status == "IMPLEMENTED": r["evidence"] = [EV]
            hit += 1; break
for r in R:
    if r["id"].startswith("A") and r["id"] not in ("A03", "A12", "A13"): r["existing"] = r["existing"] + " (rule-based, no LLM; shadow only)"
json.dump(d, open(T, "w"), indent=1, ensure_ascii=False)
from collections import Counter
print("rules matched", hit, Counter(r["status"] for r in R))
