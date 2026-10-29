"""The shared LIVE_TRADING guard, Python side. Same rules as packages/config/src/liveGuard.ts (conformance table:
tests/fixtures/liveGuard/contract.json, exercised by both test suites).

LIVE_TRADING must be unset or exactly "false"; TRADING_MODE must be unset, "paper" or "shadow". Anything else is refused. There is NO override
parameter: until the LIVE Gate (Stage 10) exists, no configuration permits live trading. Output carries reason codes only, never a value."""
import json
import sys

LIVE_GUARD_EXIT_CODE = 81


def evaluate_live_guard(env):
    reasons = []
    live = env.get("LIVE_TRADING")
    if live is not None and live != "false":
        reasons.append("live_trading_not_false")
    mode = env.get("TRADING_MODE")
    if mode is not None and mode not in ("paper", "shadow"):
        reasons.append("trading_mode_not_permitted")
    return (len(reasons) == 0, reasons)


def enforce_live_trading_guard(process_name, env, exit_fn=sys.exit, stream=None):
    ok, reasons = evaluate_live_guard(env)
    if ok:
        return
    out = stream if stream is not None else sys.stderr
    out.write(json.dumps({"level": "fatal", "event": "live_guard.refused", "process": process_name, "reasons": reasons}, separators=(",", ":")) + "\n")
    exit_fn(LIVE_GUARD_EXIT_CODE)
