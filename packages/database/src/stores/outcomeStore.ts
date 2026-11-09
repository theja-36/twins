import { sql } from "drizzle-orm";
import type { Db } from "../client";
import { withUser } from "../withUser";

/**
 * Persistence for outcome learning (Master Build Stage 08). Reads are explicit about their owner (every user-private query filters on user_id in addition to row-level security). Writes go to outcome_attributions and
 * learning_insights (append-only) and learning_job_runs (a bounded lease per job). Nothing here touches decisions, risk settings, strategies, playbooks, weights or permissions.
 */
type X = Pick<Db, "execute">;
const x = (tx: unknown): X => tx as X;
const row = (r: unknown): Record<string, unknown> => r as Record<string, unknown>;
const d = (v: unknown): Date => new Date(v as string);
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export interface AttributionRow {
  id: string; userId: string; accountId: string; paperPositionId: string; outcomeId: string | null; decisionId: string; candidateId: string; version: number; supersedesId: string | null; correctionReason: string | null;
  finality: "PARTIAL" | "FINAL"; mode: "PAPER" | "LIVE"; dataSource: "FIXTURE" | "LIVE" | "HISTORICAL"; candidateSource: "TELEGRAM" | "INDEPENDENT"; setup: string | null; detectorVersion: string | null; channelId: string | null; playbookRef: unknown;
  instrument: string; timeframeSeconds: number | null; side: "BUY" | "SELL"; quantity: string; entryPrice: string; exitPrice: string | null; grossPnl: string | null; costs: string | null; netPnl: string | null; riskAmount: string | null; rMultiple: string | null;
  holdingSeconds: number | null; exitReason: string | null; trade: Record<string, unknown>; regime: Record<string, unknown> | null; agentVersions: Record<string, string>; evidenceRefs: string[]; predicted: Record<string, unknown>;
  confidenceScore: number | null; confidenceAt: Date | null; decidedAt: Date; openedAt: Date; closedAt: Date | null; dataQuality: string[]; missing: string[]; createdAt: Date;
}
export type NewAttribution = Omit<AttributionRow, "id" | "createdAt">;
const attrOf = (r: Record<string, unknown>): AttributionRow => ({
  id: r["id"] as string, userId: r["user_id"] as string, accountId: r["account_id"] as string, paperPositionId: r["paper_position_id"] as string, outcomeId: s(r["outcome_id"]), decisionId: r["decision_id"] as string, candidateId: r["candidate_id"] as string, version: Number(r["version"]),
  supersedesId: s(r["supersedes_id"]), correctionReason: s(r["correction_reason"]), finality: r["finality"] as "PARTIAL" | "FINAL", mode: r["mode"] as "PAPER" | "LIVE", dataSource: r["data_source"] as AttributionRow["dataSource"], candidateSource: r["candidate_source"] as AttributionRow["candidateSource"],
  setup: s(r["setup"]), detectorVersion: s(r["detector_version"]), channelId: s(r["channel_id"]), playbookRef: r["playbook_ref"] ?? null, instrument: r["instrument"] as string, timeframeSeconds: n(r["timeframe_seconds"]), side: r["side"] as "BUY" | "SELL", quantity: String(r["quantity"]), entryPrice: String(r["entry_price"]),
  exitPrice: s(r["exit_price"]), grossPnl: s(r["gross_pnl"]), costs: s(r["costs"]), netPnl: s(r["net_pnl"]), riskAmount: s(r["risk_amount"]), rMultiple: s(r["r_multiple"]), holdingSeconds: n(r["holding_seconds"]), exitReason: s(r["exit_reason"]), trade: (r["trade"] ?? {}) as Record<string, unknown>,
  regime: (r["regime"] ?? null) as Record<string, unknown> | null, agentVersions: (r["agent_versions"] ?? {}) as Record<string, string>, evidenceRefs: (r["evidence_refs"] ?? []) as string[], predicted: (r["predicted"] ?? {}) as Record<string, unknown>, confidenceScore: n(r["confidence_score"]),
  confidenceAt: r["confidence_at"] ? d(r["confidence_at"]) : null, decidedAt: d(r["decided_at"]), openedAt: d(r["opened_at"]), closedAt: r["closed_at"] ? d(r["closed_at"]) : null, dataQuality: (r["data_quality"] ?? []) as string[], missing: (r["missing"] ?? []) as string[], createdAt: d(r["created_at"]),
});

