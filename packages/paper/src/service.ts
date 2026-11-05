import { randomUUID } from "node:crypto";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { getRiskDecision, intelligenceOf, latestResearchAssessment, refuseUnlessSafe, type RiskDecisionRecord } from "@twins/risk";
import { assertPaperOnly, type PaperConfig } from "./config";
import { computeStats, toOutcome, type OutcomeContext, type OutcomeStats, type TradeOutcome } from "./learning";
import { createTrade, exitNow, expirePending, PaperTradeError, step } from "./manager";
import { positionView, summarize, type PnlSummary, type PositionView } from "./pnl";
import type { PriceSource } from "./prices";
import type { PaperTrade, TradeEvent } from "./types";

/**
 * The paper cycle: (1) turn newly APPROVED risk decisions into pending paper trades, (2) step every live paper trade with the latest price, (3) square off at the session end,
 * (4) record one immutable outcome per closed trade. SIMULATION ONLY: it reads risk decisions and approvals, writes only `paper_*` tables, makes no network call, touches
 * no broker and no `orders` / `fills` / `positions` row. It refuses to run unless TWINS_PAPER_TRADING_ENABLED is true, the live-trading guard passes and the kill switch is clear.
 */
export interface CycleDeps { config: PaperConfig; prices: PriceSource; now?: () => Date; env?: Record<string, string | undefined> }
export interface CycleResult {
  skipped?: "PAPER_DISABLED"; created: number; invalid: number; stepped: number; noPrice: number; stalePrice: number; closed: number; cancelled: number; squaredOff: number; events: number;
}
const empty = (): CycleResult => ({ created: 0, invalid: 0, stepped: 0, noPrice: 0, stalePrice: 0, closed: 0, cancelled: 0, squaredOff: 0, events: 0 });

const istMinutes = (d: Date): number => { const m = (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440; return m; };
const num = (x: string | null): number | null => { if (x === null) return null; const n = Number(x); return Number.isFinite(n) ? n : null; };

/** Decisions with a human APPROVE that are still current (not superseded), whose approval has not lapsed, and that have no paper trade yet. */
async function approvedWithoutTrade(db: Db, nowIso: string): Promise<string[]> {
  const r = await db.execute(sql`
    select a.risk_decision_id as id from risk_approvals a
    left join paper_trades p on p.risk_decision_id = a.risk_decision_id
    where a.action = 'APPROVE' and p.id is null and (a.valid_until is null or a.valid_until > ${nowIso}::timestamptz)
    order by a.created_at asc limit 50`);
  return (r.rows as Array<{ id: string }>).map((x) => x.id);
}

export function tradeFromDecision(d: RiskDecisionRecord, nowIso: string): { trade: PaperTrade; events: TradeEvent[] } {
  if (d.effectiveStatus !== "APPROVED_FOR_REVIEW") throw new PaperTradeError("decision_not_current");
  const entry = num(d.entryPrice), stop = num(d.stopLoss), qty = num(d.plannedQuantity);
  const targets = [d.target1, d.target2, d.target3].map(num).filter((x): x is number => x !== null);
  if (d.side !== "BUY" && d.side !== "SELL") throw new PaperTradeError("side");
  if (entry === null || stop === null || qty === null) throw new PaperTradeError("missing_levels");
  return createTrade({ id: randomUUID(), riskDecisionId: d.id, symbol: d.symbol, side: d.side, quantity: qty, entryPrice: entry, stop, targets, now: nowIso });
}

async function contextOf(db: Db, d: RiskDecisionRecord): Promise<OutcomeContext> {
  let assessment: string | null = null;
  try { assessment = (await latestResearchAssessment(db, { signalId: d.signalId, optionsClaimId: d.optionsClaimId, decisionVersion: d.decisionVersion }))?.assessment ?? null; } catch { assessment = null; }
  const tier = (() => { try { return (intelligenceOf(d) as { trustTier?: unknown } | null)?.trustTier; } catch { return null; } })();
  return { sourceTrustTier: typeof tier === "string" ? tier : d.sourceTrustTier, confidenceScore: num(d.confidenceScore), researchAssessment: assessment };
}

async function persist(db: Db, before: PaperTrade, after: PaperTrade, events: TradeEvent[], price: { price: number; at: string } | null, outcomeCtx: () => Promise<OutcomeContext>): Promise<void> {
  if (after === before && events.length === 0 && price === null) return;
  const ctx = after.state === "CLOSED" ? await outcomeCtx() : null;
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const P = schema.paperTrades;
    await tx.update(P).set({ state: after.state, trade: after, ...(price ? { lastPrice: String(price.price), lastPriceAt: new Date(price.at) } : {}), updatedAt: new Date() }).where(eq(P.id, after.id));
    if (events.length) {
      const [{ n } = { n: 0 }] = (await tx.execute(sql`select coalesce(max(seq), 0)::int as n from paper_trade_events where trade_id = ${after.id}`)).rows as Array<{ n: number }>;
      let seq = Number(n);
      for (const e of events) await tx.insert(schema.paperTradeEvents).values({ tradeId: after.id, seq: ++seq, type: e.type, at: new Date(e.at), price: e.price === null ? null : String(e.price), quantity: e.quantity === null ? null : String(e.quantity), detail: e.detail });
    }
    if (ctx) {
      const o = toOutcome(after, ctx);
      if (o) await tx.insert(schema.paperOutcomes).values({ tradeId: after.id, outcome: o.outcome, rMultiple: String(o.rMultiple), pnl: String(o.pnl), closeReason: o.closeReason, closedAt: new Date(o.closedAt), record: o }).onConflictDoNothing();
    }
  });
}

