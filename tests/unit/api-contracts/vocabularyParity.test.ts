/** Shared enums and the LIVE / PAPER / FIXTURE / UNAVAILABLE status vocabulary equal their backend sources. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAPER_ORDER_STATES as B_ORDER_STATES, POSITION_EVENT_KINDS as B_EVENT_KINDS } from "../../../packages/database/src/schema/tradeExecution";
import { ANALYTICS_DATASETS, ATTRIBUTION_FINALITIES, ATTRIBUTION_MODES, AVAILABILITY, DATA_SOURCES, DATA_STATES, DECISION_STATES, FRESHNESS, LIVE_STATUS_UNAVAILABLE, ORDER_PURPOSES, PAPER_MODE, PAPER_ORDER_STATES, POSITION_EVENT_KINDS, POSITION_STATUSES, PROVENANCE_BADGES, SIDES, STRATEGY_DIMENSIONS } from "../../../packages/api-contracts/src/index";

const src = (p: string): string => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const listIn = (text: string, re: RegExp): string[] => { const m = re.exec(text); expect(m, String(re)).not.toBeNull(); return [...(m?.[1] ?? "").matchAll(/"([A-Za-z_]+)"/g)].map((x) => x[1] as string); };

describe("enumerations", () => {
  it("order states and position event kinds equal the backend exports", () => {
    expect([...PAPER_ORDER_STATES]).toEqual([...B_ORDER_STATES]); expect([...POSITION_EVENT_KINDS]).toEqual([...B_EVENT_KINDS]);
  });
  it("decision states equal DECISION_STATES in userApi.ts (not exported, so read from source)", () => { expect([...DECISION_STATES]).toEqual(listIn(src("apps/api/src/userApi.ts"), /const DECISION_STATES = \[([^\]]*)\]/)); });
  it("strategy dimensions equal the keys of STRATEGY_DIMENSIONS in userApi.ts", () => {
    const m = /const STRATEGY_DIMENSIONS: Record<string, string> = \{([^}]*)\}/.exec(src("apps/api/src/userApi.ts"));
    expect([...(m?.[1] ?? "").matchAll(/(\w+):\s*"by/g)].map((x) => x[1])).toEqual([...STRATEGY_DIMENSIONS]);
  });
  it("position status, side, purpose, attribution mode, finality and data source equal the store row types", () => {
    const exec = src("packages/database/src/stores/executionStore.ts"), out = src("packages/database/src/stores/outcomeStore.ts");
    expect(exec).toContain('status: "OPEN" | "CLOSED"'); expect([...POSITION_STATUSES]).toEqual(["OPEN", "CLOSED"]);
    expect(exec).toContain('purpose: "ENTRY" | "EXIT"'); expect([...ORDER_PURPOSES]).toEqual(["ENTRY", "EXIT"]);
    expect(exec).toContain('side: "BUY" | "SELL"'); expect([...SIDES]).toEqual(["BUY", "SELL"]);
    expect(out).toContain('finality: "PARTIAL" | "FINAL"'); expect([...ATTRIBUTION_FINALITIES]).toEqual(["PARTIAL", "FINAL"]);
    expect(out).toContain('mode: "PAPER" | "LIVE"'); expect([...ATTRIBUTION_MODES]).toEqual(["PAPER", "LIVE"]);
    expect(out).toContain('dataSource: "FIXTURE" | "LIVE" | "HISTORICAL"'); expect([...DATA_SOURCES]).toEqual(["FIXTURE", "LIVE", "HISTORICAL"]);
  });
  it("analytics dataset and freshness values equal the backend's", () => {
    expect([...ANALYTICS_DATASETS]).toEqual(listIn(src("apps/api/src/userApi.ts"), /\[("ALL"[^\]]*)\]\.includes\(q\["dataset"\]\)/));
    expect([...ANALYTICS_DATASETS]).toEqual(Object.keys(JSON.parse('{"ALL":1,"VALIDATED":1,"FIXTURE":1}')));
    expect(src("packages/outcomes/src/snapshot.ts")).toContain('freshness: "CURRENT" | "STALE"'); expect([...FRESHNESS]).toEqual(["CURRENT", "STALE"]);
  });
});

describe("approval-class vocabulary stays out of the browser contracts", () => {
  it("the package contains no approval-class state literal (the audited-places safety scan stays untouched) and DecisionView.outcome is a plain string", () => {
    const files = ["enums", "wire", "catalogue", "errors", "analytics", "roles", "rules", "index"].map((f) => src(`packages/api-contracts/src/${f}.ts`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""));
    for (const t of files) expect(t).not.toMatch(/["'`](APPROVE|QUALIFIED|CONDITIONAL)["'`]/);
    expect(src("packages/api-contracts/src/wire.ts")).toMatch(/outcome: string; workflowState: string;/);
  });
});

describe("status vocabulary: LIVE, PAPER, FIXTURE, UNAVAILABLE", () => {
  it("the only trading mode is PAPER and the live status is UNAVAILABLE", () => { expect(PAPER_MODE).toBe("PAPER"); expect(LIVE_STATUS_UNAVAILABLE).toBe("UNAVAILABLE"); expect(src("packages/outcomes/src/contracts.ts")).toContain('liveStatus: "UNAVAILABLE"'); });
  it("the interface badge vocabulary contains exactly FIXTURE, PAPER, LIVE and UNAVAILABLE, and FIXTURE data is always distinguishable from LIVE", () => {
    expect([...PROVENANCE_BADGES].sort()).toEqual(["FIXTURE", "LIVE", "PAPER", "UNAVAILABLE"]); expect(DATA_SOURCES).toContain("FIXTURE"); expect(DATA_SOURCES).toContain("LIVE"); expect(PROVENANCE_BADGES.filter((b) => b === "LIVE" || b === "FIXTURE")).toHaveLength(2);
  });
  it("the eight data states and the availability vocabulary are the documented ones", () => {
    expect([...DATA_STATES]).toEqual(["LOADING", "READY", "EMPTY", "STALE", "ERROR", "DENIED", "UNAVAILABLE", "PARTIAL"]); expect([...AVAILABILITY]).toEqual(["AVAILABLE", "UNAVAILABLE", "PLANNED"]);
  });
});