/** Everything known about one paper position at ingestion time, read in one place. Missing pieces are null, never defaulted. */
export interface AttributionFacts {
  position: { id: string; userId: string; accountId: string; decisionId: string; instrument: string; exchange: string; side: "BUY" | "SELL"; quantity: string; initialQuantity: string; avgEntryPrice: string; initialStop: string; stopLoss: string; targets: string[]; realizedPnl: string; realizedCosts: string; status: "OPEN" | "CLOSED"; exitReason: string | null; openedAt: Date; closedAt: Date | null };
  outcome: { id: string; pnl: string; rMultiple: string | null; exitPrice: string; exitReason: string; closedAt: Date } | null;
  decision: { candidateId: string; createdAt: Date; riskAssessmentId: string | null; confidenceAssessmentId: string | null; researchPackageId: string | null; evidenceRefs: string[]; versions: Record<string, string>; permittedSize: Record<string, unknown> | null };
  candidate: { source: "TELEGRAM" | "INDEPENDENT"; setup: string | null; dataSource: "FIXTURE" | "LIVE" | "HISTORICAL"; evidence: unknown[]; claimId: string | null; channelId: string | null; stopLoss: string | null; targets: string[] };
  confidence: { score: number; createdAt: Date; provenance: Record<string, unknown> | null } | null;
  risk: { verdict: string; plannedRewardToRisk: string | null; maxLossAtStop: string | null } | null;
  agentVersions: Record<string, string> | null;
  fills: { priceSources: string[]; entryFills: number; exitFills: number; costs: string; entryValue: string; entryQty: string; exitValue: string; exitQty: string };
  events: Record<string, number>;
  regime: { regime: string; direction: string; volatilityRegime: string; asOf: Date; dataSource: string } | null;
}
export async function loadAttributionFacts(db: Pick<Db, "transaction">, userId: string, positionId: string): Promise<AttributionFacts | null> {
  return withUser(db, userId, async (tx) => {
    const X_ = x(tx), q = async (st: ReturnType<typeof sql>) => (await X_.execute(st)).rows.map(row);
    const [p] = await q(sql`select * from paper_positions where user_id = ${userId}::uuid and id = ${positionId}::uuid`); if (!p) return null;
    const [dec] = await q(sql`select * from user_decisions where user_id = ${userId}::uuid and id = ${p["decision_id"] as string}::uuid`); if (!dec) return null;
    const [oc] = await q(sql`select * from trade_outcomes where user_id = ${userId}::uuid and paper_position_id = ${positionId}::uuid order by created_at limit 1`);
    const [cand] = await q(sql`select c.*, (select m.telegram_source_id from options_claims oc2 join telegram_messages m on m.id = oc2.telegram_message_id where oc2.id = c.claim_id) as source_id from opportunity_candidates c where c.id = ${dec["candidate_id"] as string}::uuid`); if (!cand) return null;
    const [conf] = dec["confidence_assessment_id"] ? await q(sql`select score, created_at, components from confidence_assessments where id = ${dec["confidence_assessment_id"] as string}::uuid`) : [];
    const [risk] = dec["risk_assessment_id"] ? await q(sql`select verdict, result from risk_assessments where user_id = ${userId}::uuid and id = ${dec["risk_assessment_id"] as string}::uuid`) : [];
    const [pkg] = dec["research_package_id"] ? await q(sql`select agent_results from research_packages where id = ${dec["research_package_id"] as string}::uuid`) : [];
    const [f] = await q(sql`select coalesce(array_agg(distinct f.price_source), '{}') as srcs, coalesce(sum(case when o.purpose = 'ENTRY' then 1 end), 0) as ef, coalesce(sum(case when o.purpose = 'EXIT' then 1 end), 0) as xf, coalesce(sum(f.costs), 0) as costs,
        coalesce(sum(case when o.purpose = 'ENTRY' then f.quantity * f.price end), 0) as ev, coalesce(sum(case when o.purpose = 'ENTRY' then f.quantity end), 0) as eq, coalesce(sum(case when o.purpose = 'EXIT' then f.quantity * f.price end), 0) as xv, coalesce(sum(case when o.purpose = 'EXIT' then f.quantity end), 0) as xq
      from paper_fills f join paper_orders o on o.id = f.order_id and o.user_id = f.user_id where o.user_id = ${userId}::uuid and o.decision_id = ${p["decision_id"] as string}::uuid`);
    const evs = await q(sql`select kind, count(*)::int as c from paper_position_events where user_id = ${userId}::uuid and position_id = ${positionId}::uuid group by kind`);
    const [rg] = await q(sql`select regime, direction, volatility_regime, as_of, data_source from market_regimes where underlying = ${p["instrument"] as string} and as_of <= ${new Date(dec["created_at"] as string).toISOString()}::timestamptz order by as_of desc limit 1`);
    const result = (risk?.["result"] ?? null) as { sizing?: { targets?: Array<{ grossRewardToRisk?: string }>; maxLossAtStop?: string } } | null;
    const evidence = (cand["evidence"] ?? []) as unknown[];
    return {
      position: { id: p["id"] as string, userId, accountId: p["account_id"] as string, decisionId: p["decision_id"] as string, instrument: p["instrument"] as string, exchange: p["exchange"] as string, side: p["side"] as "BUY" | "SELL", quantity: String(p["quantity"]), initialQuantity: String(p["initial_quantity"]), avgEntryPrice: String(p["avg_entry_price"]), initialStop: String(p["initial_stop"]), stopLoss: String(p["stop_loss"]), targets: ((p["targets"] ?? []) as unknown[]).map(String), realizedPnl: String(p["realized_pnl"]), realizedCosts: String(p["realized_costs"]), status: p["status"] as "OPEN" | "CLOSED", exitReason: s(p["exit_reason"]), openedAt: d(p["opened_at"]), closedAt: p["closed_at"] ? d(p["closed_at"]) : null },
      outcome: oc ? { id: oc["id"] as string, pnl: String(oc["pnl"]), rMultiple: s(oc["r_multiple"]), exitPrice: String(oc["exit_price"]), exitReason: oc["exit_reason"] as string, closedAt: d(oc["closed_at"]) } : null,
      decision: { candidateId: dec["candidate_id"] as string, createdAt: d(dec["created_at"]), riskAssessmentId: s(dec["risk_assessment_id"]), confidenceAssessmentId: s(dec["confidence_assessment_id"]), researchPackageId: s(dec["research_package_id"]), evidenceRefs: (dec["evidence_refs"] ?? []) as string[], versions: (dec["versions"] ?? {}) as Record<string, string>, permittedSize: (dec["permitted_size"] ?? null) as Record<string, unknown> | null },
      candidate: { source: cand["source"] as "TELEGRAM" | "INDEPENDENT", setup: s(cand["setup"]), dataSource: cand["data_source"] as "FIXTURE" | "LIVE" | "HISTORICAL", evidence, claimId: s(cand["claim_id"]), channelId: s(cand["source_id"]), stopLoss: s(cand["stop_loss"]), targets: ((cand["targets"] ?? []) as unknown[]).map(String) },
      confidence: conf ? { score: Number(conf["score"]), createdAt: d(conf["created_at"]), provenance: ((conf["components"] as { provenance?: Record<string, unknown> } | null)?.provenance ?? null) } : null,
      risk: risk ? { verdict: risk["verdict"] as string, plannedRewardToRisk: result?.sizing?.targets?.[0]?.grossRewardToRisk ?? null, maxLossAtStop: result?.sizing?.maxLossAtStop ?? null } : null,
      agentVersions: pkg ? ((pkg["agent_results"] as { agentVersions?: Record<string, string> } | null)?.agentVersions ?? null) : null,
      fills: { priceSources: ((f?.["srcs"] ?? []) as string[]), entryFills: Number(f?.["ef"] ?? 0), exitFills: Number(f?.["xf"] ?? 0), costs: String(f?.["costs"] ?? "0"), entryValue: String(f?.["ev"] ?? "0"), entryQty: String(f?.["eq"] ?? "0"), exitValue: String(f?.["xv"] ?? "0"), exitQty: String(f?.["xq"] ?? "0") },
      events: Object.fromEntries(evs.map((e) => [e["kind"] as string, Number(e["c"])])),
      regime: rg ? { regime: rg["regime"] as string, direction: rg["direction"] as string, volatilityRegime: rg["volatility_regime"] as string, asOf: d(rg["as_of"]), dataSource: rg["data_source"] as string } : null,
    } as AttributionFacts;
  });
}
/** Positions that need an attribution or a newer version: no attribution yet (closed, or with a partial exit), a PARTIAL one whose position has since closed, or a PARTIAL whose realised result has changed. */
export async function positionsNeedingAttribution(db: Pick<Db, "transaction">, userId: string, limit: number): Promise<string[]> {
  return withUser(db, userId, async (tx) => {
    const r = await x(tx).execute(sql`select p.id from paper_positions p
      left join lateral (select finality, gross_pnl from outcome_attributions a where a.user_id = p.user_id and a.paper_position_id = p.id order by version desc limit 1) a on true
      where p.user_id = ${userId}::uuid and (
        (a.finality is null and (p.status = 'CLOSED' or p.quantity < p.initial_quantity))
        or (a.finality = 'PARTIAL' and (p.status = 'CLOSED' or a.gross_pnl is distinct from p.realized_pnl)))
      order by p.opened_at, p.id limit ${Math.min(Math.max(limit, 1), 500)}`);
    return r.rows.map((q) => row(q)["id"] as string);
  });
}
export async function latestAttributionForPosition(db: Pick<Db, "transaction">, userId: string, positionId: string): Promise<AttributionRow | null> {
  return withUser(db, userId, async (tx) => { const r = await x(tx).execute(sql`select * from outcome_attributions where user_id = ${userId}::uuid and paper_position_id = ${positionId}::uuid order by version desc limit 1`); return r.rows[0] ? attrOf(row(r.rows[0])) : null; });
}
/** Idempotent on (position, version): a redelivered job inserts nothing. Returns the new id, or null when that version already exists. */
export async function insertAttribution(db: Pick<Db, "transaction">, userId: string, a: NewAttribution): Promise<string | null> {
  return withUser(db, userId, async (tx) => {
    const r = await x(tx).execute(sql`insert into outcome_attributions (id, user_id, account_id, paper_position_id, outcome_id, decision_id, candidate_id, version, supersedes_id, correction_reason, finality, mode, data_source, candidate_source, setup, detector_version, channel_id, playbook_ref, instrument, timeframe_seconds, side, quantity, entry_price, exit_price, gross_pnl, costs, net_pnl, risk_amount, r_multiple, holding_seconds, exit_reason, trade, regime, agent_versions, evidence_refs, predicted, confidence_score, confidence_at, decided_at, opened_at, closed_at, data_quality, missing)
      values (gen_random_uuid(), ${userId}::uuid, ${a.accountId}::uuid, ${a.paperPositionId}::uuid, ${a.outcomeId}::uuid, ${a.decisionId}::uuid, ${a.candidateId}::uuid, ${a.version}, ${a.supersedesId}::uuid, ${a.correctionReason}, ${a.finality}, ${a.mode}, ${a.dataSource}, ${a.candidateSource}, ${a.setup}, ${a.detectorVersion}, ${a.channelId}, ${a.playbookRef === null ? null : JSON.stringify(a.playbookRef)}::jsonb, ${a.instrument}, ${a.timeframeSeconds}, ${a.side}, ${a.quantity}::numeric, ${a.entryPrice}::numeric, ${a.exitPrice}::numeric, ${a.grossPnl}::numeric, ${a.costs}::numeric, ${a.netPnl}::numeric, ${a.riskAmount}::numeric, ${a.rMultiple}::numeric, ${a.holdingSeconds}, ${a.exitReason}, ${JSON.stringify(a.trade)}::jsonb, ${a.regime === null ? null : JSON.stringify(a.regime)}::jsonb, ${JSON.stringify(a.agentVersions)}::jsonb, ${JSON.stringify(a.evidenceRefs)}::jsonb, ${JSON.stringify(a.predicted)}::jsonb, ${a.confidenceScore}::numeric, ${a.confidenceAt?.toISOString() ?? null}::timestamptz, ${a.decidedAt.toISOString()}::timestamptz, ${a.openedAt.toISOString()}::timestamptz, ${a.closedAt?.toISOString() ?? null}::timestamptz, ${JSON.stringify(a.dataQuality)}::jsonb, ${JSON.stringify(a.missing)}::jsonb)
      on conflict (paper_position_id, version) do nothing returning id`);
    return r.rows[0] ? (row(r.rows[0])["id"] as string) : null;
  });
}
/** The latest version of every position's attribution for a user (the current truth; older versions remain as audit history). */
export async function latestAttributions(db: Pick<Db, "transaction">, userId: string, o: { mode?: "PAPER" | "LIVE"; finality?: "PARTIAL" | "FINAL"; limit: number }): Promise<AttributionRow[]> {
  return withUser(db, userId, async (tx) => {
    const mode = o.mode ? sql`and mode = ${o.mode}` : sql``, fin = o.finality ? sql`where finality = ${o.finality}` : sql``;
    const r = await x(tx).execute(sql`select * from (select distinct on (paper_position_id) * from outcome_attributions where user_id = ${userId}::uuid ${mode} order by paper_position_id, version desc) l ${fin} order by coalesce(closed_at, opened_at), id limit ${Math.min(Math.max(o.limit, 1), 5000)}`);
    return r.rows.map((q) => attrOf(row(q)));
  });
}
export async function attributionHistory(db: Pick<Db, "transaction">, userId: string, positionId: string): Promise<AttributionRow[]> {
  return withUser(db, userId, async (tx) => (await x(tx).execute(sql`select * from outcome_attributions where user_id = ${userId}::uuid and paper_position_id = ${positionId}::uuid order by version`)).rows.map((q) => attrOf(row(q))));
}