export async function runPaperCycle(db: Db, deps: CycleDeps): Promise<CycleResult> {
  const out = empty();
  const { config } = deps;
  if (!config.enabled) return { ...out, skipped: "PAPER_DISABLED" };
  assertPaperOnly(deps.env);
  await refuseUnlessSafe("paper.cycle"); // kill switch / unreadable state: fail closed before anything is read or written
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();

  for (const id of await approvedWithoutTrade(db, nowIso)) {
    const d = await getRiskDecision(db, id);
    if (!d) { out.invalid += 1; continue; }
    try {
      const { trade, events } = tradeFromDecision(d, nowIso);
      await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const [ins] = await tx.insert(schema.paperTrades).values({ id: trade.id, riskDecisionId: d.id, symbol: trade.symbol, side: trade.side, state: trade.state, trade }).onConflictDoNothing().returning({ id: schema.paperTrades.id });
        if (ins) { let seq = 0; for (const e of events) await tx.insert(schema.paperTradeEvents).values({ tradeId: trade.id, seq: ++seq, type: e.type, at: new Date(e.at), price: e.price === null ? null : String(e.price), quantity: e.quantity === null ? null : String(e.quantity), detail: e.detail }); out.created += 1; out.events += events.length; }
      });
    } catch (e) {
      if (e instanceof PaperTradeError) out.invalid += 1; else throw e;
    }
  }

  const live = await db.select().from(schema.paperTrades).where(inArray(schema.paperTrades.state, ["PENDING_ENTRY", "OPEN"]));
  const squareOff = config.squareOffIstMinutes !== null && istMinutes(now) >= config.squareOffIstMinutes;
  for (const row of live) {
    const before = row.trade as PaperTrade;
    const p = await deps.prices.last(before.symbol);
    const fresh = p !== null && now.getTime() - Date.parse(p.at) <= config.maxPriceAgeSeconds * 1000 && Date.parse(p.at) - now.getTime() < 60_000;
    if (p === null) out.noPrice += 1; else if (!fresh) out.stalePrice += 1;
    let after = before, events: TradeEvent[] = [];
    if (squareOff) {
      const last = p ?? (row.lastPrice !== null && row.lastPriceAt !== null ? { price: Number(row.lastPrice), at: row.lastPriceAt.toISOString() } : null);
      const tick = last ? { price: last.price, at: nowIso } : null;
      if (before.state === "OPEN" && tick) { ({ trade: after, events } = exitNow(before, tick, config, "SQUARE_OFF")); out.squaredOff += 1; }
      else if (before.state === "PENDING_ENTRY") { ({ trade: after, events } = exitNow(before, { price: before.entryPrice, at: nowIso }, config, "SQUARE_OFF")); }
      // an OPEN trade with no price at all stays open until a price exists: nothing is guessed
    } else if (p && fresh) {
      ({ trade: after, events } = step(before, p, config)); out.stepped += 1;
    } else {
      ({ trade: after, events } = expirePending(before, nowIso, config));
    }
    if (after.state === "CLOSED" && before.state !== "CLOSED") out.closed += 1;
    if (after.state === "CANCELLED" && before.state !== "CANCELLED") out.cancelled += 1;
    out.events += events.length;
    await persist(db, before, after, events, p && fresh ? p : null, async () => { const d = await getRiskDecision(db, after.riskDecisionId); return d ? contextOf(db, d) : { sourceTrustTier: null, confidenceScore: null, researchAssessment: null }; });
  }
  return out;
}

// ─── read models (used by the API) ────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function listPaperPositions(db: Db, prices: PriceSource, opts: { state?: PaperTrade["state"]; limit?: number } = {}): Promise<PositionView[]> {
  const P = schema.paperTrades;
  const rows = await (opts.state ? db.select().from(P).where(eq(P.state, opts.state)) : db.select().from(P)).orderBy(desc(P.createdAt)).limit(Math.min(opts.limit ?? 100, 500));
  return Promise.all(rows.map(async (r) => positionView(r.trade as PaperTrade, (await prices.last((r.trade as PaperTrade).symbol))?.price ?? (r.lastPrice === null ? null : Number(r.lastPrice)))));
}
export async function paperSummary(db: Db, prices: PriceSource): Promise<PnlSummary> {
  const rows = await db.select().from(schema.paperTrades);
  const cache = new Map<string, number | null>();
  for (const r of rows) { const s = (r.trade as PaperTrade).symbol; if (!cache.has(s)) cache.set(s, (await prices.last(s))?.price ?? (r.lastPrice === null ? null : Number(r.lastPrice))); }
  return summarize(rows.map((r) => r.trade as PaperTrade), (s) => cache.get(s) ?? null);
}
export async function listPaperEvents(db: Db, tradeId: string, limit = 200): Promise<Array<{ seq: number; type: string; at: string; price: number | null; quantity: number | null; detail: unknown }>> {
  const E = schema.paperTradeEvents;
  const rows = await db.select().from(E).where(eq(E.tradeId, tradeId)).orderBy(E.seq).limit(Math.min(limit, 500));
  return rows.map((r) => ({ seq: r.seq, type: r.type, at: r.at.toISOString(), price: r.price === null ? null : Number(r.price), quantity: r.quantity === null ? null : Number(r.quantity), detail: r.detail }));
}
export async function listPaperOutcomes(db: Db, limit = 100): Promise<TradeOutcome[]> {
  const rows = await db.select().from(schema.paperOutcomes).orderBy(desc(schema.paperOutcomes.closedAt)).limit(Math.min(limit, 1000));
  return rows.map((r) => r.record as TradeOutcome);
}
export async function paperOutcomeStats(db: Db): Promise<OutcomeStats> {
  const rows = await db.select().from(schema.paperOutcomes).limit(100_000);
  return computeStats(rows.map((r) => r.record as TradeOutcome));
}
