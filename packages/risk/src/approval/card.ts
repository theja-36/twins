import { createHash } from "node:crypto";
import { DEFAULT_SIZING_CONFIG } from "../sizing/config";
import { confidenceTier, trustTier } from "../sizing/engine";
import type { CircuitBreakerStatus } from "../breakers/record";
import type { RiskDecisionRecord } from "../riskDecisions";

/**
 * The approval card contract (Stage 3 / Task 6): a complete, honest, risk-reviewed trade PROPOSAL for the approver, built ONLY from the structured fields of an
 * approval-eligible risk decision and its stored gate evaluations. Plain text only (no markup is interpreted). It never contains the original Telegram message
 * text, channel identifiers, credentials, tokens, keys or personal data - none of those reach the decision record. It is a risk-reviewed proposal, NOT
 * investment advice, and approving it records a decision only: it places no order.
 */
export const CARD_DISCLAIMER = "This is a risk-reviewed proposal, not investment advice. Approving only records your decision; no order is placed and nothing is traded.";
const MAX_TEXT = 3500;

type Bucket = { amount?: number | undefined; pct?: number | undefined; count?: number | undefined };
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const bucket = (v: unknown): Bucket => { const o = obj(v); return { amount: num(o["amount"]) ?? undefined, pct: num(o["pct"]) ?? undefined, count: num(o["count"]) ?? undefined }; };
const SAFE = /^[A-Za-z0-9 &._:/@+-]{1,60}$/;
/** Anything that is not a short, plain token is replaced, so nothing free-form can reach the card. */
export const safeText = (v: unknown): string => (typeof v === "string" && SAFE.test(v) ? v : v === null || v === undefined ? "n/a" : "[withheld]");
const fmt = (v: number | null | undefined, dp = 2): string => (v === null || v === undefined ? "n/a" : Number(v.toFixed(dp)).toLocaleString("en-US", { maximumFractionDigits: dp }));
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? "n/a" : `${Number(v.toFixed(3))}%`);
const shortId = (id: unknown): string => (typeof id === "string" ? id.replace(/-/g, "").slice(0, 8) : "n/a");

export interface ApprovalCardData {
  decisionId: string;
  decisionVersion: number;
  market: string;
  instrumentType: string;
  symbol: string;
  expiry: string | null;
  strike: number | null;
  optionType: string | null;
  side: string;
  entryPrice: number | null;
  stopLoss: number | null;
  stopLossBasis: string | null;
  targets: number[];
  plannedQuantity: number | null;
  plannedNotional: number | null;
  plannedMaxLossAmount: number | null;
  plannedMaxLossPercent: number | null;
  riskReward: number | null;
  confidenceTier: string;
  confidenceScore: number | null;
  sourceTrustTier: string;
  portfolio: { totalBeforePct: number | null; totalAfterPct: number | null; activeBefore: number | null; activeAfter: number | null; group: string | null; groupBeforePct: number | null; groupAfterPct: number | null; underlyingAfterPct: number | null };
  session: { state: string; localTime: string | null; timezone: string | null };
  liquidity: { bidQty: number | null; askQty: number | null; volume: number | null; openInterest: number | null; spreadPct: number | null; dataAgeSeconds: number | null };
  blackout: { status: "NONE" | "WARNING" | "CRITICAL"; count: number };
  breaker: { daily: string; weekly: string };
  validUntil: string;
  keyRisks: string[];
  evidence: { riskDecision: string; stopLossValidation: string; previousVersions: string[]; marketInputHash: string; portfolioInputHash: string };
  disclaimer: string;
}

