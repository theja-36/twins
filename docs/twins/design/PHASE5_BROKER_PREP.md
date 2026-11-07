# Phase 5 prep: broker adapter design, host-address check, verification checklist

**Docs only. No broker call, no account action, no order path. Stage 6 stays off.** Follows the owner's decisions of 2026-11-07: Kite first (data and execution), Dhan only if greeks are needed, Groww's terms checked before it is considered, host fixed IP and datacenter checked before order work. Research findings: [PHASE5_BROKER_CONNECT_RESEARCH.md](PHASE5_BROKER_CONNECT_RESEARCH.md).

## 1. Broker-neutral adapter (design sketch)
Today only `packages/kite` exists, and it is read-only by construction (no write method; the allow-list refuses every write path). A second broker should not copy it; both should implement one narrow interface, so that data and execution can come from different brokers and so that "read-only" is a property of the TYPE, not of discipline.

```ts
// packages/broker/src/contract.ts (not created yet)
export interface BrokerIdentity { id: "kite" | "groww" | "dhan"; planLabel: string }
export interface InstrumentRef { exchange: string; tradingSymbol: string; token: string }
export interface MarketDataPort {            // READ-ONLY port: the only one any current code may import
  instruments(): Promise<InstrumentRef[]>;
  quotes(refs: InstrumentRef[]): Promise<Quote[]>;
  candles(ref: InstrumentRef, interval: Interval, from: Date, to: Date): Promise<Candle[]>;
  optionChain?(underlying: string, expiry: string): Promise<OptionChain>;   // only where the broker provides it
}
export interface AccountPort {               // READ-ONLY account state
  positions(): Promise<Position[]>; holdings(): Promise<Holding[]>; funds(): Promise<Funds>;
}
export interface ExecutionPort {             // DOES NOT EXIST until Stage 6 is lifted; shown only to fix the shape
  place(order: ValidatedOrder): Promise<OrderAck>; cancel(id: string): Promise<void>;
}
export interface SessionPort { status(): Promise<{ valid: boolean; expiresAt: string | null }>; }   // never exposes the token
```
Rules that carry over from the Kite package: one allow-list of paths per broker; fixed error codes (no URL, header or body in an error); a rate limiter per class; host pinning; the token lives in a 0600 file read only by the process that needs it; every adapter is constructed with a **plan** that fails closed (as `personal` does for Kite). `ExecutionPort` would take only a `ValidatedOrder` (the output of P1 #9 pre-trade validation plus an approval id), never raw fields, and would be a separate package that the current import-restriction tests keep out of everything except one gate module.

## 2. Host fixed address and datacenter: read-only check (do not run until order work is planned)
Why: Zerodha's FAQ requires a registered static IP for order endpoints; the same expectation applies under the SEBI retail framework for the other brokers. We do not know whether the staging host's public address is fixed or where its datacenter is.
Ways to find out WITHOUT any new outbound request from the host:
1. The hosting provider's own console or API for the VPS (plan, public IPv4 and IPv6, datacenter location, whether the address is dedicated). This is an account lookup, not traffic from the host.
2. On the host, local facts only: `ip -4 addr show`, `ip route`, and the provider's metadata if it is exposed locally. A private address behind NAT would show here.
3. Ask the provider in writing whether the address is static for the life of the VPS and is retained across rebuilds.
Record: address family, whether it is shared, location, change policy. Do not use public IP-lookup sites from the host (the egress rules and the owner's instruction on 2026-11-07).

## 3. Verification checklist (from official pages, before any broker decision)
| Item | Kite | Groww | Dhan |
|---|---|---|---|
| Current plan names and prices | Zerodha pricing / FAQ | groww.in/trade-api | dhan.co support |
| API terms of use (personal automation, data storage, derived use) | read | read | read |
| Token lifetime and renewal method (human login vs TOTP) | daily, human | daily? TOTP flow? | ? |
| Official rate limits per class | documented | conflicting sources | conflicting sources |
| Static IP rule: which endpoints, how many addresses, change policy | order endpoints, 1 + 1, account level | ? | ? |
| Algo tagging and registration thresholds | ? | ? | ? |
| Option chain and greeks available | no greeks | reported yes | reported yes (Data plan) |
| Expired contract history | no | ? | ? |
| Suspension rules / shared-IP rules | family only | ? | ? |
Fill the blanks from the vendor's own pages; each answer needs the page and the date.

## 4. Questions to put to support (written, saved)
Does personal, non-commercial automation on one account need any registration beyond the API key and the static IP? Is the same IP usable for read-only data calls from a different host? What happens to open orders if a token lapses or the IP changes? Is the order-rate threshold for registration counted per account or per key?

## 5. Decision tree (nothing is built from this yet)
1. Data needs only index/option quotes, bars and instruments: stay on Kite Connect (paid, integrated).
2. Option greeks or IV become necessary for #4: price Dhan's Data plan against computing greeks ourselves from Kite prices; decide with your numbers.
3. Execution later: only after Stage 6 is lifted, the host address is confirmed fixed, the broker's terms are read, and an `ExecutionPort` design has its own safety review (approval id required, kill switch, reduce-only bias, paper first).
4. A second broker is added only for a stated reason (data the first lacks, or redundancy), behind the same ports.
