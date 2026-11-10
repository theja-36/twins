import { runCandidateResearch, type AgentEngineConfig, type AgentRegistry, type LastPriceProvider, type OhlcProvider, type OrchestrationDeps, type RegimeProvider } from "@twins/agents";
import { ACTIVE_CANDIDATE_STATES, applyRevalidation, beginScan, completeScan, createCandidateQueue, failScan, insertScanCandidates, listCandidates, storeResearchPackage, type Db } from "@twins/database";
import { refuseUnlessSafe } from "@twins/risk";
import { opportunityConfigSha256, type OpportunityConfig } from "./config";
import type { ScanCalendar } from "./screen";
import { dispatchResearch, type DispatchResult } from "./dispatch";
import { revalidate } from "./lifecycle";
import { buildUniverse, runOpportunityScan, SCAN_ENGINE_VERSION, SCAN_KIND } from "./scan";
import { SETUP_DETECTOR_VERSION } from "./setups";

/**
 * One engine cycle for a scheduled slot: scan -> revalidate active candidates -> research. Idempotent per slot (the scan is keyed on the slot; research claims are atomic), so a redelivered or retried job repeats nothing.
 * Creates RESEARCH candidates only: no order, no approval, no decision. The runtime safety state (kill switch / intake control) is checked first and stops the cycle without an error.
 */
export interface CycleDeps {
  db: Db; config: OpportunityConfig; ohlc: OhlcProvider | null; lastPrice: LastPriceProvider | null; regime: RegimeProvider | null; /** Optional calendar source for the scan gate (none is wired in production yet: the gate then reports CALENDAR_UNAVAILABLE). */ calendar?: ScanCalendar | null; registry: AgentRegistry; agentConfig: AgentEngineConfig;
  /** Limits revalidation and research to these instruments (isolation for tests and staged roll-outs); production leaves it unset. */
  scope?: { underlyings: readonly string[] };
  now?: () => Date; isEligible?: (underlying: string) => boolean | Promise<boolean>; research?: OrchestrationDeps; refuse?: (operation: string) => Promise<void>; log?: (event: string, fields: Record<string, unknown>) => void;
}
export interface CycleReport {
  slotKey: string; skipped: "DISABLED" | "SAFETY_REFUSED" | null;
  scan: { state: string; status: string | null; errorKind: string | null; created: number; duplicates: number; superseded: number; skipped: number } | null;
  revalidation: { checked: number; valid: number; invalidated: number; expired: number; unverifiable: number };
  research: DispatchResult | null;
}
const refusal = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "safety_refused";

export async function runOpportunityCycle(slotKey: string, d: CycleDeps): Promise<CycleReport> {
  const now = (d.now ?? (() => new Date()))(), c = d.config;
  const report: CycleReport = { slotKey, skipped: null, scan: null, revalidation: { checked: 0, valid: 0, invalidated: 0, expired: 0, unverifiable: 0 }, research: null };
  if (!c.enabled) return { ...report, skipped: "DISABLED" };
  try { await (d.refuse ?? refuseUnlessSafe)("opportunity.cycle"); } catch (e) { if (refusal(e)) return { ...report, skipped: "SAFETY_REFUSED" }; throw e; }

  // 1. scan (idempotent per slot)
  const begin = await beginScan(d.db, { scanKind: SCAN_KIND, slotKey, parameters: { universe: c.universe, exchange: c.exchange, confluence: c.confluenceTimeframesSeconds, minRank: c.minRankScore, minRewardRisk: c.minRewardRisk, configSha256: opportunityConfigSha256(c), engine: SCAN_ENGINE_VERSION }, detectorVersion: SETUP_DETECTOR_VERSION, dataSource: c.dataSource, now, leaseMs: c.researchLeaseMinutes * 60_000 });
  if (begin.state === "STARTED" || begin.state === "RESTARTED") {
    const universe = await buildUniverse(c, d.isEligible);
    const out = await runOpportunityScan({ universe, ohlc: d.ohlc, regime: d.regime, calendar: d.calendar ?? null, config: c, now, slotKey });
    try {
      if (out.status === "FAILED") {
        await failScan(d.db, begin.scanId, { errorKind: out.errorKind ?? "UNKNOWN", universeSize: out.universeSize, skipped: out.skipped, now });
        report.scan = { state: begin.state, status: "FAILED", errorKind: out.errorKind, created: 0, duplicates: 0, superseded: 0, skipped: out.skipped.length };
        d.log?.("opportunity.scan.failed", { slotKey, errorKind: out.errorKind, universeSize: out.universeSize });
      } else {
        const ins = await insertScanCandidates(d.db, begin.scanId, out.drafts.map((x) => ({ ...x })));
        await completeScan(d.db, begin.scanId, { candidateCount: ins.created.length, universeSize: out.universeSize, skipped: out.skipped, now });
        report.scan = { state: begin.state, status: "COMPLETED", errorKind: null, created: ins.created.length, duplicates: ins.duplicates, superseded: ins.superseded, skipped: out.skipped.length };
      }
    } catch (e) {
      await failScan(d.db, begin.scanId, { errorKind: "PERSISTENCE", universeSize: out.universeSize, skipped: out.skipped, now }).catch(() => undefined);
      throw e; // the queue retries the slot; a FAILED slot is restarted
    }
  } else report.scan = { state: begin.state, status: null, errorKind: null, created: 0, duplicates: 0, superseded: 0, skipped: 0 };

  // 2. revalidate every active candidate against the latest price; one that cannot be checked is left unrefreshed
  const active = await listCandidates(d.db, { states: ACTIVE_CANDIDATE_STATES, limit: 200, ...(d.scope ? { scope: d.scope } : {}) });
  for (const cand of active) {
    let price: { price: number; asOf: string } | null = null;
    if (d.lastPrice) { try { price = await d.lastPrice.price({ market: cand.exchange, symbol: cand.underlying }); } catch { price = null; } }
    const r = revalidate({ side: cand.side, invalidation: (cand.invalidation ?? null) as never, stopLoss: cand.stopLoss, targets: cand.targets, expiresAt: cand.expiresAt }, price, now, c.maxPriceAgeMinutes);
    report.revalidation.checked++;
    await applyRevalidation(d.db, cand.id, r, now);
    if (r.outcome === "VALID") report.revalidation.valid++; else if (r.outcome === "INVALIDATED") report.revalidation.invalidated++; else if (r.outcome === "EXPIRED") report.revalidation.expired++; else report.revalidation.unverifiable++;
  }

  // 3. research (source-agnostic)
  const queue = createCandidateQueue(d.db, d.scope);
  report.research = await dispatchResearch({
    queue, now, enabled: d.agentConfig.enabled, batchSize: c.researchBatchSize, maxAttempts: c.researchMaxAttempts, leaseMs: c.researchLeaseMinutes * 60_000, ...(d.log ? { log: d.log } : {}),
    research: (cand) => runCandidateResearch(cand, {
      registry: d.registry, config: d.agentConfig, deps: { now: () => now, ...(d.research ?? {}) }, ...(d.refuse ? { refuse: d.refuse } : {}),
      sink: { save: (candidateId, build) => storeResearchPackage(d.db, (version) => build(version), candidateId) },
    }),
  });
  return report;
}
