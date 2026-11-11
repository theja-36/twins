/**
 * Harness for the api-contracts parity tests: the REAL auth and user routes on a Fastify instance with an in-memory auth store and a fake data layer.
 * The fake layer is keyed by user id exactly like the SQL stores, returns synthetic data only, and records nothing outside memory.
 */
import Fastify from "fastify";
import { AuthService, memoryAuthStore } from "@twins/auth";
import { ApprovalError } from "@twins/decision";
import { registerAuthRoutes } from "../../apps/api/src/authApi";
import { registerUserRoutes } from "../../apps/api/src/userApi";
import type { UserOps } from "../../apps/api/src/userOps";

export const PW = "correct horse battery staple";
export const NOW = new Date("2031-01-06T05:00:00Z");
export const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ACCOUNT = ID(900), DECISION = ID(1);

const decisionRow = (userId: string) => ({ id: DECISION, userId, accountId: ACCOUNT, candidateId: ID(500), outcome: "QUALIFIED", workflowState: "PENDING", confidenceAssessmentId: null, riskAssessmentId: null, simulationId: null, explanation: { summary: "synthetic" }, stopLossValidation: { status: "VALID" }, permittedSize: { lots: 28, quantity: 700, maxLossAtStop: "10010.00", riskPerLot: "357.50", grossExposure: "428715.00", sizeMultiplier: 1, binding: "risk_percent" }, evidenceRefs: [], versions: { riskPolicy: 3 }, validFrom: NOW, validUntil: new Date(NOW.getTime() + 3_600_000), supersedesId: null, createdAt: NOW, invalidated: null });
const snapshot = (stale: boolean) => ({ id: "snap-1", asOf: NOW.toISOString(), createdAt: NOW.toISOString(), verifiedAt: NOW.toISOString(), evidenceHash: "e".repeat(64), inputHash: "a".repeat(64), configHash: "c".repeat(64), algorithmVersions: { snapshot: "analytics-snapshot-v1" }, createdBy: "API", freshness: stale ? "STALE" : "CURRENT", staleReason: stale ? "the current evidence could not be analysed" : null, complete: true, maxAgeSeconds: 3600 });

export interface Behaviour { approveError?: { code: "NOT_FOUND" | "NOT_PENDING" | "NOT_QUALIFIED" | "EXPIRED" | "REVALIDATION_FAILED" | "ALREADY_ACTIONED" | "NOT_PERMITTED"; failedChecks?: string[] }; stale?: boolean; records?: number; partial?: number }

export function fakeOps(userIdOf: () => string[], b: Behaviour = {}): UserOps {
  const approve = async (): Promise<unknown> => {
    if (b.approveError) throw new ApprovalError(b.approveError.code, "synthetic", b.approveError.failedChecks ? ({ checks: b.approveError.failedChecks.map((name) => ({ name, ok: false })) } as never) : undefined);
    return { status: "APPROVED" };
  };
  const ops = {
    async accounts() { return [{ id: ACCOUNT, name: "paper account", tradingMode: "paper", baseCurrency: "INR", isActive: true }]; },
    async listDecisions(u: string) { userIdOf().push(u); return [decisionRow(u)]; },
    async getDecision(u: string) { return decisionRow(u); },
    async decisionEvents() { return [{ fromState: null, toState: "PENDING", actor: "system", reason: null, at: NOW }]; },
    async approvalOf() { return null; }, approve, reject: approve,
    async cancel() { return "CANCELLED"; },
    async watch() { return { status: "RECORDED", watching: true }; }, async watched() { return false; },
    async comparables() { return { state: "NOT_AVAILABLE" }; },
    async capital() { return { effective: { id: ID(2), accountId: ACCOUNT, version: 1, totalCapital: "1000000.00", availableCapital: "900000.00", maxPositionNotionalPct: null, currency: "INR", effectiveFrom: NOW, createdBy: "t" }, versions: [] }; },
    async riskPolicy() { return null; }, async controls() { return []; },
    async orders() { return []; }, async fills() { return []; }, async positions() { return []; }, async positionEvents() { return []; },
    async portfolio() { return { accountId: ACCOUNT, openPositions: 3, allocatedNotional: "1100920.00", realizedPnl: "3810.00", totalCapital: "1000000.00", availableCapital: "900000.00", unallocatedCapital: "0.00", capitalProfileVersion: 1 }; },
    async analytics() {
      const n = b.records ?? 1;
      return { report: { generatedAt: NOW.toISOString(), modes: { PAPER: { overview: { x: 1 }, validatedOnly: {}, fixtureOnly: {}, strategy: { byConfidenceBand: [], bySignalPattern: { status: "NOT_AVAILABLE" } }, telegram: {}, independent: {}, agents: {}, decisionQuality: {} } }, drift: {}, dataQuality: { partial: b.partial ?? 0, records: n }, calibration: {} } as never, snapshot: snapshot(b.stale === true) as never };
    },
    async outcomes() { return []; }, async insights() { return []; },
  };
  return ops as unknown as UserOps;
}

export async function build(b: Behaviour = {}) {
  const store = memoryAuthStore(), seen: string[] = [];
  const auth = new AuthService({ store, audit: async () => undefined, config: { scrypt: { N: 2 ** 10, r: 8, p: 1 }, registrationOpen: true, sessionIdleSeconds: 3600 } });
  const app = Fastify(); registerAuthRoutes(app, { auth }); registerUserRoutes(app, { auth, ops: fakeOps(() => seen, b), now: () => NOW });
  const trader = async (email = "trader@example.com") => { const u = await auth.register({ email, password: PW }); const l = await auth.login({ email, password: PW }); return { id: u.id as string, token: l.token }; };
  const admin = async (email = "admin@example.com") => { const u = await auth.bootstrapAdmin({ email, password: PW }); const l = await auth.login({ email, password: PW }); return { id: u.id as string, token: l.token }; };
  const call = (method: "GET" | "POST", url: string, token?: string, payload?: unknown) => app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { app, auth, call, trader, admin, seen };
}
