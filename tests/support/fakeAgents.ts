import { DEFAULT_AGENT_CONFIG, type AgentContext, type AgentContract, type AgentDefinition, type AgentEngineConfig, type AgentOutput, type AgentVerdict } from "../../packages/agents/src/index";

/** SYNTHETIC agents only: no real research agent exists, no LLM or network is used anywhere. */
export const contractOf = (id: string, over: Partial<AgentContract> = {}): AgentContract => ({
  agentId: id, agentName: `Fake ${id}`, version: "1.0.0", requiredInputs: ["risk_decision"], optionalInputs: [], outputSchema: { fields: { note: { type: "string" } } },
  timeoutMs: 1000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 50, canBlock: false, advisoryOnly: false, dependsOn: [], ...over,
});
export type Behavior = (ctx: AgentContext) => Promise<AgentOutput> | AgentOutput;
export const fakeAgent = (id: string, run: Behavior, over: Partial<AgentContract> = {}): AgentDefinition => ({ contract: contractOf(id, over), run: async (ctx) => run(ctx) });
export const answer = (verdict: AgentVerdict = "NEUTRAL", confidence = 80, extra: Partial<AgentOutput> = {}): Behavior => () => ({ verdict, confidence, findings: [], evidence: [], output: {}, ...extra });
export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const config = (over: Partial<AgentEngineConfig> = {}): AgentEngineConfig => ({ ...DEFAULT_AGENT_CONFIG, enabled: true, ...over });

export const INPUTS = {
  risk_decision: { id: "11111111-1111-4111-8111-111111111111", version: 2, status: "PENDING", instrumentType: "equity", market: "NSE", symbol: "ACME", side: "BUY", entryPrice: 100, stopLoss: 95, targets: [105, 110], createdAt: "2025-01-06T00:00:00.000Z" },
  source_intelligence: { status: "VALID", trust: { tier: "A" }, confidence: { tier: "MEDIUM", score: 50 } },
  stop_loss_validation: { result: "VALID", riskPct: 5 },
  signal_features: { market: "NSE", side: "BUY" },
} as const;
export const REF = { riskDecisionId: "11111111-1111-4111-8111-111111111111", decisionVersion: 2 };
