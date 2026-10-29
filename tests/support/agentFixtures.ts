import { orchestrate, AgentRegistry, type AgentDefinition, type AgentEvent, type AgentRunResult } from "../../packages/agents/src/index";
import { config } from "./fakeAgents";

/** SYNTHETIC inputs for the Task 2 agents (parsed fields only - no message text exists in these fixtures). */
export const NOW = new Date("2025-01-06T04:05:00.000Z");
export const SIGNAL_TIME = "2025-01-06T04:00:00.000Z"; // 5 minutes before NOW

type Obj = Record<string, unknown>;
export interface InputOverrides { rd?: Obj; slv?: Obj | null; sf?: Obj; sc?: Obj; rev?: Obj; si?: Obj | null }
/** Inputs of a clean, fresh equity BUY signal; each override is merged into its section (a section set to null is absent). */
export function inputs(o: InputOverrides = {}): Record<string, unknown> {
  return {
    risk_decision: { id: "11111111-1111-4111-8111-111111111111", version: 2, status: "PENDING", instrumentType: "equity", market: "NSE", symbol: "ACME", side: "BUY", entryPrice: 100, stopLoss: 95, stopLossBasis: "price", targets: [105, 110, 115], expiry: null, strike: null, optionType: null, createdAt: SIGNAL_TIME, ...o.rd },
    stop_loss_validation: o.slv === null ? null : { id: "22222222-2222-4222-8222-222222222222", result: "VALID", reasonCode: null, riskPct: 5, ...o.slv },
    signal_features: { market: "NSE", side: "BUY", instrumentType: "EQUITY", stopDistance: "5_10PCT", rewardRisk: "1_2", ...o.sf },
    signal_context: { subject: "signal", signalTimestamp: SIGNAL_TIME, messageLinked: true, revision: { known: true, otherVersions: 0, state: "current", anyAmbiguous: false, levelsChanged: false, ...o.rev }, entryType: "at", parserVersion: "x", ...o.sc },
    source_intelligence: o.si === null ? null : { status: "VALID", reasonCode: "OK", trust: { tier: "A", scorecardRunId: "33333333-3333-4333-8333-333333333333" }, confidence: { tier: "MEDIUM", score: 50 }, asOf: SIGNAL_TIME, ...o.si },
  };
}
/** A clean option decision: NIFTY 24500 CE expiring 2025-01-30. */
export const optionInputs = (o: InputOverrides = {}): Record<string, unknown> => inputs({ ...o, rd: { instrumentType: "option", symbol: "NIFTY", expiry: "2025-01-30", strike: 24500, optionType: "CE", entryPrice: 120, stopLoss: 90, targets: [150, 180], ...o.rd }, sf: { instrumentType: "OPTION", ...o.sf } });

/** Runs one or more agents through the REAL orchestrator (contract validation, output validation, timeouts, retries) at a fixed clock. */
export async function evalAgents(defs: AgentDefinition[], inp: Record<string, unknown>, over: Parameters<typeof config>[0] = {}, events: AgentEvent[] = [], now: Date = NOW) {
  const r = new AgentRegistry();
  for (const d of defs) r.register(d);
  const cfg = config(over);
  const out = await orchestrate(r.resolve(cfg), cfg, inp as never, { riskDecisionId: "11111111-1111-4111-8111-111111111111", decisionVersion: 2 }, { emit: (e) => events.push(e), now: () => now, sleep: async () => undefined });
  return { ...out, byId: (id: string): AgentRunResult => out.results.find((x) => x.agentId === id) as AgentRunResult };
}
export const codesOf = (r: AgentRunResult): string[] => r.findings.map((f) => f.code);
