import { AgentRegistry } from "../registry";
import { fileInstrumentReference, type HistoricalInstrumentReference, type InstrumentReference } from "./instrumentReference";
import { instrumentVerificationAgent } from "./instrumentVerification";
import { signalIntegrityAgent } from "./signalIntegrity";
import type { AgentRulesConfig } from "./rules";

export * from "./common";
export * from "./rules";
export * from "./instrumentReference";
export * from "./signalIntegrity";
export * from "./instrumentVerification";

/** The production research agents, in the order they are listed (Stage 5 / Task 2). Later tasks append to this list; nothing else is registered. */
export const PRODUCTION_AGENT_IDS = ["signal-integrity-v1", "instrument-verification-v1"] as const;

export interface ProductionRegistryOptions { rules: AgentRulesConfig; instrumentReference?: InstrumentReference | null; historicalReference?: HistoricalInstrumentReference }
/** Registers the two production agents. Used only when the engine is explicitly enabled; with no instrument reference the verification agent reports UNAVAILABLE (never a pass). */
export function createProductionRegistry(o: ProductionRegistryOptions): AgentRegistry {
  const r = new AgentRegistry();
  r.register(signalIntegrityAgent(o.rules));
  r.register(instrumentVerificationAgent(o.rules, o.instrumentReference ?? null, o.historicalReference));
  return r;
}
/** Resolves `TWINS_AGENT_INSTRUMENT_REFERENCE` (`none` | `file:<path>`). A bad file THROWS (start-up fails closed). */
export function resolveInstrumentReference(source: string): InstrumentReference | null {
  if (source === "none") return null;
  if (source.startsWith("file:")) return fileInstrumentReference(source.slice(5));
  throw new Error("unsupported instrument reference source");
}
