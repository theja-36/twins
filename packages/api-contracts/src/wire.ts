/**
 * Response shapes as the backend sends them over HTTP (JSON: a Date is an ISO-8601 string).
 * EVIDENCE for each shape is named in its comment; a field typed `unknown` is deliberately NOT guaranteed (see docs/frontend/contracts-verification.md for what would verify it).
 *
 * MONEY: values typed `DecimalString` are decimal strings; values typed `number` are numbers on the wire. The interface DISPLAYS both and never calculates with them
 * (no totals, P&L, R-multiples, sizing, exposure or validity checks in browser code).
 */
export type DecimalString = string;
export type IsoTimestamp = string;
export type Uuid = string;

/** GET /accounts (`listUserAccounts`, packages/database/src/stores/planningStore.ts:137). */
export interface AccountView { id: Uuid; name: string; tradingMode: string; baseCurrency: string; isActive: boolean }
export interface AccountsResponse { accounts: AccountView[] }

/** `StoredCapitalProfile` (planningStore.ts:15) with `effectiveFrom` serialised. */
export interface CapitalProfileView { id: Uuid; accountId: Uuid; version: number; totalCapital: DecimalString; availableCapital: DecimalString; maxPositionNotionalPct: DecimalString | null; currency: string; effectiveFrom: IsoTimestamp; createdBy: string }
/** GET /capital/profile?accountId (userApi.ts:81-86). `effective` is null when no profile is in force (the store returns null; exercised as null in tests/unit/api/userApi.test.ts is not asserted, so null is TYPED but UNVERIFIED by a test). */
export interface CapitalProfileResponse { accountId: Uuid; isolation: "PER_USER_ACCOUNT"; effective: CapitalProfileView | null; versions: CapitalProfileView[] }

/** `StoredRiskPolicy` (planningStore.ts:36-37). */
export interface RiskPolicyView { id: Uuid; accountId: Uuid; version: number; riskPercent: DecimalString; maxRiskPerTrade: DecimalString | null; maxDailyLoss: DecimalString; maxConcurrentPositions: number; maxLots: number; minRewardToRisk: DecimalString; allowedUnderlyings: string[]; maxDrawdownPct: DecimalString | null; maxPortfolioExposurePct: DecimalString | null; maxCorrelatedRiskPct: DecimalString | null; effectiveFrom: IsoTimestamp; createdBy: string }
/** GET /risk/policy?accountId (userApi.ts:87-91). */
export interface RiskPolicyResponse { accountId: Uuid; policy: RiskPolicyView | null }
/** `ActiveControlRow` (planningStore.ts:124; `ControlRef` at :112). GET /risk/controls (userApi.ts:98). */
export interface ActiveControlView { id: Uuid; userId: string | null; scope: "USER" | "MARKET" | "SOURCE" | "STRATEGY"; scopeKey: string | null; kind: "RESTRICTION" | "DAILY_LOSS_HALT" | "DRAWDOWN_HALT" | "KILL_SWITCH"; reason: string; setAt: string; expiresAt: string | null }
export interface RiskControlsResponse { controls: ActiveControlView[] }

/** `AccountPortfolioFacts` (planningStore.ts:144). Contains NO unrealised P&L, mark price or live balance: none exists in the backend. */
export interface PortfolioFacts { accountId: Uuid; openPositions: number; allocatedNotional: DecimalString; realizedPnl: DecimalString; totalCapital: DecimalString | null; availableCapital: DecimalString | null; unallocatedCapital: DecimalString | null; capitalProfileVersion: number | null }
/** GET /portfolio?accountId (userApi.ts:92-97). `facts` is typed nullable because the store can return null; the route passes it through verbatim. */
export interface PortfolioResponse { accountId: Uuid; mode: "PAPER"; isolation: "PER_USER_ACCOUNT"; facts: PortfolioFacts | null; notes: string[] }