// ─── inputs for the funnels and the agent / decision analytics ───────────────
export interface DecisionRow { id: string; candidateId: string; source: "TELEGRAM" | "INDEPENDENT"; outcome: string; workflowState: string; createdAt: Date; setup: string | null; instrument: string; side: "BUY" | "SELL"; entryLow: number | null; entryHigh: number | null; stopLoss: number | null; targets: number[]; candidateDataSource: string; invalidated: boolean; hasPosition: boolean; channelId: string | null }
export async function listDecisionRows(db: Pick<Db, "transaction">, userId: string, limit: number): Promise<DecisionRow[]> {
  return withUser(db, userId, async (tx) => {
    const r = await x(tx).execute(sql`select d.id, d.candidate_id, c.source, d.outcome, d.workflow_state, d.created_at, c.setup, c.underlying, c.side, c.entry_low, c.entry_high, c.stop_loss, c.targets, c.data_source, exists (select 1 from decision_invalidations i where i.decision_id = d.id) as inv, exists (select 1 from paper_positions p where p.decision_id = d.id) as haspos,
        (select m.telegram_source_id::text from options_claims oc join telegram_messages m on m.id = oc.telegram_message_id where oc.id = c.claim_id) as channel
      from user_decisions d join opportunity_candidates c on c.id = d.candidate_id where d.user_id = ${userId}::uuid order by d.created_at, d.id limit ${Math.min(Math.max(limit, 1), 5000)}`);
    return r.rows.map((q) => { const w = row(q); return { id: w["id"] as string, candidateId: w["candidate_id"] as string, source: w["source"] as "TELEGRAM" | "INDEPENDENT", outcome: w["outcome"] as string, workflowState: w["workflow_state"] as string, createdAt: d(w["created_at"]), setup: s(w["setup"]), instrument: w["underlying"] as string, side: w["side"] as "BUY" | "SELL", entryLow: n(w["entry_low"]), entryHigh: n(w["entry_high"]), stopLoss: n(w["stop_loss"]), targets: ((w["targets"] ?? []) as unknown[]).map(Number), candidateDataSource: w["data_source"] as string, invalidated: !!w["inv"], hasPosition: !!w["haspos"], channelId: s(w["channel"]) }; });
  });
}
/** Platform-level candidate pipeline counts (shared intelligence, not user-private). */
export async function candidateFunnelCounts(db: Pick<Db, "execute">, source: "TELEGRAM" | "INDEPENDENT"): Promise<{ candidates: number; byState: Record<string, number>; researched: number; scans: number; scanCandidates: number; stateReasons: Record<string, number> }> {
  const st = await db.execute(sql`select state, coalesce(state_reason, '') as reason, count(*)::int c from opportunity_candidates where source = ${source} group by state, coalesce(state_reason, '')`);
  const rs = await db.execute(sql`select count(distinct r.candidate_id)::int c from research_packages r join opportunity_candidates c on c.id = r.candidate_id where c.source = ${source}`);
  const sc = source === "INDEPENDENT" ? await db.execute(sql`select count(*)::int c, coalesce(sum(candidate_count), 0)::int cc from opportunity_scans where status = 'COMPLETED'`) : { rows: [{ c: 0, cc: 0 }] };
  const byState: Record<string, number> = {}, reasons: Record<string, number> = {}; let total = 0;
  for (const q of st.rows) { const w = row(q); byState[w["state"] as string] = (byState[w["state"] as string] ?? 0) + Number(w["c"]); total += Number(w["c"]); if (w["reason"]) reasons[w["reason"] as string] = (reasons[w["reason"] as string] ?? 0) + Number(w["c"]); }
  return { candidates: total, byState, researched: Number(row(rs.rows[0])["c"]), scans: Number(row(sc.rows[0])["c"]), scanCandidates: Number(row(sc.rows[0])["cc"]), stateReasons: reasons };
}
export async function claimFunnelCounts(db: Pick<Db, "execute">): Promise<Array<{ channelId: string; channelLabel: string; messages: number; claims: number; ambiguous: number; unsupported: number; assessedReject: number; assessedInsufficient: number }>> {
  const r = await db.execute(sql`select s.id::text as sid, s.channel_identifier, count(distinct m.id)::int msgs,
      count(*) filter (where oc.result_kind = 'claim')::int claims, count(*) filter (where oc.result_kind = 'ambiguous')::int amb, count(*) filter (where oc.result_kind = 'unsupported')::int uns,
      count(*) filter (where oc.assessment_outcome = 'REJECT')::int rej, count(*) filter (where oc.assessment_outcome = 'INSUFFICIENT_EVIDENCE')::int ins
    from telegram_sources s left join telegram_messages m on m.telegram_source_id = s.id left join options_claims oc on oc.telegram_message_id = m.id group by s.id, s.channel_identifier order by s.id`);
  return r.rows.map((q) => { const w = row(q); return { channelId: w["sid"] as string, channelLabel: `***${String(w["channel_identifier"]).slice(-4)}`, messages: Number(w["msgs"]), claims: Number(w["claims"]), ambiguous: Number(w["amb"]), unsupported: Number(w["uns"]), assessedReject: Number(w["rej"]), assessedInsufficient: Number(w["ins"]) }; });
}
/** The research package each candidate's decision actually used (the immutable `user_decisions.research_package_id`; for a candidate with several decisions, the most recent one): the agent reports for participation / verdict analytics. A decision that recorded no package contributes none, and a package stored after the decision is never read (G-41: it would be hindsight). */
export async function researchReportsForDecisions(db: Pick<Db, "transaction">, userId: string, limit: number): Promise<Array<{ candidateId: string; packageId: string; version: number; reports: Array<{ agentId: string; agentVersion: string; verdict: string; executionStatus: string; riskFlags: string[] }>; contradictions: number; missingRequired: string[]; assessment: string }>> {
  return withUser(db, userId, async (tx) => {
    const r = await x(tx).execute(sql`select distinct on (ud.candidate_id) ud.candidate_id, rp.id, rp.version, rp.agent_results, rp.assessment from user_decisions ud join research_packages rp on rp.id = ud.research_package_id where ud.user_id = ${userId}::uuid order by ud.candidate_id, ud.created_at desc, ud.id desc limit ${Math.min(Math.max(limit, 1), 5000)}`);
    return r.rows.map((q) => { const w = row(q), a = (w["agent_results"] ?? {}) as { reports?: Array<{ agentId: string; agentVersion: string; verdict: string; executionStatus: string; riskFlags?: string[] }>; contradictions?: unknown[]; missingRequired?: string[] };
      return { candidateId: w["candidate_id"] as string, packageId: w["id"] as string, version: Number(w["version"]), reports: (a.reports ?? []).map((x2) => ({ agentId: x2.agentId, agentVersion: x2.agentVersion, verdict: x2.verdict, executionStatus: x2.executionStatus, riskFlags: x2.riskFlags ?? [] })), contradictions: (a.contradictions ?? []).length, missingRequired: a.missingRequired ?? [], assessment: w["assessment"] as string }; });
  });
}

