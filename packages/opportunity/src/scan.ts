import { randomUUID } from "node:crypto";
import { ohlcProblem, type OhlcProvider, type OhlcSeries, type RegimeProvider } from "@twins/agents";
import type { OpportunityConfig } from "./config";
import { toCandidateDraft, type CandidateDraft } from "./candidate";
import { rankSetup, withSetupAgreement, type RankDetail, type Trend } from "./rank";
import { DEFAULT_SETUP_POLICY, SETUP_DETECTOR_VERSION, detectSetups, resample, trendOf, type SetupSignal } from "./setups";

export const SCAN_ENGINE_VERSION = "opportunity-scan-v1";
export const SCAN_KIND = "TECHNICAL_UNIVERSE";
export type SkipReason = "INELIGIBLE" | "NO_DATA" | "PROVIDER_ERROR" | "MALFORMED" | "SYMBOL_MISMATCH" | "STALE" | "FROM_FUTURE" | "INSUFFICIENT_HISTORY" | "REGIME_BLOCKED" | "NO_SETUP" | "BELOW_MIN_RANK" | "OVER_SCAN_CAP";
export interface ScanSkip { underlying: string; reason: SkipReason; detail?: string }
export interface UniverseEntry { underlying: string; eligible: boolean; reason?: string }
/** Eligibility is the configured universe, filtered by an optional verifier (for example the instrument reference). An unverifiable instrument is ineligible, never assumed valid. */
export function buildUniverse(config: Pick<OpportunityConfig, "universe">, isEligible?: (underlying: string) => boolean | Promise<boolean>): Promise<UniverseEntry[]> {
  return Promise.all(config.universe.map(async (u): Promise<UniverseEntry> => {
    if (!isEligible) return { underlying: u, eligible: true };
    try { return (await isEligible(u)) ? { underlying: u, eligible: true } : { underlying: u, eligible: false, reason: "not verified by the instrument reference" }; }
    catch { return { underlying: u, eligible: false, reason: "eligibility check failed" }; }
  }));
}
export interface ScanOutcome {
  status: "COMPLETED" | "FAILED"; errorKind: "NO_UNIVERSE" | "NO_PROVIDER" | "NO_USABLE_DATA" | null; engineVersion: string; detectorVersion: string;
  universeSize: number; scanned: number; drafts: CandidateDraft[]; skipped: ScanSkip[]; providerName: string | null; providerAsOf: string | null; slotKey: string;
}
/**
 * One scan over the universe. PURE apart from the injected providers. Fails closed and says so:
 *  - no universe or no provider -> FAILED (never an "empty success");
 *  - every instrument skipped because data was missing, stale or malformed -> FAILED (NO_USABLE_DATA);
 *  - otherwise COMPLETED, with every skipped instrument and its reason recorded.
 * A missing / unknown regime does not invent support: it is recorded as missing evidence and scored as zero. A HIGH_VOLATILITY or RISK_OFF regime suppresses candidates for that instrument.
 */
