/**
 * Phase 5 skeleton: READ-ONLY broker ports (design: docs/twins/design/PHASE5_BROKER_PREP.md, section 1).
 *
 * Types and an in-memory fake only. There is no network code, no vendor SDK, no order method and no
 * wiring into the worker or the api. "Read-only" is a property of the TYPE: nothing here can place,
 * modify or cancel an order. The ExecutionPort stays out until Stage 6 is lifted and has its own review.
 * The existing ExecutionProvider/guardExecutionProvider contracts in this package are untouched.
 */

export type BrokerId = "kite" | "groww" | "dhan";
export type CandleInterval = "minute" | "5minute" | "15minute" | "60minute" | "day";

export interface BrokerIdentity {
  readonly id: BrokerId;
  /** Plan that fails closed (for example "personal" for Kite: no historical data). */
  readonly planLabel: string;
}

export interface InstrumentRef {
  readonly exchange: string;
  readonly tradingSymbol: string;
  readonly token: string;
}

export interface Quote {
  readonly ref: InstrumentRef;
  readonly lastPrice: number;
  readonly asOf: string;
}

export interface Candle {
  readonly start: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface PositionView {
  readonly ref: InstrumentRef;
  readonly quantity: number;
  readonly averagePrice: number;
}

export interface FundsView {
  readonly availableCash: number;
}

/** Fixed error codes only: never a URL, header, token or response body. */
export type BrokerPortErrorCode = "unavailable" | "session_invalid" | "not_supported" | "rate_limited";

export class BrokerPortError extends Error {
  constructor(public readonly code: BrokerPortErrorCode) {
    super(code);
    this.name = "BrokerPortError";
  }
}

export interface MarketDataPort {
  readonly identity: BrokerIdentity;
  instruments(): Promise<readonly InstrumentRef[]>;
  quotes(refs: readonly InstrumentRef[]): Promise<readonly Quote[]>;
  candles(ref: InstrumentRef, interval: CandleInterval, from: Date, to: Date): Promise<readonly Candle[]>;
}

export interface AccountPort {
  readonly identity: BrokerIdentity;
  positions(): Promise<readonly PositionView[]>;
  funds(): Promise<FundsView>;
}

export interface SessionPort {
  /** Never exposes the token itself. */
  status(): Promise<{ readonly valid: boolean; readonly expiresAt: string | null }>;
}

export interface FakeBrokerData {
  readonly instruments?: readonly InstrumentRef[];
  readonly quotes?: readonly Quote[];
  readonly candles?: readonly Candle[];
  readonly positions?: readonly PositionView[];
  readonly funds?: FundsView;
  readonly sessionValid?: boolean;
}

/** In-memory fake for tests of consumers. Deterministic, no I/O. */
export function createFakeReadOnlyBroker(
  data: FakeBrokerData = {},
  identity: BrokerIdentity = { id: "kite", planLabel: "fake" },
): MarketDataPort & AccountPort & SessionPort {
  const valid = data.sessionValid ?? true;
  const need = (): void => {
    if (!valid) throw new BrokerPortError("session_invalid");
  };
  return {
    identity,
    instruments: async () => (need(), data.instruments ?? []),
    quotes: async (refs) => {
      need();
      const keys = new Set(refs.map((r) => `${r.exchange}:${r.tradingSymbol}`));
      return (data.quotes ?? []).filter((q) => keys.has(`${q.ref.exchange}:${q.ref.tradingSymbol}`));
    },
    candles: async (_ref, _interval, from, to) => {
      need();
      return (data.candles ?? []).filter((c) => {
        const t = Date.parse(c.start);
        return t >= from.getTime() && t < to.getTime();
      });
    },
    positions: async () => (need(), data.positions ?? []),
    funds: async () => (need(), data.funds ?? { availableCash: 0 }),
    status: async () => ({ valid, expiresAt: null }),
  };
}
