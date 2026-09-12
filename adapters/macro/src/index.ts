import { createAdapterRegistry } from "@twins/shared";
import type { MacroProvider } from "@twins/types";

/**
 * Registry of MacroProvider adapters, keyed by provider name (e.g.
 * "rbi", "mospi", "fred"). No concrete vendor adapter yet - see spec
 * sections 13/15.
 */
export const macroProviders = createAdapterRegistry<MacroProvider>("macro");

export type {
  MacroProvider,
  MacroSeriesRequest,
  NormalizedMacroObservation,
  ProviderHealthSnapshot,
} from "@twins/types";
