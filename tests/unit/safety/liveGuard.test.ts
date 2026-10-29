import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertLiveTradingDisabled,
  enforceLiveTradingGuard,
  evaluateLiveGuard,
  LIVE_GUARD_EXIT_CODE,
  LiveGuardError,
} from "../../../packages/config/src/liveGuard";

interface Case {
  name: string;
  env: Record<string, string>;
  ok: boolean;
  reasons: string[];
}
const contract = JSON.parse(readFileSync("tests/fixtures/liveGuard/contract.json", "utf8")) as { exitCode: number; cases: Case[] };

class Exited extends Error {
  constructor(readonly code: number) {
    super("exit");
  }
}
const exitThrows = (code: number): never => {
  throw new Exited(code);
};

describe("shared LIVE_TRADING guard (TypeScript) against the cross-language contract", () => {
  it("uses the contract's exit code", () => {
    expect(LIVE_GUARD_EXIT_CODE).toBe(contract.exitCode);
  });

  it.each(contract.cases)("evaluate: $name", (c) => {
    expect(evaluateLiveGuard(c.env)).toEqual({ ok: c.ok, reasons: c.reasons });
  });

  it.each(contract.cases)("assertLiveTradingDisabled: $name", (c) => {
    if (c.ok) expect(() => assertLiveTradingDisabled("test", c.env)).not.toThrow();
    else expect(() => assertLiveTradingDisabled("test", c.env)).toThrow(LiveGuardError);
  });

  it.each(contract.cases)("enforce: $name", (c) => {
    const lines: string[] = [];
    const run = () => enforceLiveTradingGuard("test-process", { env: c.env, exit: exitThrows, write: (l) => void lines.push(l) });
    if (c.ok) {
      run();
      expect(lines).toEqual([]);
      return;
    }
    expect(run).toThrow(Exited);
    try {
      run();
    } catch (e) {
      expect((e as Exited).code).toBe(81);
    }
    const out = JSON.parse(lines[0]!) as { event: string; process: string; reasons: string[] };
    expect(out).toMatchObject({ event: "live_guard.refused", process: "test-process", reasons: c.reasons });
    for (const value of Object.values(c.env)) if (value.length > 0) expect(lines.join(""), c.name).not.toContain(`"${value}"`);
  });

  it("has no override: extra options or environment flags can never turn a refusal into a pass", () => {
    const env = { LIVE_TRADING: "true", TRADING_MODE: "live", TWINS_LIVE_GATE_PASSED: "true", TWINS_ALLOW_LIVE: "1", LIVE_GATE: "passed" };
    expect(evaluateLiveGuard(env).ok).toBe(false);
    expect(() => assertLiveTradingDisabled("x", env)).toThrow(LiveGuardError);
    // the exported surface takes no gate/override argument
    expect(assertLiveTradingDisabled.length).toBeLessThanOrEqual(2);
  });

  it("reads process.env by default", () => {
    const saved = { ...process.env };
    try {
      process.env["LIVE_TRADING"] = "true";
      expect(() => assertLiveTradingDisabled("default-env")).toThrow(LiveGuardError);
      process.env["LIVE_TRADING"] = "false";
      expect(() => assertLiveTradingDisabled("default-env")).not.toThrow();
    } finally {
      process.env = saved;
    }
  });
});
