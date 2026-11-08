import {
  getApproval, getDecision, getEffectiveCapitalProfile, getEffectiveRiskPolicy, latestAttributions, listActiveControls, listCapitalProfileVersions, listDecisionEvents, listDecisions, listInsights, listPaperFills, listPaperOrders, listPaperPositions, listUserAccounts, listPositionEvents,
  type Db,
} from "@twins/database";
import { ApprovalError, approveDecision, cancelDecision, rejectDecision } from "@twins/decision";
import { paperPortfolioProvider } from "@twins/execution";
import { DEFAULT_OUTCOME_LEARNING, analyzeUser, type AnalyticsReport } from "@twins/outcomes";
import { fileSpecProvider, memorySpecProvider } from "@twins/planning";

/**
 * The data operations behind the session-protected user routes. EVERY function takes the userId of the VERIFIED SESSION as its first argument and passes it to a store that filters on it and runs under row-level security
 * (withUser). No function reads a user id from a request. The interface exists so the routes can be tested with fakes and so the SQL-backed implementation is one small, auditable file.
 */
type Decisions = Awaited<ReturnType<typeof listDecisions>>;
export interface UserOps {
  accounts(userId: string): Promise<Awaited<ReturnType<typeof listUserAccounts>>>;
  listDecisions(userId: string, o: { accountId?: string; states?: readonly string[]; limit: number }): Promise<Decisions>;
  getDecision(userId: string, id: string): Promise<Awaited<ReturnType<typeof getDecision>>>;
  decisionEvents(userId: string, id: string): Promise<Awaited<ReturnType<typeof listDecisionEvents>>>;
  approvalOf(userId: string, id: string): Promise<Awaited<ReturnType<typeof getApproval>>>;
  approve(userId: string, o: { decisionId: string; idempotencyKey: string; reason?: string }): Promise<unknown>;
  reject(userId: string, o: { decisionId: string; idempotencyKey: string; reason?: string }): Promise<unknown>;
  cancel(userId: string, o: { decisionId: string; reason: string }): Promise<string>;
  capital(userId: string, accountId: string, now: Date): Promise<{ effective: Awaited<ReturnType<typeof getEffectiveCapitalProfile>>; versions: Awaited<ReturnType<typeof listCapitalProfileVersions>> }>;
  riskPolicy(userId: string, accountId: string, now: Date): Promise<Awaited<ReturnType<typeof getEffectiveRiskPolicy>>>;
  controls(userId: string, now: Date): Promise<Awaited<ReturnType<typeof listActiveControls>>>;
  orders(userId: string, o: { decisionId?: string; statuses?: readonly string[]; limit: number }): Promise<Awaited<ReturnType<typeof listPaperOrders>>>;
  fills(userId: string, orderId: string): Promise<Awaited<ReturnType<typeof listPaperFills>>>;
  positions(userId: string, o: { status?: "OPEN" | "CLOSED"; limit: number }): Promise<Awaited<ReturnType<typeof listPaperPositions>>>;
  positionEvents(userId: string, positionId: string): Promise<Awaited<ReturnType<typeof listPositionEvents>>>;
  analytics(userId: string, now: Date): Promise<{ report: AnalyticsReport; records: Awaited<ReturnType<typeof latestAttributions>> }>;
  insights(userId: string, o: { kind?: string; limit: number }): Promise<Awaited<ReturnType<typeof listInsights>>>;
}

export function buildUserOps(db: Db, env: NodeJS.ProcessEnv = process.env): UserOps {
  const specs = env["TWINS_SPECS_FILE"] ? fileSpecProvider(env["TWINS_SPECS_FILE"]) : memorySpecProvider({ name: "no-specs", instruments: [], fees: [] });
  const evalDeps = { db, specs, regime: null, portfolio: paperPortfolioProvider(db), quotes: null, strategy: null };
  return {
    accounts: (u) => listUserAccounts(db, u),
    listDecisions: (u, o) => listDecisions(db, u, o),
    getDecision: (u, id) => getDecision(db, u, id),
    decisionEvents: (u, id) => listDecisionEvents(db, u, id),
    approvalOf: (u, id) => getApproval(db, u, id),
    approve: (u, o) => approveDecision(evalDeps, { userId: u, ...o }),
    reject: (u, o) => rejectDecision(evalDeps, { userId: u, ...o }),
    cancel: (u, o) => cancelDecision(evalDeps, { userId: u, decisionId: o.decisionId, reason: o.reason, actor: "user" }),
    capital: async (u, accountId, now) => ({ effective: await getEffectiveCapitalProfile(db, u, accountId, now), versions: await listCapitalProfileVersions(db, u, accountId) }),
    riskPolicy: (u, accountId, now) => getEffectiveRiskPolicy(db, u, accountId, now),
    controls: (u, now) => listActiveControls(db, u, now),
    orders: (u, o) => listPaperOrders(db, u, o),
    fills: (u, orderId) => listPaperFills(db, u, orderId),
    positions: (u, o) => listPaperPositions(db, u, o),
    positionEvents: (u, id) => listPositionEvents(db, u, id),
    analytics: async (u, now) => { const r = await analyzeUser({ db, config: DEFAULT_OUTCOME_LEARNING }, u, now); return { report: r.report, records: r.records }; },
    insights: (u, o) => listInsights(db, u, o),
  };
}
export { ApprovalError };
