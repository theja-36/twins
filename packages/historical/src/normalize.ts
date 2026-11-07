import { analyzeTelegramText, applySourceDefaultBasis, TELEGRAM_PARSER_VERSION, type ParsedSignal, type SourceBasisConfig } from "@twins/signals";
import { validateOptionsClaimStopLoss, validateStopLoss } from "@twins/stop-loss";

/**
 * Normalization of one historical message into the existing signal / options-claim model (Stage 4 / Task 1). It calls the EXISTING deterministic parser
 * (`analyzeTelegramText`, never an LLM) and the EXISTING shared stop-loss rule - no parsing is duplicated here. Nothing is guessed: a field the message does not state
 * is listed as MISSING, a field it states unclearly as AMBIGUOUS, and neither an expiry, strike, entry, stop-loss nor target is ever supplied. The one derived field is the
 * market of an index option (NIFTY / BANKNIFTY → NSE, SENSEX → BSE), labelled `underlying_mapping`; an explicit record market or batch default always wins.
 */
export const NORMALIZER_VERSION = "historical-normalizer-v1";
export const PARSER_VERSION = TELEGRAM_PARSER_VERSION;

export type ParseStatus = "SIGNAL" | "OPTIONS_CLAIM" | "AMBIGUOUS" | "UNSUPPORTED" | "NO_SIGNAL";
export type ValidationResult = "VALID" | "INCOMPLETE" | "AMBIGUOUS" | "UNSUPPORTED" | "NOT_A_SIGNAL";
export type MarketSource = "record" | "batch_default" | "underlying_mapping";

export interface NormalizedFields {
  parseStatus: ParseStatus;
  market: string | null;
  marketSource: MarketSource | null;
  instrumentType: string | null;
  underlying: string | null;
  expiry: unknown;
  expiryDate: string | null;
  strike: number | null;
  optionType: string | null;
  side: string | null;
  entry: unknown;
  stopLoss: number | null;
  levelBasis: string | null;
  targets: number[];
  timeValidity: string | null;
  conditions: string[];
  missingFields: string[];
  ambiguousFields: string[];
  validationResult: ValidationResult;
  stopLossValidation: { ruleVersion: string; result: string; reasonCode: string | null; detail: string | null } | null;
  parsed: unknown;
  warnings: string[];
}

const INDEX_MARKET: Record<string, string> = { NIFTY: "NSE", BANKNIFTY: "NSE", SENSEX: "BSE" };

function resolveMarket(recordMarket: string | null, defaultMarket: string | null, underlying: string | null): { market: string | null; marketSource: MarketSource | null } {
  if (recordMarket) return { market: recordMarket, marketSource: "record" };
  if (defaultMarket) return { market: defaultMarket, marketSource: "batch_default" };
  const mapped = underlying ? INDEX_MARKET[underlying] : undefined;
  return mapped ? { market: mapped, marketSource: "underlying_mapping" } : { market: null, marketSource: null };
}

const blank = (status: ParseStatus, validation: ValidationResult): NormalizedFields => ({
  parseStatus: status, market: null, marketSource: null, instrumentType: null, underlying: null, expiry: null, expiryDate: null, strike: null, optionType: null, side: null, entry: null, stopLoss: null,
  levelBasis: null, targets: [], timeValidity: null, conditions: [], missingFields: [], ambiguousFields: [], validationResult: validation, stopLossValidation: null, parsed: null, warnings: [],
});

const slv = (v: { ruleVersion: string; result: string; reasonCode: string | null; detail: string | null }) => ({ ruleVersion: v.ruleVersion, result: v.result, reasonCode: v.reasonCode, detail: v.detail });

function decide(f: NormalizedFields): void {
  if (f.missingFields.length > 0) f.validationResult = "INCOMPLETE";
  else if (f.ambiguousFields.length > 0 || (f.stopLossValidation && f.stopLossValidation.result !== "VALID")) f.validationResult = "AMBIGUOUS";
  else f.validationResult = "VALID";
  if (f.stopLossValidation && f.stopLossValidation.result !== "VALID" && f.stopLossValidation.result !== "MISSING") f.warnings.push(`stop_loss_${f.stopLossValidation.result.toLowerCase()}`);
}

