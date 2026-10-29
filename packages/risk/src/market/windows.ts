import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { RiskDecisionError } from "../riskDecisions";
import type { EventWindow, EventWindowSource } from "./engine";

/**
 * Admin-defined event blackout windows (Stage 3 / Task 5), stored in the append-only, hash-chained `event_blackout_windows` table. A window is never edited or
 * deleted: a CANCELLATION row withdraws it. This is the manual source; a future calendar / news provider implements `EventWindowSource` instead. Nothing here
 * calls an external service. Recording or cancelling a window is an administrative action and is not blocked by the runtime controls.
 */
const ACTOR = /^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$/;
const CODE = /^[a-z][a-z0-9_]{2,60}$/;
const MARKET = /^[A-Z0-9]{2,20}$/;
const SYMBOL = /^[A-Z0-9&-]{1,30}$/;
const MAX_WINDOW_MS = 31 * 86_400_000;

export interface EventWindowInput {
  /** Market code (NSE, NYSE, TSE, ...) or ALL. */
  market: string;
  scope: "MARKET" | "SYMBOL";
  scopeValue?: string | null;
  severity: "WARNING" | "CRITICAL";
  startsAt: Date;
  endsAt: Date;
  reasonCode: string;
  reason?: string | null;
  createdBy: string;
  idempotencyKey?: string;
}

function validate(i: EventWindowInput): void {
  if (!MARKET.test(i.market)) throw new RiskDecisionError("invalid_input", "market must be an upper-case market code or ALL");
  if (i.scope !== "MARKET" && i.scope !== "SYMBOL") throw new RiskDecisionError("invalid_input", "scope must be MARKET or SYMBOL");
  if (i.scope === "SYMBOL" ? !i.scopeValue || !SYMBOL.test(i.scopeValue) : i.scopeValue != null) throw new RiskDecisionError("invalid_input", "scopeValue is required (and only allowed) for scope SYMBOL");
  if (i.severity !== "WARNING" && i.severity !== "CRITICAL") throw new RiskDecisionError("invalid_input", "severity must be WARNING or CRITICAL");
  if (!(i.startsAt instanceof Date) || !(i.endsAt instanceof Date) || Number.isNaN(i.startsAt.getTime()) || Number.isNaN(i.endsAt.getTime()) || !(i.endsAt.getTime() > i.startsAt.getTime())) throw new RiskDecisionError("invalid_input", "endsAt must be after startsAt");
  if (i.endsAt.getTime() - i.startsAt.getTime() > MAX_WINDOW_MS) throw new RiskDecisionError("invalid_input", "a blackout window may not exceed 31 days");
  if (!CODE.test(i.reasonCode)) throw new RiskDecisionError("invalid_input", "reasonCode must be a snake_case code");
  if (!ACTOR.test(i.createdBy)) throw new RiskDecisionError("invalid_input", "createdBy must be service:<name> or operator:<name>");
}

async function insert(db: Db, v: typeof schema.eventBlackoutWindows.$inferInsert): Promise<{ id: string; created: boolean }> {
  try {
    const [row] = await db.insert(schema.eventBlackoutWindows).values(v).onConflictDoNothing({ target: schema.eventBlackoutWindows.idempotencyKey }).returning({ id: schema.eventBlackoutWindows.id });
    if (row) return { id: row.id, created: true };
    const [existing] = await db.select().from(schema.eventBlackoutWindows).where(eq(schema.eventBlackoutWindows.idempotencyKey, v.idempotencyKey));
    if (!existing || existing.entryType !== v.entryType || existing.market !== v.market || existing.reasonCode !== v.reasonCode || existing.startsAt.getTime() !== (v.startsAt as Date).getTime() || existing.endsAt.getTime() !== (v.endsAt as Date).getTime()) throw new RiskDecisionError("idempotency_conflict", "that idempotency key was used for a different blackout entry");
    return { id: existing.id, created: false };
  } catch (error) {
    if (error instanceof RiskDecisionError) throw error;
    const pg = ((error as { cause?: unknown } | null)?.cause ?? error) as { code?: string } | null;
    if (pg?.code === "23505") throw new RiskDecisionError("idempotency_conflict", "that blackout window is already cancelled or recorded", undefined, error);
    if (pg?.code === "23514" || pg?.code === "23503") throw new RiskDecisionError("invalid_input", "the database refused the blackout entry (integrity rule)", undefined, error);
    throw new RiskDecisionError("store_failure", "the blackout entry could not be stored", undefined, error);
  }
}

