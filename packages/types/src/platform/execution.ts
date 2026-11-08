/**
 * Execution gate (ADR-004). A pure function, so every refusal reason is testable. NOTHING in the master build enables live execution:
 * `liveExecutionEnabled` is an operator switch that stays false, and the repository's live-trading guard independently refuses any live configuration.
 */
export const EXECUTION_MODES = ["PAPER", "ASSISTED_LIVE", "CONTROLLED_AUTO"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export const isLiveMode = (m: ExecutionMode): boolean => m !== "PAPER";

export interface GateInput {
  mode: ExecutionMode;
  /** Operator-level switch for any real-money mode. Default false. */
  liveExecutionEnabled: boolean;
  paperEnabled: boolean;
  userPermitsMode: boolean;
  killSwitchActive: boolean;
  riskRecheckPassed: boolean;
  decisionState: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "SUPERSEDED" | "CANCELLED";
  decisionOutcome: "QUALIFIED" | "WAIT" | "REJECT" | "EVALUATION_ONLY" | "NO_TRADE";
  /** ASSISTED_LIVE: id of this user's explicit confirmation of THIS order. */
  orderConfirmationId: string | null;
  /** CONTROLLED_AUTO: id of the user-authorised policy that covers this order. */
  autoPolicyId: string | null;
  /** Broker sandbox/regulatory gates recorded as verified (live modes only). */
  brokerAndRegulatoryGatesVerified: boolean;
}
export type GateResult = { allowed: true; reasons: [] } | { allowed: false; reasons: string[] };

export function checkExecutionGate(g: GateInput): GateResult {
  const why: string[] = [];
  if (g.killSwitchActive) why.push("kill_switch_active");
  if (g.decisionOutcome !== "QUALIFIED") why.push("decision_not_qualified");
  if (g.decisionState !== "APPROVED") why.push("decision_not_approved");
  if (!g.riskRecheckPassed) why.push("risk_recheck_failed");
  if (!g.userPermitsMode) why.push("user_has_not_enabled_mode");
  if (g.mode === "PAPER") { if (!g.paperEnabled) why.push("paper_trading_disabled"); }
  else {
    if (!g.liveExecutionEnabled) why.push("live_execution_disabled");
    if (!g.brokerAndRegulatoryGatesVerified) why.push("broker_or_regulatory_gate_not_verified");
    if (g.mode === "ASSISTED_LIVE" && !g.orderConfirmationId) why.push("no_explicit_order_confirmation");
    if (g.mode === "CONTROLLED_AUTO" && !g.autoPolicyId) why.push("no_authorised_auto_policy");
  }
  return why.length === 0 ? { allowed: true, reasons: [] } : { allowed: false, reasons: why };
}
/** The safe default every new user and deployment starts from. */
export const DEFAULT_EXECUTION_PERMISSIONS = { PAPER: true, ASSISTED_LIVE: false, CONTROLLED_AUTO: false } as const satisfies Record<ExecutionMode, boolean>;
