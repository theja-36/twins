/**
 * Generic name -> adapter registry (spec section 43: "This allows
 * replacing providers without rewriting core business logic"). Core code
 * asks the registry for "the configured market data provider" and gets
 * back something typed only as the interface - it never imports a
 * concrete vendor adapter directly.
 *
 * One registry instance exists per provider domain (market, news, macro,
 * telegram, broker, execution, ai) - see the `adapters/*` packages and
 * `packages/ai`.
 */
export class ProviderNotRegisteredError extends Error {
  constructor(domainLabel: string, providerName: string, known: string[]) {
    super(
      `No ${domainLabel} provider registered as "${providerName}". Known: ${
        known.length > 0 ? known.join(", ") : "(none)"
      }`,
    );
    this.name = "ProviderNotRegisteredError";
  }
}

export interface AdapterRegistry<T> {
  /** Register (or replace) the adapter available under `providerName`. */
  register(providerName: string, adapter: T): void;
  /** Look up a registered adapter; throws if nothing is registered under that name. */
  get(providerName: string): T;
  has(providerName: string): boolean;
  unregister(providerName: string): void;
  list(): string[];
}

export function createAdapterRegistry<T>(domainLabel: string): AdapterRegistry<T> {
  const adapters = new Map<string, T>();

  return {
    register(providerName, adapter) {
      adapters.set(providerName, adapter);
    },
    get(providerName) {
      const adapter = adapters.get(providerName);
      if (!adapter) {
        throw new ProviderNotRegisteredError(
          domainLabel,
          providerName,
          Array.from(adapters.keys()),
        );
      }
      return adapter;
    },
    has(providerName) {
      return adapters.has(providerName);
    },
    unregister(providerName) {
      adapters.delete(providerName);
    },
    list() {
      return Array.from(adapters.keys());
    },
  };
}