export function normalizeText(text: string, ctx: { recordMarket: string | null; defaultMarket: string | null; /** Channel label of the record, for the per-source default level basis. */ source?: string | null; sourceBasis?: SourceBasisConfig }): NormalizedFields {
  const a = analyzeTelegramText(text);
  if (a.kind === "none") { const f = blank("NO_SIGNAL", "NOT_A_SIGNAL"); if (a.reason === "result_report") f.warnings.push("result_report"); return f; }
  if (a.kind === "ambiguous") {
    const f = blank("AMBIGUOUS", "AMBIGUOUS");
    f.ambiguousFields = ["directives"];
    f.parsed = { directives: a.directives, optionsRelated: a.optionsRelated === true };
    f.warnings.push("several_directives");
    return f;
  }
  if (a.kind === "options_unsupported") {
    const f = blank("UNSUPPORTED", "UNSUPPORTED");
    f.parsed = { symbol: a.symbol, form: a.form };
    f.warnings.push("unsupported_options_shape");
    return f;
  }
  if (a.kind === "signal") {
    const s: ParsedSignal = a.signal;
    const f = blank("SIGNAL", "INCOMPLETE");
    const m = resolveMarket(ctx.recordMarket, ctx.defaultMarket, null);
    Object.assign(f, { ...m, instrumentType: "equity", underlying: s.symbol, side: s.direction, entry: s.entryPrice === undefined ? null : { type: "at", price: s.entryPrice }, stopLoss: s.stopLoss ?? null, targets: s.targets, timeValidity: s.timeframe ?? null, parsed: s });
    if (!f.market) f.missingFields.push("market");
    if (s.entryPrice === undefined) f.missingFields.push("entry");
    if (s.stopLoss === undefined) f.missingFields.push("stop_loss");
    if (s.targets.length === 0) f.missingFields.push("targets");
    f.stopLossValidation = slv(validateStopLoss({ instrumentType: "equity", side: s.direction, stopLoss: s.stopLoss ?? null, entryPrice: s.entryPrice ?? null, levelBasis: "price" }));
    decide(f);
    return f;
  }
  const c = ctx.sourceBasis ? applySourceDefaultBasis(a.claim, ctx.source ?? null, ctx.sourceBasis) : a.claim;
  const f = blank("OPTIONS_CLAIM", "INCOMPLETE");
  if (c !== a.claim) f.warnings.push("level_basis_inferred_source_default");
  const m = resolveMarket(ctx.recordMarket, ctx.defaultMarket, c.underlying);
  const e = c.expiry;
  Object.assign(f, {
    ...m, instrumentType: "option", underlying: c.underlying, expiry: e, expiryDate: e.status === "full" ? `${String(e.year).padStart(4, "0")}-${String(e.month).padStart(2, "0")}-${String(e.day).padStart(2, "0")}` : null,
    strike: c.strike, optionType: c.optionType, side: c.action, entry: c.entry, stopLoss: c.stopLoss, levelBasis: c.levelBasis, targets: c.targets, parsed: c,
  });
  if (c.entry.type === "above" || c.entry.type === "below" || c.entry.type === "near" || c.entry.type === "range") f.conditions.push(`entry_${c.entry.type}`);
  if (!c.action) f.missingFields.push("action");
  if (c.strike === null) (c.compactCodeUnrecognized ? f.ambiguousFields : f.missingFields).push("strike");
  if (c.optionType === null) (c.optionTypeConflict ? f.ambiguousFields : f.missingFields).push("option_type");
  if (e.status === "missing") f.missingFields.push("expiry");
  else if (e.status !== "full") f.ambiguousFields.push("expiry");
  if (c.entry.type === "unspecified") f.missingFields.push("entry");
  if (c.stopLoss === null) f.missingFields.push("stop_loss");
  if (c.targets.length === 0) f.missingFields.push("targets");
  if (c.levelBasis === "unspecified") (c.levelBasisConflict ? f.ambiguousFields : f.missingFields).push("level_basis");
  if (c.intent === "unresolved" && c.action) f.ambiguousFields.push("intent");
  if (!f.market) f.missingFields.push("market");
  f.stopLossValidation = slv(validateOptionsClaimStopLoss(c));
  decide(f);
  return f;
}