export async function runOpportunityScan(o: { universe: readonly UniverseEntry[]; ohlc: OhlcProvider | null; regime: RegimeProvider | null; config: OpportunityConfig; now: Date; slotKey: string; newId?: () => string }): Promise<ScanOutcome> {
  const base = { engineVersion: SCAN_ENGINE_VERSION, detectorVersion: SETUP_DETECTOR_VERSION, universeSize: o.universe.length, slotKey: o.slotKey, providerName: o.ohlc?.name ?? null, providerAsOf: o.ohlc?.asOf ?? null };
  const skipped: ScanSkip[] = [];
  if (o.universe.length === 0) return { ...base, status: "FAILED", errorKind: "NO_UNIVERSE", scanned: 0, drafts: [], skipped };
  if (!o.ohlc) return { ...base, status: "FAILED", errorKind: "NO_PROVIDER", scanned: 0, drafts: [], skipped: o.universe.map((u) => ({ underlying: u.underlying, reason: "NO_DATA" as const, detail: "no OHLC provider is configured" })) };
  const cfg = o.config, ids = o.newId ?? randomUUID, drafts: Array<{ draft: CandidateDraft; score: number }> = [];
  let scanned = 0, dataFailures = 0, eligible = 0;
  for (const u of o.universe) {
    if (!u.eligible) { skipped.push({ underlying: u.underlying, reason: "INELIGIBLE", ...(u.reason ? { detail: u.reason } : {}) }); continue; }
    eligible++;
    let series: OhlcSeries | null;
    try { series = await o.ohlc.candles({ market: cfg.exchange, symbol: u.underlying, limit: 250, to: new Date(o.now.getTime() + 5 * 60_000).toISOString() }); }
    catch { skipped.push({ underlying: u.underlying, reason: "PROVIDER_ERROR" }); dataFailures++; continue; } // the provider's own message is never stored
    if (series === null) { skipped.push({ underlying: u.underlying, reason: "NO_DATA" }); dataFailures++; continue; }
    if (ohlcProblem(series) !== null) { skipped.push({ underlying: u.underlying, reason: "MALFORMED" }); dataFailures++; continue; }
    if (typeof series.symbol !== "string" || series.symbol.toUpperCase() !== u.underlying) { skipped.push({ underlying: u.underlying, reason: "SYMBOL_MISMATCH" }); dataFailures++; continue; }
    if (series.bars.length < DEFAULT_SETUP_POLICY.minBars) { skipped.push({ underlying: u.underlying, reason: "INSUFFICIENT_HISTORY" }); dataFailures++; continue; }
    const lastAt = Date.parse(series.bars[series.bars.length - 1]!.t), ageMin = (o.now.getTime() - lastAt) / 60_000;
    if (ageMin < -5) { skipped.push({ underlying: u.underlying, reason: "FROM_FUTURE" }); dataFailures++; continue; }
    // a bar is complete at its end: the freshness window counts from the bar's end, so a 15m bar stamped 09:30 is current at 09:45 + the tolerance
    if (ageMin - series.intervalSeconds / 60 > cfg.maxBarAgeMinutes) { skipped.push({ underlying: u.underlying, reason: "STALE", detail: `${Math.round(ageMin)} minutes` }); dataFailures++; continue; }
    scanned++;

    let regime = null, regimeRef: string | null = null;
    if (o.regime) { try { regime = await o.regime.regimeFor(u.underlying, o.now); } catch { regime = null; } }
    const regimeUsable = regime !== null && regime.regime !== "UNKNOWN" && !regime.freshness.stale && regime.underlying === u.underlying;
    if (regime && regimeUsable) {
      regimeRef = `market_regime:${regime.version}:${regime.underlying}:${regime.asOf ?? "unknown"}`;
      if (regime.regime === "HIGH_VOLATILITY" || regime.riskOff) { skipped.push({ underlying: u.underlying, reason: "REGIME_BLOCKED", detail: regime.riskOff ? "RISK_OFF" : "HIGH_VOLATILITY" }); continue; }
    }
    const signals = detectSetups(series, u.underlying);
    if (signals.length === 0) { skipped.push({ underlying: u.underlying, reason: "NO_SETUP" }); continue; }
    // multi-timeframe confluence: the trend of each configured higher timeframe (resampled from the same series); all must agree with the side
    const htf: Trend[] = cfg.confluenceTimeframesSeconds.map((tf) => trendOf(resample(series!, tf)));
    const htfTrend: Trend = htf.length === 0 || htf.some((t) => t === "UNKNOWN") ? "UNKNOWN" : htf.every((t) => t === htf[0]) ? (htf[0] as Trend) : "NEUTRAL";
    for (const s of signals) {
      const others = signals.filter((x) => x !== s && x.side === s.side).map((x) => x.setup);
      const rank: RankDetail = withSetupAgreement(rankSetup(s, { htfTrend, regime, regimeUsable }), others);
      if (rank.score < cfg.minRankScore) { skipped.push({ underlying: u.underlying, reason: "BELOW_MIN_RANK", detail: `${s.setup}:${rank.score}` }); continue; }
      drafts.push({ score: rank.score, draft: toCandidateDraft({ underlying: u.underlying, exchange: cfg.exchange, signal: s as SetupSignal, rank, dataSource: cfg.dataSource, now: o.now, ttlMinutes: cfg.candidateTtlMinutes, correlationId: ids(), provenance: { providerName: o.ohlc.name, providerAsOf: o.ohlc.asOf, scanSlot: o.slotKey, regimeRef } }) });
    }
  }
  if (eligible > 0 && scanned === 0 && dataFailures === eligible) return { ...base, status: "FAILED", errorKind: "NO_USABLE_DATA", scanned, drafts: [], skipped };
  drafts.sort((a, b) => b.score - a.score || a.draft.dedupeKey.localeCompare(b.draft.dedupeKey)); // deterministic order
  const kept = drafts.slice(0, cfg.maxCandidatesPerScan);
  for (const d of drafts.slice(cfg.maxCandidatesPerScan)) skipped.push({ underlying: d.draft.underlying, reason: "OVER_SCAN_CAP", detail: d.draft.setup });
  return { ...base, status: "COMPLETED", errorKind: null, scanned, drafts: kept.map((k) => k.draft), skipped };
}
