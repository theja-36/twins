#!/usr/bin/env python3
"""One-off generator for docs/product/tracker.json from the Master Specification (the JSON is the authoritative tracker afterwards;
re-running with --force would overwrite manual progress, so it refuses unless the file is absent)."""
import json, re, sys, os
SPEC = "docs/product/TWINS_MASTER_SPEC.md"; OUT = "docs/product/tracker.json"
if os.path.exists(OUT) and "--force" not in sys.argv: sys.exit("tracker.json exists; refusing to overwrite (use --force)")
lines = open(SPEC, encoding="utf-8").read().split("\n")
STAGE = {"01":"03","02":"03","03":"03","06":"03","07":"03","04":"04","05":"04","16":"05","08":"06","09":"06","10":"06","11":"06","12":"07","13":"07","14":"07","15":"08"}
reqs = []; counters = {}
def add(mod, mname, sub, feat, stage):
    counters[mod] = counters.get(mod, 0) + 1
    reqs.append({"id": f"M{mod}-{counters[mod]:02d}", "module": f"M{mod}", "moduleName": mname, "area": sub, "feature": feat, "existing": "none identified in the Phase 00 audit", "change": "to be defined when the stage starts",
      "packages": [], "database": [], "api": [], "screens": [], "dependencies": [], "stage": stage, "status": "NOT_STARTED", "evidence": [], "blockers": []})
mod = mname = sub = grp = None
for ln in lines:
    m = re.match(r"^## MODULE (\d\d) — (.+)$", ln)
    if m: mod, mname, sub, grp = m.group(1), m.group(2).strip(), None, None; continue
    if ln.startswith("# PART 4"): mod = None
    if mod is None: continue
    h = re.match(r"^### (.+)$", ln)
    if h: sub, grp = h.group(1).strip(), None; continue
    b = re.match(r"^\*\*(.+?)\*\*\s*$", ln)
    if b and sub: grp = b.group(1).strip(); continue
    if ln.startswith("- ") and sub and sub not in ("Important behaviour", "Important rules", "Important rule", "Calculation principles"):
        add(mod, mname, sub, (f"{grp}: " if grp else "") + ln[2:].strip(), STAGE[mod])
# Part 4 multi-user
for t in ["Separate account", "Secure authentication", "Individual capital", "Individual available balance", "Individual risk percentage", "Individual daily loss limit", "Individual position limits", "Individual trading permissions", "Individual broker connection", "Individual approval settings", "Individual portfolio", "Individual trade history", "Individual analytics",
          "Isolation: no user can view another user's private broker details", "Isolation: no user can access another user's capital", "Isolation: no user can approve another user's trade", "Isolation: no user can modify another user's risk settings", "Isolation: no user can view another user's private trade history", "Authorisation checks at API, service and database-access boundaries (not frontend-only)"]:
    counters["MU"] = counters.get("MU", 0) + 1
    reqs.append({"id": f"MU-{counters['MU']:02d}", "module": "MU", "moduleName": "Multi-user architecture (Part 4)", "area": "Part 4", "feature": t, "existing": "none identified in the Phase 00 audit (single shared API key; user_id only on accounts and broker_connections)", "change": "to be defined", "packages": [], "database": [], "api": [], "screens": [], "dependencies": [], "stage": "01-02", "status": "NOT_STARTED", "evidence": [], "blockers": []})
# 12 agents + options-risk
AG = [("Signal Integrity Agent", "signal-integrity-v1"), ("Instrument Validation Agent", "instrument-verification-v1"), ("Market Context Agent", None), ("Technical Structure Agent", "technical-structure-v1"), ("Price Action Agent", "price-action-v1"), ("News & Sentiment Agent", "news-sentiment-v1"),
      ("Liquidity Agent", "liquidity-v1"), ("Historical Pattern Agent", "historical-pattern-v1"), ("Calendar & Macro Agent", "market-calendar-v1 + macro-global-v1"), ("Index Constituents Agent", "index-constituent-impact-v1"), ("Independent Challenger Agent", "independent-challenger-v1"), ("Research Synthesis Agent", "synthesis.ts (not an agent)")]
for i, (n, e) in enumerate(AG, 1):
    reqs.append({"id": f"A{i:02d}", "module": "M04", "moduleName": "Research & Validation AI Agents", "area": "The 12 specialist agents", "feature": n + ": contract, evidence references, reasoning summary, risk flags, execution status, unavailable-state handling",
      "existing": e or "no dedicated agent (market-calendar covers hours and holidays only)", "change": "map to the spec contract; add LLM-assisted interpretation behind the AI provider interface", "packages": ["packages/agents"], "database": ["agent_runs", "agent_findings", "agent_evidence_references"], "api": [], "screens": [], "dependencies": [], "stage": "04", "status": "NOT_STARTED", "evidence": [], "blockers": []})
reqs.append({"id": "A13", "module": "M04", "moduleName": "Research & Validation AI Agents", "area": "Additional agent", "feature": "options-risk-v1: preserve and map (not in the spec's 12)", "existing": "options-risk-v1 (rule-based; needs option data)", "change": "keep; map under Market/Liquidity risk", "packages": ["packages/agents"], "database": [], "api": [], "screens": [], "dependencies": [], "stage": "04", "status": "NOT_STARTED", "evidence": [], "blockers": []})
# 30 screens
SC = ["Login and authentication", "Main dashboard", "Market overview", "Telegram channels", "Signal intake", "Signal details", "Signal history", "Evidence explorer", "Research workspace", "Agent intelligence", "Channel strategy intelligence", "Strategy playbooks", "Independent opportunities", "Decision centre", "Decision detail", "Risk dashboard", "Capital management", "What-if simulator", "Approval centre", "Paper trading", "Live execution controls", "Orders and fills", "Open positions", "Trade monitoring", "P&L and analytics", "Learning and performance", "Notifications", "User settings", "Broker settings", "Administration and audit"]
for i, s in enumerate(SC, 1):
    reqs.append({"id": f"S{i:02d}", "module": "UI", "moduleName": "Frontend screens (Part 5.4)", "area": "Screens", "feature": f"{s}: real backend contract plus loading, empty, error, stale-data and permission states", "existing": "see frontend audit", "change": "to be defined", "packages": ["twins-frontend"], "database": [], "api": [], "screens": [s], "dependencies": [], "stage": "09", "status": "NOT_STARTED", "evidence": [], "blockers": []})
# Platform foundation + gates
PF = ["Domain architecture and module boundaries", "Shared data contracts", "Event contracts", "API contracts", "Database ownership and relationships", "Authentication and authorisation", "User isolation", "Configuration management", "Audit logging", "Error handling", "Background-job conventions", "AI provider interface", "Execution safety boundaries"]
for i, s in enumerate(PF, 1):
    reqs.append({"id": f"P{i:02d}", "module": "PF", "moduleName": "Platform foundation (Phase 01)", "area": "Foundation", "feature": s, "existing": "see audit", "change": "to be defined", "packages": [], "database": [], "api": [], "screens": [], "dependencies": [], "stage": "01", "status": "NOT_STARTED", "evidence": [], "blockers": []})
json.dump({"version": 1, "source": SPEC, "statuses": ["NOT_STARTED", "IN_PROGRESS", "IMPLEMENTED", "BLOCKED", "VERIFIED"], "requirements": reqs}, open(OUT, "w"), indent=1, ensure_ascii=False)
print(len(reqs), "requirements", {k: v for k, v in counters.items()})
