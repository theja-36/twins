import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANALYTICS_ENDPOINTS, ANALYTICS_PERMISSION, buildAnalyticsReport, envelope, parseListQuery, sectionOf } from "../../../packages/outcomes/src/index";
import { win } from "./fixtures";

const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const dir = "packages/outcomes/src";
const src = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => [f, strip(readFileSync(join(dir, f), "utf8"))] as const);

describe("learning safety: insights cannot change behaviour", () => {
  it("the learning package imports nothing that decides, sizes, approves, executes or changes configuration", () => {
    for (const [f, code] of src) {
      expect(code, f).not.toMatch(/from "@twins\/(decision|execution|risk|opportunity|stop-loss|runtime-state|signals|ingestion|alerting|paper)/);
      expect(code, f).not.toMatch(/adapter-broker|adapter-telegram|fetch\(|node:https?|axios|placeOrder|TRADING_ENABLED|liveExecutionEnabled/i);
      expect(code, f).not.toMatch(/\b(createDecision|approveDecision|requestPaperExecution|recordDecisionApproval|setRiskControl|clearRiskControl|appendRiskPolicy|appendCapitalProfile|moveStopLoss|createPaperOrder)\b/);
    }
  });
  it("it never touches the learning-version, playbook, risk-policy, permission, decision or execution tables", () => {
    for (const [f, code] of src) expect(code, f).not.toMatch(/learning_versions|learningVersions|strategy_playbooks|playbook_versions|user_risk_policies|user_execution_permissions|user_decisions|execution_requests|paper_orders|paper_positions|system_controls|risk_control_events|users\b.*role/i);
  });
  it("its only writes are attributions, insights, the calibration run log and its own job run record", () => {
    const cycle = src.find(([f]) => f === "cycle.ts")![1];
    const writers = [...cycle.matchAll(/\b(insert\w*|store\w*|finish\w*|start\w*)\(/g)].map((m) => m[1]).filter((n): n is string => !!n);
    expect([...new Set(writers)].sort()).toEqual(["finishJobRun", "insertAttribution", "insertInsight", "startJobRun", "storeCalibrationRun"]);
    for (const [f, code] of src) if (f !== "cycle.ts") expect(code, f).not.toMatch(/@twins\/database"[\s\S]*\b(insert|store|finish|start)[A-Z]\w*\(/);
  });
  it("an insight's recommendation vocabulary is closed (REVIEW or nothing), in the type, the generator and the database", () => {
    const ins = src.find(([f]) => f === "insights.ts")![1]; const values = [...ins.matchAll(/recommendation: ([^,}]+)/g)].map((m) => (m[1] as string).trim());
    expect(values.length).toBeGreaterThan(5); for (const v of values) expect(v.includes("REVIEW") || v.includes("null") || /^f\.reliability/.test(v), v).toBe(true);
    const sql = readFileSync("packages/database/drizzle/0039_outcome_learning.sql", "utf8"); expect(sql).toContain("\"learning_insights\".\"recommendation\" = 'REVIEW'");
  });
  it("a failure in analytics cannot reach a decision: the worker wires the cycle on its own timer behind its own flag, off by default", () => {
    const w = readFileSync("services/worker/src/index.ts", "utf8");
    const block = w.slice(w.indexOf("Outcome learning (Stage 08)"), w.indexOf("Outbox reconciler (Stage 2"));
    expect(block).toMatch(/learningConfig\.enabled/); expect(block).toMatch(/runLearningCycle\(/); expect(block).not.toMatch(/runDecisionCycle|requestPaperExecution|approveDecision|runEvaluationCycle/);
    expect(strip(readFileSync("packages/outcomes/src/config.ts", "utf8"))).toMatch(/enabled: false/);
  });
});

describe("security and contracts", () => {
  it("every analytics endpoint is owner-scoped, needs an authenticated session and the analytics:read permission; none is registered as a route", () => {
    expect(ANALYTICS_ENDPOINTS.length).toBeGreaterThanOrEqual(11);
    for (const e of ANALYTICS_ENDPOINTS) { expect(e).toMatchObject({ method: "GET", permission: ANALYTICS_PERMISSION, auth: "SESSION_REQUIRED", ownerScoped: true }); expect(e.path).toMatch(/^\/analytics\//); }
    for (const f of ["apps/api/src/index.ts", "apps/api/src/liveApi.ts", "apps/api/src/intelligenceApi.ts", "apps/api/src/riskApi.ts"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/\/analytics\//);
  });
  it("responses carry the paper / live status and the notice; section views are pure projections", () => {
    const report = buildAnalyticsReport({ now: new Date(), minSample: 30, minDriftWindow: 30, records: [win()], decisions: [], packages: [], claimChannels: [], telegramCandidates: 0, independentStage: { candidates: 0, researched: 0, byState: {}, stateReasons: {}, scans: 0 }, hypothetical: new Map(), calibration: null });
    expect(report.modes.LIVE).toMatchObject({ status: "UNAVAILABLE" });
    for (const s of ["overview", "strategy", "channels", "independent", "agents", "decisionQuality", "drift", "dataQuality", "calibration"] as const) { const r = sectionOf(report, s); expect(r).toMatchObject({ contractVersion: "analytics-contract-v1", dataset: "PAPER", mode: "PAPER", liveStatus: "UNAVAILABLE" }); expect(r.notice).toMatch(/not a probability/); }
    expect(envelope(report, 1).data).toBe(1);
  });
  it("list queries are validated: unknown parameters, oversize limits and bad values are refused", () => {
    expect(parseListQuery({})).toEqual({ ok: true, limit: 50 }); expect(parseListQuery({ limit: "200", kind: "DRIFT", finality: "FINAL" })).toMatchObject({ ok: true, limit: 200, kind: "DRIFT", finality: "FINAL" });
    for (const q of [{ limit: "0" }, { limit: "201" }, { limit: "x" }, { finality: "DONE" }, { kind: "drop table" }, { userId: "someone-else" }]) expect(parseListQuery(q).ok, JSON.stringify(q)).toBe(false);
  });
  it("migration 0039: append-only, owner-only row-level security, paper-only, versioned corrections, bounded single-flight jobs", () => {
    const sql = readFileSync("packages/database/drizzle/0039_outcome_learning.sql", "utf8");
    for (const t of ["outcome_attributions", "learning_insights"]) { expect(sql).toContain(`"${t}_no_update_delete"`); expect(sql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`); expect(sql).toContain(`"${t}_owner_only"`); }
    expect(sql).toContain('"outcome_attributions_paper_only_check" CHECK ("mode" = \'PAPER\')'); expect(sql).toContain("a FINAL outcome cannot be replaced by a PARTIAL one"); expect(sql).toContain("a correction cannot change which position, decision, candidate, instrument, side or mode");
    expect(sql).toContain("outcome_attributions_final_check"); expect(sql).toContain("outcome_attributions_position_version_unique"); expect(sql).toContain("learning_job_runs_one_running"); expect(sql).toContain("a % job run is final");
    expect(sql).toContain("learning_insights_adequate_check"); expect(sql).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DELETE FROM/);
  });
});
