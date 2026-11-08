import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkExecutionGate } from "../../../packages/types/src/platform/index";

const read = (p: string) => readFileSync(p, "utf8");
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = (pkg: string) => readdirSync(`packages/${pkg}/src`).filter((f) => f.endsWith(".ts")).map((f) => [`${pkg}/${f}`, strip(read(join(`packages/${pkg}/src`, f)))] as const);

describe("Stage 07 boundaries", () => {
  it("the decision and execution packages import no broker, network, Telegram, LLM or live-trading code", () => {
    for (const [f, code] of [...sources("decision"), ...sources("execution")]) {
      expect(code, f).not.toMatch(/adapter-broker|adapter-telegram|@twins\/kite|@twins\/ai\b|fetch\(|node:https?|node:net|axios|placeOrder|brokerOrder|liveExecutionEnabled:\s*true|TRADING_ENABLED/i);
      expect(code, f).not.toMatch(/into\s+orders\b|into\s+fills\b|into\s+positions\b|from\s+"@twins\/signals"/i); // the real broker tables are never written here
    }
  });
  it("execution has no way to enable a live mode: the gate always refuses ASSISTED_LIVE and CONTROLLED_AUTO", () => {
    const base = { liveExecutionEnabled: false, paperEnabled: true, userPermitsMode: true, killSwitchActive: false, riskRecheckPassed: true, decisionState: "APPROVED", decisionOutcome: "QUALIFIED", orderConfirmationId: "x", autoPolicyId: "y", brokerAndRegulatoryGatesVerified: true } as const;
    for (const mode of ["ASSISTED_LIVE", "CONTROLLED_AUTO"] as const) { const g = checkExecutionGate({ ...base, mode }); expect(g.allowed).toBe(false); expect(g.reasons).toContain("live_execution_disabled"); }
    const exec = strip(read("packages/execution/src/execute.ts"));
    expect(exec).toMatch(/liveExecutionEnabled: false/); expect(exec).not.toMatch(/liveExecutionEnabled: (true|d\.|o\.|config)/);
    expect(exec).toMatch(/mode !== "PAPER"/);
  });
  it("only the monitor and execution modules write paper positions; fills are applied by the database, orders only advance through setOrderStatus", () => {
    const writers = ["decision", "execution", "planning", "opportunity", "confidence"].flatMap((p) => sources(p)).filter(([, c]) => /updatePositionEntry|updatePositionExit|moveStopLoss|createPaperPosition/.test(c)).map(([f]) => f).sort();
    expect(writers).toEqual(["execution/execute.ts", "execution/monitor.ts"]);
    for (const [f, c] of sources("execution")) expect(c, f).not.toMatch(/update\s+paper_orders|update\s+paper_fills|filled_quantity\s*=/i);
  });
  it("monitoring never reports success without a price, and exits are not gated on a decision's window", () => {
    const mon = strip(read("packages/execution/src/monitor.ts"));
    expect(mon).toMatch(/if \(!px\.ok\)[\s\S]{0,200}unmonitored\+\+/); expect(mon).toMatch(/kind: "PRICE_UNAVAILABLE"/); expect(mon).toMatch(/the position is NOT being monitored/);
    expect(mon).not.toMatch(/evaluateSafety/); // the kill switch blocks entries, never exits
  });
});

describe("migration 0038 invariants", () => {
  const sql = read("packages/database/drizzle/0038_decision_execution_trade_management.sql");
  it("is append-only where evidence, owner-isolated everywhere, and keeps live modes impossible", () => {
    for (const t of ["decision_approvals", "decision_invalidations", "paper_fills", "paper_position_events"]) { expect(sql).toContain(`"${t}_no_update_delete"`); expect(sql).toContain(`"${t}_no_truncate"`); }
    for (const t of ["decision_approvals", "decision_invalidations", "execution_requests", "paper_orders", "paper_fills", "paper_positions", "paper_position_events"]) { expect(sql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`); expect(sql).toContain(`"${t}_owner_only"`); }
    expect(sql).toContain("execution_requests_live_disabled_check"); expect(sql).toContain("paper_orders_mode_check"); expect(sql).toContain("paper_positions_mode_check"); expect(sql).toContain("decision_approvals_mode_check");
  });
  it("encodes the order lifecycle, the entry size limit, the opposite-side exit rule and the tighten-only stop", () => {
    for (const s of ["PROPOSED", "SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED", "FILLED", "REJECTED", "CANCELLED", "EXPIRED"]) expect(sql).toContain(`'${s}'`);
    expect(sql).toContain("the entry quantity exceeds the size the decision permits"); expect(sql).toContain("an exit order needs an open position, the opposite side");
    expect(sql).toContain("a stop-loss can only be tightened"); expect(sql).toContain("a fill cannot exceed the remaining order quantity"); expect(sql).toContain("a position needs a filled entry order");
    expect(sql).toContain("an expired or invalidated decision cannot be approved");
  });
  it("closes the doors: user_decisions is created and approved only through SECURITY DEFINER functions bound to the transaction's user", () => {
    for (const f of ["twins_create_user_decision", "twins_end_user_decision", "twins_invalidate_decision", "twins_record_decision_approval"]) expect(sql).toContain(`CREATE FUNCTION "${f}"`);
    expect((sql.match(/SECURITY DEFINER SET search_path = public, pg_temp/g) ?? []).length).toBe(4);
    expect((sql.match(/nullif\(current_setting\('twins\.user_id', true\), ''\)::uuid/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(read("infrastructure/staging/app-role.sql")).toContain("twins_record_decision_approval(uuid, text, jsonb, text, text)");
    expect(sql).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DELETE FROM/);
  });
});