export function buildApprovalCardData(d: RiskDecisionRecord, extra: { breaker: CircuitBreakerStatus | null; validUntil: Date }): ApprovalCardData {
  const out = obj(d.outputSnapshot);
  const pf = obj(out["portfolio"]);
  const mk = obj(out["market"]);
  const cand = obj(pf["candidate"]);
  const resulting = obj(pf["resulting"]);
  const current = obj(pf["current"]);
  const observed = obj(mk["observed"]);
  const snap = obj(observed["snapshot"]);
  const gates = obj(mk["gates"]);
  const session = obj(observed["session"]);
  const windows = Array.isArray(mk["activeWindows"]) ? (mk["activeWindows"] as unknown[]) : [];
  const crit = windows.filter((w) => obj(w)["severity"] === "CRITICAL").length;
  const confScore = num(d.confidenceScore);
  const entry = num(d.entryPrice), stop = num(d.stopLoss);
  const targets = [d.target1, d.target2, d.target3].map(num).filter((x): x is number => x !== null);
  const data: ApprovalCardData = {
    decisionId: d.id, decisionVersion: d.decisionVersion, market: safeText(d.market), instrumentType: safeText(d.instrumentType), symbol: safeText(d.symbol), expiry: d.expiry, strike: num(d.strike), optionType: d.optionType ? safeText(d.optionType) : null,
    side: safeText(d.side), entryPrice: entry, stopLoss: stop, stopLossBasis: d.stopLossBasis ? safeText(d.stopLossBasis) : null, targets,
    plannedQuantity: num(d.plannedQuantity), plannedNotional: num(d.plannedNotional), plannedMaxLossAmount: num(d.plannedMaxLossAmount), plannedMaxLossPercent: num(d.plannedMaxLossPercent), riskReward: num(d.plannedRiskRewardRatio),
    confidenceTier: confScore === null ? "UNKNOWN" : confidenceTier(confScore, DEFAULT_SIZING_CONFIG), confidenceScore: confScore, sourceTrustTier: trustTier(d.sourceTrustTier),
    portfolio: {
      totalBeforePct: bucket(obj(current)["total"]).pct ?? null, totalAfterPct: bucket(obj(resulting)["total"]).pct ?? null, activeBefore: bucket(obj(current)["total"]).count ?? null, activeAfter: bucket(obj(resulting)["total"]).count ?? null,
      group: typeof cand["correlationGroup"] === "string" ? safeText(cand["correlationGroup"]) : null, groupBeforePct: bucket(obj(current)["group"]).pct ?? null, groupAfterPct: bucket(obj(resulting)["group"]).pct ?? null, underlyingAfterPct: bucket(obj(resulting)["underlying"]).pct ?? null,
    },
    session: { state: safeText(obj(obj(gates["session"])["observed"])["state"] ?? session["state"]), localTime: typeof session["localTime"] === "string" ? safeText(session["localTime"]) : null, timezone: typeof session["timezone"] === "string" ? safeText(session["timezone"]) : null },
    liquidity: { bidQty: num(snap["bidQty"]), askQty: num(snap["askQty"]), volume: num(snap["volume"]), openInterest: num(snap["openInterest"]), spreadPct: num(obj(gates["spread"])["observed"]), dataAgeSeconds: num(observed["ageSeconds"]) },
    blackout: { status: crit > 0 ? "CRITICAL" : windows.length > 0 ? "WARNING" : "NONE", count: windows.length },
    breaker: { daily: extra.breaker?.scopes.DAILY.status ?? "UNKNOWN", weekly: extra.breaker?.scopes.WEEKLY.status ?? "UNKNOWN" },
    validUntil: extra.validUntil.toISOString(), keyRisks: [], evidence: { riskDecision: shortId(d.id), stopLossValidation: shortId(d.stopLossValidationId), previousVersions: [], marketInputHash: "", portfolioInputHash: "" }, disclaimer: CARD_DISCLAIMER,
  };
  const refs = obj(d.evidenceReferences);
  data.evidence.previousVersions = [shortId(refs["previousDecisionId"])];
  data.evidence.marketInputHash = typeof refs["marketInputHash"] === "string" ? (refs["marketInputHash"] as string).slice(0, 12) : "n/a";
  data.evidence.portfolioInputHash = typeof refs["portfolioInputHash"] === "string" ? (refs["portfolioInputHash"] as string).slice(0, 12) : "n/a";
  data.keyRisks = keyRisks(data, extra.validUntil);
  return data;
}

/** Plain-language risks derived from the numbers on the card (never from free text). */
export function keyRisks(c: ApprovalCardData, validUntil: Date): string[] {
  const r: string[] = [];
  if (c.entryPrice && c.stopLoss) r.push(`The stop-loss is ${fmt((Math.abs(c.entryPrice - c.stopLoss) / c.entryPrice) * 100, 2)}% from the entry; the loss at the stop is the planned maximum, and a gap through the stop can lose more.`);
  if (c.instrumentType === "option") r.push("Options can lose the whole premium quickly, including on small adverse moves.");
  if (c.expiry) r.push(`Contract expiry ${c.expiry}: time decay and settlement rules apply.`);
  if (c.blackout.status === "WARNING") r.push("A WARNING event window is active for this market or symbol.");
  if (c.session.state !== "OPEN") r.push(`The market session is ${c.session.state}.`);
  if (c.liquidity.spreadPct !== null && c.liquidity.spreadPct > 0) r.push(`Bid/ask spread is ${pct(c.liquidity.spreadPct)}: entry and exit prices may differ from the quoted price.`);
  if ((c.portfolio.groupAfterPct ?? 0) >= 1.5) r.push(`Correlated exposure would reach ${pct(c.portfolio.groupAfterPct)} of capital.`);
  if (c.confidenceTier === "LOW" || c.sourceTrustTier === "LOW") r.push("Confidence or source trust is LOW: the position was sized down.");
  r.push(`This proposal is valid only until ${validUntil.toISOString().slice(0, 16).replace("T", " ")} UTC.`);
  return r.slice(0, 8);
}

