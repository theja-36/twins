/**
 * Status vocabulary (docs/frontend/design-system.md §4): each domain has its own SHAPE and hue, text is always present, and unknown backend values render neutrally
 * ("UNKNOWN (x)") instead of crashing. Profit/loss colours are used only by PnlValue, never for status; workflow hues never signal profit.
 */
import { DECISION_STATES, PAPER_ORDER_STATES, POSITION_STATUSES, type Freshness } from "@twins/api-contracts";
import { formatDecimal, formatIst, formatMoney, signOf } from "@/lib/format";

const label = (v: string): string => v.replaceAll("_", " ");
function known<T extends string>(list: readonly T[], v: string): v is T { return (list as readonly string[]).includes(v); }
function Unknown({ v }: { v: string }) { return <span className="badge b-neutral" title="A value this interface does not know yet">{`UNKNOWN (${v})`}</span>; }

export function DecisionStatusBadge({ state }: { state: string }) { return known(DECISION_STATES, state) ? <span className="badge b-dec">{label(state)}</span> : <Unknown v={state} />; }
export function OrderStatusBadge({ status }: { status: string }) { return known(PAPER_ORDER_STATES, status) ? <span className="badge b-ord">{label(status)}</span> : <Unknown v={status} />; }
export function PositionStatusBadge({ status }: { status: string }) { return known(POSITION_STATUSES, status) ? <span className="badge b-pos">{label(status)}</span> : <Unknown v={status} />; }

/**
 * Where a figure comes from. FIXTURE is hatched. LIVE is specified in the vocabulary but is NEVER rendered as LIVE: no live source is verified
 * (analytics report liveStatus UNAVAILABLE), so a LIVE value is shown as a dashed "not verified live" badge.
 */
export function ProvenanceBadge({ kind }: { kind: "FIXTURE" | "PAPER" | "LIVE" | "UNAVAILABLE" | string }) {
  switch (kind) {
    case "FIXTURE": return <span className="badge b-fix" title="Built on synthetic fixture data, not a market">FIXTURE</span>;
    case "PAPER": return <span className="badge b-ord" title="Simulated paper trading">PAPER</span>;
    case "LIVE": return <span className="badge b-na" title="No live source is verified in this system">LIVE · NOT VERIFIED</span>;
    case "UNAVAILABLE": return <span className="badge b-na">NOT AVAILABLE</span>;
    default: return <Unknown v={kind} />;
  }
}
export function AvailabilityBadge({ kind }: { kind: "PLANNED" | "UNAVAILABLE" | "PARTIAL" }) { return <span className="badge b-na">{kind === "UNAVAILABLE" ? "NOT AVAILABLE" : kind}</span>; }
export function FreshnessChip({ freshness, asOf }: { freshness: Freshness; asOf?: string | null }) {
  const stale = freshness === "STALE";
  return <span className={`fresh ${stale ? "stale" : ""}`}><i aria-hidden="true" />{stale ? "STALE" : "CURRENT"}{asOf ? <span className="muted"> · {formatIst(asOf)}</span> : null}</span>;
}
/** Signed result with an arrow AND a sign: colour is never the only cue. The sign is read from the characters of the value; nothing is computed. */
export function PnlValue({ value, currency = "INR" }: { value: string | null | undefined; currency?: string }) {
  const sign = signOf(value), text = formatMoney(value, currency);
  return <span className={`num pl ${sign}`} aria-label={`${sign === "gain" ? "profit" : sign === "loss" ? "loss" : "no result"} ${text}`}>{sign === "gain" ? "+" : ""}{text}</span>;
}
export function MoneyValue({ value, currency = "INR" }: { value: string | number | null | undefined; currency?: string }) { return <span className="num">{formatMoney(value, currency)}</span>; }
export function NumberValue({ value }: { value: string | number | null | undefined }) { return <span className="num">{formatDecimal(value)}</span>; }
