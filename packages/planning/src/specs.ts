import { readFileSync } from "node:fs";
import { dec, isDec, type Dec } from "./decimal";

/**
 * Versioned instrument specifications and fee schedules (Module 08). Nothing is built in: values come from a provider, and every result records the version, effective date and SOURCE KIND of what it used.
 * Only an OFFICIAL source (an exchange or regulator circular, entered by the operator with its reference) counts as verified; FIXTURE and OPERATOR_FILE values are usable for research and simulation but make
 * the risk assessment RESTRICTED, so a made-up contract value can never silently size a real position.
 */
export const SPEC_SOURCE_KINDS = ["OFFICIAL", "OPERATOR_FILE", "FIXTURE"] as const;
export type SpecSourceKind = (typeof SPEC_SOURCE_KINDS)[number];
export type InstrumentKind = "equity" | "future" | "option";
export interface InstrumentSpec {
  specVersion: string; sourceKind: SpecSourceKind; sourceRef: string | null; effectiveFrom: string; effectiveTo: string | null;
  exchange: string; underlying: string; instrumentType: InstrumentKind; segment: string;
  lotSize: string; tickSize: string; /** A single order above this quantity must be sliced; sizing stays within it. null = none published. */ freezeQuantity: number | null; maxLots: number | null;
}
export type BrokerageModel = { kind: "FLAT"; perOrder: string } | { kind: "PCT"; percent: string; capPerOrder: string | null } | { kind: "NONE" };
export interface FeeSchedule {
  feeVersion: string; sourceKind: SpecSourceKind; sourceRef: string | null; effectiveFrom: string; effectiveTo: string | null; segment: string;
  brokerage: BrokerageModel;
  /** All rates are PERCENT of turnover (price x quantity) except where noted. */
  exchangeChargePct: string; sebiPct: string; stampDutyBuyPct: string; sttSellPct: string; sttBuyPct: string; gstPctOnServices: string; otherPerOrder: string;
}
export interface SpecProvider {
  readonly name: string;
  instrument(q: { exchange: string; underlying: string; instrumentType: InstrumentKind; at: Date }): Promise<InstrumentSpec | null>;
  fees(q: { segment: string; at: Date }): Promise<FeeSchedule | null>;
}
const inEffect = (from: string, to: string | null, at: Date): boolean => Date.parse(from) <= at.getTime() && (to === null || at.getTime() < Date.parse(to));
/** Structural validation; returns an error code or null. A malformed spec is never repaired. */
export function specProblem(s: InstrumentSpec | null): string | null {
  if (!s || typeof s !== "object") return "SPEC_MISSING";
  if (!SPEC_SOURCE_KINDS.includes(s.sourceKind) || typeof s.specVersion !== "string" || !s.specVersion) return "SPEC_PROVENANCE";
  if (s.sourceKind === "OFFICIAL" && !s.sourceRef) return "SPEC_OFFICIAL_NEEDS_REFERENCE";
  if (!isDec(s.lotSize) || !isDec(s.tickSize) || dec(s.lotSize) <= 0n || dec(s.tickSize) <= 0n) return "SPEC_LOT_OR_TICK";
  if (!["equity", "future", "option"].includes(s.instrumentType)) return "SPEC_TYPE";
  if (Number.isNaN(Date.parse(s.effectiveFrom))) return "SPEC_EFFECTIVE_DATE";
  if (s.freezeQuantity !== null && (!Number.isInteger(s.freezeQuantity) || s.freezeQuantity < 1)) return "SPEC_FREEZE";
  if (s.maxLots !== null && (!Number.isInteger(s.maxLots) || s.maxLots < 1)) return "SPEC_MAX_LOTS";
  return null;
}
export function feeProblem(f: FeeSchedule | null): string | null {
  if (!f || typeof f !== "object") return "FEES_MISSING";
  if (!SPEC_SOURCE_KINDS.includes(f.sourceKind) || !f.feeVersion) return "FEES_PROVENANCE";
  if (f.sourceKind === "OFFICIAL" && !f.sourceRef) return "FEES_OFFICIAL_NEEDS_REFERENCE";
  for (const k of ["exchangeChargePct", "sebiPct", "stampDutyBuyPct", "sttSellPct", "sttBuyPct", "gstPctOnServices", "otherPerOrder"] as const) if (!isDec(f[k]) || dec(f[k]) < 0n) return `FEES_${k.toUpperCase()}`;
  const b = f.brokerage;
  if (!b || (b.kind === "FLAT" && (!isDec(b.perOrder) || dec(b.perOrder) < 0n)) || (b.kind === "PCT" && (!isDec(b.percent) || dec(b.percent) < 0n || (b.capPerOrder !== null && !isDec(b.capPerOrder)))) || !["FLAT", "PCT", "NONE"].includes(b.kind)) return "FEES_BROKERAGE";
  if (Number.isNaN(Date.parse(f.effectiveFrom))) return "FEES_EFFECTIVE_DATE";
  return null;
}
export function memorySpecProvider(o: { name?: string; instruments: InstrumentSpec[]; fees: FeeSchedule[] }): SpecProvider {
  return {
    name: o.name ?? "memory-specs",
    async instrument(q) { return o.instruments.filter((s) => s.exchange === q.exchange && s.underlying === q.underlying && s.instrumentType === q.instrumentType && inEffect(s.effectiveFrom, s.effectiveTo, q.at)).sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom))[0] ?? null; },
    async fees(q) { return o.fees.filter((f) => f.segment === q.segment && inEffect(f.effectiveFrom, f.effectiveTo, q.at)).sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom))[0] ?? null; },
  };
}
export const SPEC_FILE_FORMAT = "twins-specs-v1";
/** `{ format: "twins-specs-v1", instruments: [...], fees: [...] }`. Every entry is validated at load; a bad file THROWS (start-up fails closed). */
export function fileSpecProvider(path: string): SpecProvider {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { format?: string; instruments?: InstrumentSpec[]; fees?: FeeSchedule[] };
  if (raw.format !== SPEC_FILE_FORMAT || !Array.isArray(raw.instruments) || !Array.isArray(raw.fees)) throw new Error("the specification file is not twins-specs-v1");
  for (const s of raw.instruments) { const p = specProblem(s); if (p) throw new Error(`instrument specification rejected: ${p}`); }
  for (const f of raw.fees) { const p = feeProblem(f); if (p) throw new Error(`fee schedule rejected: ${p}`); }
  return memorySpecProvider({ name: `file-specs`, instruments: raw.instruments, fees: raw.fees });
}
export const specIsVerified = (s: { sourceKind: SpecSourceKind }): boolean => s.sourceKind === "OFFICIAL";
export type { Dec };