export interface RenderedRiskCard { text: string; sha256: string }

export function renderApprovalCard(c: ApprovalCardData): RenderedRiskCard {
  const contract = [c.instrumentType.toUpperCase(), c.symbol, c.expiry ? `exp ${c.expiry}` : null, c.strike !== null ? `strike ${fmt(c.strike)}` : null, c.optionType].filter(Boolean).join(" ");
  const lines = [
    "TWINS RISK-REVIEWED PROPOSAL",
    c.disclaimer,
    "",
    `Market: ${c.market}   Instrument: ${contract}`,
    `Side: ${c.side}   Entry: ${fmt(c.entryPrice)}   Stop-loss: ${fmt(c.stopLoss)} (${c.stopLossBasis ?? "basis n/a"})`,
    `Targets: ${c.targets.length ? c.targets.map((t) => fmt(t)).join(" / ") : "none stated"}`,
    `Quantity: ${fmt(c.plannedQuantity, 0)}   Notional: ${fmt(c.plannedNotional)}`,
    `Planned maximum loss: ${fmt(c.plannedMaxLossAmount)} (${pct(c.plannedMaxLossPercent)} of capital)   Risk-reward: ${c.riskReward === null ? "n/a" : `1 : ${fmt(c.riskReward, 2)}`}`,
    `Confidence: ${c.confidenceTier}${c.confidenceScore === null ? "" : ` (${fmt(c.confidenceScore, 0)})`}   Source trust: ${c.sourceTrustTier}`,
    "",
    `Portfolio planned risk: ${pct(c.portfolio.totalBeforePct)} -> ${pct(c.portfolio.totalAfterPct)} of capital (${c.portfolio.activeBefore ?? "n/a"} -> ${c.portfolio.activeAfter ?? "n/a"} active)`,
    `Correlation group ${c.portfolio.group ?? "n/a"}: ${pct(c.portfolio.groupBeforePct)} -> ${pct(c.portfolio.groupAfterPct)}   Same underlying after: ${pct(c.portfolio.underlyingAfterPct)}`,
    `Market session: ${c.session.state}${c.session.localTime ? ` (${c.session.localTime} ${c.session.timezone ?? ""})` : ""}`,
    `Liquidity: bid qty ${fmt(c.liquidity.bidQty, 0)}, ask qty ${fmt(c.liquidity.askQty, 0)}, volume ${fmt(c.liquidity.volume, 0)}${c.liquidity.openInterest !== null ? `, OI ${fmt(c.liquidity.openInterest, 0)}` : ""}; spread ${pct(c.liquidity.spreadPct)}; data age ${c.liquidity.dataAgeSeconds === null ? "n/a" : `${fmt(c.liquidity.dataAgeSeconds, 0)} s`}`,
    `Event blackout: ${c.blackout.status}${c.blackout.count ? ` (${c.blackout.count} window${c.blackout.count > 1 ? "s" : ""})` : ""}`,
    `Loss circuit breakers: daily ${c.breaker.daily}, weekly ${c.breaker.weekly}`,
    `Valid until: ${c.validUntil.slice(0, 16).replace("T", " ")} UTC (after that it cannot be approved)`,
    "",
    "Key risks:",
    ...c.keyRisks.map((k) => `- ${k}`),
    "",
    `Evidence: decision ${c.evidence.riskDecision} v${c.decisionVersion}, stop-loss validation ${c.evidence.stopLossValidation}, previous ${c.evidence.previousVersions.join(",")}, portfolio ${c.evidence.portfolioInputHash}, market ${c.evidence.marketInputHash}`,
  ];
  let text = lines.join("\n");
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT - 20)}\n[truncated]`;
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}