// ─── insights ───────────────────────────────────────────────────────────────
export interface InsightRow { id: string; insightKey: string; kind: string; scope: string; subject: string; outcomeCount: number; periodStart: Date | null; periodEnd: Date | null; provenance: unknown; method: string; algorithmVersion: string; evidenceRefs: unknown; reliability: string; severity: string; statement: string; metrics: unknown; limitations: string[]; recommendation: string | null; createdAt: Date }
export type NewInsight = Omit<InsightRow, "id" | "createdAt">;
const insOf = (r: Record<string, unknown>): InsightRow => ({ id: r["id"] as string, insightKey: r["insight_key"] as string, kind: r["kind"] as string, scope: r["scope"] as string, subject: r["subject"] as string, outcomeCount: Number(r["outcome_count"]), periodStart: r["period_start"] ? d(r["period_start"]) : null, periodEnd: r["period_end"] ? d(r["period_end"]) : null, provenance: r["provenance"], method: r["method"] as string, algorithmVersion: r["algorithm_version"] as string, evidenceRefs: r["evidence_refs"], reliability: r["reliability"] as string, severity: r["severity"] as string, statement: r["statement"] as string, metrics: r["metrics"], limitations: (r["limitations"] ?? []) as string[], recommendation: s(r["recommendation"]), createdAt: d(r["created_at"]) });
export async function insertInsight(db: Pick<Db, "transaction">, userId: string, i: NewInsight): Promise<string | null> {
  return withUser(db, userId, async (tx) => {
    const r = await x(tx).execute(sql`insert into learning_insights (id, user_id, insight_key, kind, scope, subject, outcome_count, period_start, period_end, provenance, method, algorithm_version, evidence_refs, reliability, severity, statement, metrics, limitations, recommendation)
      values (gen_random_uuid(), ${userId}::uuid, ${i.insightKey}, ${i.kind}, ${i.scope}, ${i.subject}, ${i.outcomeCount}, ${i.periodStart?.toISOString() ?? null}::timestamptz, ${i.periodEnd?.toISOString() ?? null}::timestamptz, ${JSON.stringify(i.provenance)}::jsonb, ${i.method}, ${i.algorithmVersion}, ${JSON.stringify(i.evidenceRefs)}::jsonb, ${i.reliability}, ${i.severity}, ${i.statement}, ${JSON.stringify(i.metrics)}::jsonb, ${JSON.stringify(i.limitations)}::jsonb, ${i.recommendation})
      on conflict (user_id, insight_key) do nothing returning id`);
    return r.rows[0] ? (row(r.rows[0])["id"] as string) : null;
  });
}
export async function listInsights(db: Pick<Db, "transaction">, userId: string, o: { kind?: string; limit: number }): Promise<InsightRow[]> {
  return withUser(db, userId, async (tx) => { const k = o.kind ? sql`and kind = ${o.kind}` : sql``; return (await x(tx).execute(sql`select * from learning_insights where user_id = ${userId}::uuid ${k} order by created_at desc, id limit ${Math.min(Math.max(o.limit, 1), 500)}`)).rows.map((q) => insOf(row(q))); });
}