export async function addEventWindow(db: Db, input: EventWindowInput): Promise<{ id: string; created: boolean }> {
  validate(input);
  const key = input.idempotencyKey ?? `blackout:${input.market}:${input.scope}:${input.scopeValue ?? "-"}:${input.severity}:${input.startsAt.toISOString()}:${input.endsAt.toISOString()}:${input.reasonCode}`;
  return insert(db, { entryType: "WINDOW", market: input.market, scope: input.scope, scopeValue: input.scopeValue ?? null, severity: input.severity, startsAt: input.startsAt, endsAt: input.endsAt, reasonCode: input.reasonCode, reason: input.reason ?? null, idempotencyKey: key, createdBy: input.createdBy });
}

/** Withdraws a window by appending a CANCELLATION row that describes it. Idempotent. */
export async function cancelEventWindow(db: Db, windowId: string, by: { createdBy: string; reason?: string }): Promise<{ id: string; created: boolean }> {
  if (!ACTOR.test(by.createdBy)) throw new RiskDecisionError("invalid_input", "createdBy must be service:<name> or operator:<name>");
  const [w] = await db.select().from(schema.eventBlackoutWindows).where(and(eq(schema.eventBlackoutWindows.id, windowId), eq(schema.eventBlackoutWindows.entryType, "WINDOW")));
  if (!w) throw new RiskDecisionError("not_found", "the blackout window does not exist");
  return insert(db, { entryType: "CANCELLATION", market: w.market, scope: w.scope, scopeValue: w.scopeValue, severity: w.severity, startsAt: w.startsAt, endsAt: w.endsAt, reasonCode: w.reasonCode, reason: by.reason ?? null, cancelsId: w.id, idempotencyKey: `blackout-cancel:${w.id}`, createdBy: by.createdBy });
}

export interface ListedWindow extends EventWindow { cancelled: boolean; createdBy: string; createdAt: Date; reason: string | null }

export async function listEventWindows(db: Db, opts: { at?: Date; includeCancelled?: boolean; limit?: number } = {}): Promise<ListedWindow[]> {
  const at = opts.at ? opts.at.toISOString() : null;
  const r = await db.execute(sql`select w.*, exists (select 1 from event_blackout_windows c where c.cancels_id = w.id) as cancelled from event_blackout_windows w
    where w.entry_type = 'WINDOW' and (${at}::timestamptz is null or (w.starts_at <= ${at}::timestamptz and ${at}::timestamptz < w.ends_at))
    order by w.chain_index desc limit ${Math.min(Math.max(opts.limit ?? 100, 1), 1000)}`);
  const rows = (r.rows as Array<Record<string, unknown>>).map((x) => ({
    id: String(x["id"]), market: String(x["market"]), scope: String(x["scope"]) as "MARKET" | "SYMBOL", scopeValue: (x["scope_value"] as string | null) ?? null, severity: String(x["severity"]) as "WARNING" | "CRITICAL",
    startsAt: new Date(x["starts_at"] as string), endsAt: new Date(x["ends_at"] as string), reasonCode: String(x["reason_code"]), reason: (x["reason"] as string | null) ?? null, cancelled: x["cancelled"] === true, createdBy: String(x["created_by"]), createdAt: new Date(x["created_at"] as string),
  }));
  return opts.includeCancelled ? rows : rows.filter((w) => !w.cancelled);
}

/** The manual (database-backed) source: active, un-cancelled windows for a market and symbol at an instant. */
export const databaseEventWindows = (db: Db): EventWindowSource => ({
  async listWindows(q) {
    const windows = await listEventWindows(db, { at: q.at, limit: 1000 });
    return windows.filter((w) => (w.market === "ALL" || w.market === q.market.toUpperCase()) && (w.scope === "MARKET" || (w.scopeValue ?? "").toUpperCase() === q.symbol.toUpperCase()));
  },
});
