import type { CorrelationId, UserId } from "./ids";

/** Domain event catalogue (ADR-006). Names are stable contracts; payload shapes are versioned by `version`. */
export const EVENT_TYPES = [
  "signal.received", "signal.revised", "signal.deleted", "signal.parsed", "signal.classified",
  "opportunity.candidate_created", "opportunity.candidate_expired", "opportunity.revalidated",
  "research.requested", "research.agent_completed", "research.synthesized",
  "regime.updated", "confidence.assessed", "risk.assessed", "simulation.completed",
  "decision.created", "decision.state_changed", "approval.requested", "approval.recorded",
  "execution.order_proposed", "execution.order_submitted", "execution.order_filled", "execution.refused",
  "trade.exit_triggered", "trade.closed", "outcome.recorded", "learning.version_proposed", "learning.version_activated", "learning.drift_detected",
  "killswitch.changed", "user.settings_changed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
/** Events about shared platform intelligence carry no user; everything else is private to one user. */
const SHARED = new Set<EventType>(["signal.received", "signal.revised", "signal.deleted", "signal.parsed", "signal.classified", "opportunity.candidate_created", "opportunity.candidate_expired", "research.agent_completed", "research.synthesized", "regime.updated", "learning.drift_detected"]);
export const isSharedEvent = (t: EventType): boolean => SHARED.has(t);

export interface EventEnvelope<T = unknown> {
  id: string; type: EventType; version: number; occurredAt: string; correlationId: CorrelationId; causationId: string | null;
  /** `null` only for shared platform intelligence. */
  userId: UserId | null; payload: T;
}
export interface EnvelopeDeps { newId: () => string; now: () => Date }
/** Builds an envelope and enforces the user-scoping rule: private events must name a user, shared events must not. */
export function buildEnvelope<T>(deps: EnvelopeDeps, type: EventType, o: { correlationId: CorrelationId; causationId?: string | null; userId?: UserId | null; version?: number; payload: T }): EventEnvelope<T> {
  const shared = isSharedEvent(type);
  if (shared && o.userId) throw new TypeError(`${type} is shared platform intelligence and must not carry a userId`);
  if (!shared && !o.userId) throw new TypeError(`${type} is user-private and must carry a userId`);
  return { id: deps.newId(), type, version: o.version ?? 1, occurredAt: deps.now().toISOString(), correlationId: o.correlationId, causationId: o.causationId ?? null, userId: o.userId ?? null, payload: o.payload };
}