// ─── job runs ───────────────────────────────────────────────────────────────
/** Starts a bounded run of a learning job: a lapsed RUNNING run is marked ABANDONED first, and only one RUNNING run per job can exist, so two workers cannot process at once. */
export async function startJobRun(db: Pick<Db, "execute">, job: string, leaseMs: number, now: Date): Promise<{ started: true; id: string; abandoned: number } | { started: false; reason: "ALREADY_RUNNING" }> {
  const ab = await db.execute(sql`update learning_job_runs set status = 'ABANDONED', finished_at = ${now.toISOString()}::timestamptz, error_kind = 'LEASE_LAPSED' where job = ${job} and status = 'RUNNING' and lease_until < ${now.toISOString()}::timestamptz returning id`);
  try {
    const r = await db.execute(sql`insert into learning_job_runs (id, job, status, started_at, lease_until) values (gen_random_uuid(), ${job}, 'RUNNING', ${now.toISOString()}::timestamptz, ${new Date(now.getTime() + leaseMs).toISOString()}::timestamptz) returning id`);
    return { started: true, id: row(r.rows[0])["id"] as string, abandoned: ab.rows.length };
  } catch (e) { const m = String((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code ?? ""); if (m === "23505") return { started: false, reason: "ALREADY_RUNNING" }; throw e; }
}
export async function finishJobRun(db: Pick<Db, "execute">, id: string, status: "COMPLETED" | "FAILED", counts: unknown, errorKind: string | null, now: Date): Promise<void> {
  await db.execute(sql`update learning_job_runs set status = ${status}, finished_at = ${now.toISOString()}::timestamptz, counts = ${JSON.stringify(counts)}::jsonb, error_kind = ${errorKind} where id = ${id}::uuid and status = 'RUNNING'`);
}
export async function listJobRuns(db: Pick<Db, "execute">, job: string, limit: number): Promise<Array<{ id: string; status: string; startedAt: Date; finishedAt: Date | null; counts: unknown; errorKind: string | null }>> {
  const r = await db.execute(sql`select * from learning_job_runs where job = ${job} order by started_at desc limit ${Math.min(Math.max(limit, 1), 200)}`);
  return r.rows.map((q) => { const w = row(q); return { id: w["id"] as string, status: w["status"] as string, startedAt: d(w["started_at"]), finishedAt: w["finished_at"] ? d(w["finished_at"]) : null, counts: w["counts"], errorKind: s(w["error_kind"]) }; });
}
/** Users with an active account (the population the learning jobs iterate), bounded. Accounts are row-level protected (0041), so this goes through the identifiers-only definer function. */
export async function usersWithPaperActivity(db: Pick<Db, "execute">, limit: number): Promise<string[]> {
  const r = await db.execute(sql`select a_user_id from twins_list_active_account_users(${Math.min(Math.max(limit, 1), 1000)})`);
  return r.rows.map((q) => row(q)["a_user_id"] as string);
}

/** Cheap per-user check (one row-level-protected query): does this user have any paper position at all? The learning job skips users with nothing to learn from. */
export async function hasPaperActivity(db: Pick<Db, "transaction">, userId: string): Promise<boolean> {
  return withUser(db, userId, async (tx) => (await x(tx).execute(sql`select 1 from paper_positions where user_id = ${userId}::uuid limit 1`)).rows.length > 0);
}