/** `permittedSize` from the decision engine (packages/decision/src/engine.ts:29): strings for money, numbers for counts and ratios. */
export interface PermittedSize { lots: number; quantity: number; maxLossAtStop: DecimalString; riskPerLot: DecimalString; grossExposure: DecimalString; sizeMultiplier: number; binding: string }
/** `decisionView` (userApi.ts:45-49). Fields typed `unknown` are not guaranteed: their inner shape is not asserted by any contract test. */
export interface DecisionView {
  id: Uuid; accountId: Uuid; candidateId: Uuid; outcome: string; workflowState: string;
  explanation: unknown; stopLossValidation: unknown; permittedSize: PermittedSize | null; evidenceRefs: unknown; versions: unknown;
  validFrom: IsoTimestamp; validUntil: IsoTimestamp; supersedesId: Uuid | null; createdAt: IsoTimestamp;
  invalidated: { reasonCode: string; at: IsoTimestamp } | null; simulationId: unknown; riskAssessmentId: unknown;
}
export interface DecisionsResponse { decisions: DecisionView[] }
/** Pending items carry the server's verdict on expiry and on whether the action is available; the interface must follow it and never recompute it. */
export interface PendingApprovalView extends DecisionView { expired: boolean; action: { available: boolean } }
/** GET /approvals (userApi.ts:113-118). */
export interface ApprovalsResponse { pending: PendingApprovalView[]; history: DecisionView[] }
export interface DecisionEventView { fromState: string | null; toState: string; actor: string; reason: string | null; at: IsoTimestamp }
/** GET /decisions/:id (userApi.ts:107-112). `approval` is `{ action, at }` or null. */
export interface DecisionDetailResponse { decision: DecisionView; events: DecisionEventView[]; approval: { action: string; at: IsoTimestamp } | null; watching: boolean }
/** GET /decisions/:id/comparables (userApi.ts:134-139). The `comparables` body is not contract-guaranteed. */
export interface ComparablesResponse { decisionId: Uuid; comparables: unknown }

/** POST approve / reject -> 200 (userApi.ts:128-132 area): `status` is present only when the operation returned one. */
export interface ApprovalActionResponse { decisionId: Uuid; status?: string }
/** POST cancel -> 200. */
export interface CancelResponse { decisionId: Uuid; result: string }
/** POST watch / unwatch -> 200 (userApi.ts:140-146). A watch is a private bookmark and never an approval. */
export interface WatchResponse { decisionId: Uuid; status: "RECORDED" | "DUPLICATE"; watching: boolean; grantsApproval: false }

/** Request bodies (userApi.ts: `body(req, allowed, required)`); unknown keys are refused with 422. */
export interface ApproveRequest { idempotencyKey: string; reason?: string }
export type RejectRequest = ApproveRequest;
export interface CancelRequest { reason: string }
export type WatchRequest = ApproveRequest;
export interface LoginRequest { email: string; password: string }
export interface ChangePasswordRequest { currentPassword: string; newPassword: string }

/** `PaperOrderRow` (packages/database/src/stores/executionStore.ts:33), returned verbatim by GET /execution/orders. */
export interface PaperOrderView { id: Uuid; decisionId: Uuid; accountId: Uuid; positionId: Uuid | null; purpose: "ENTRY" | "EXIT"; exitReason: string | null; instrument: string; exchange: string; side: "BUY" | "SELL"; orderType: string; quantity: DecimalString; limitPrice: DecimalString | null; filledQuantity: DecimalString; avgFillPrice: DecimalString | null; status: string; stateReason: string | null; createdAt: IsoTimestamp }
export interface OrdersResponse { orders: PaperOrderView[] }
/** `listPaperFills` (executionStore.ts:82). */
export interface PaperFillView { id: Uuid; quantity: DecimalString; price: DecimalString; costs: DecimalString; priceSource: string; filledAt: IsoTimestamp }
export interface FillsResponse { fills: PaperFillView[] }
/** `PaperPositionRow` (executionStore.ts:86), returned verbatim by GET /execution/positions. */
export interface PaperPositionView { id: Uuid; userId: Uuid; accountId: Uuid; decisionId: Uuid; instrument: string; exchange: string; side: "BUY" | "SELL"; quantity: DecimalString; initialQuantity: DecimalString; avgEntryPrice: DecimalString; initialStop: DecimalString; stopLoss: DecimalString; targets: DecimalString[]; rules: Record<string, unknown>; realizedPnl: DecimalString; realizedCosts: DecimalString; status: "OPEN" | "CLOSED"; exitReason: string | null; openedAt: IsoTimestamp; closedAt: IsoTimestamp | null }
export interface PositionsResponse { positions: PaperPositionView[] }
/** `listPositionEvents` (executionStore.ts:175). `payload` is not contract-guaranteed. */
export interface PositionEventView { kind: string; payload: unknown; at: IsoTimestamp }
export interface PositionEventsResponse { events: PositionEventView[] }

/** GET /auth/me and the `user` of login (`PublicUser`, packages/auth/src/service.ts:14). A single role; NO permission list. */
export interface PublicUser { id: Uuid; email: string; displayName: string | null; role: "TRADER" | "ADMIN"; isActive: boolean }
export interface MeResponse { user: PublicUser }
/** POST /auth/login (authApi.ts:48-52). The BFF consumes `token`; it must never reach browser JavaScript. */
export interface LoginResponse { token: string; expiresAt: IsoTimestamp; user: PublicUser }
