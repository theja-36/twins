/**
 * Deterministic data-quality checks applied at ingestion time (spec
 * section 21). These are structural/statistical checks only - no AI
 * inference belongs here (spec section 25/61: Phase 4 is OBSERVED data).
 *
 * A record that fails validity is REJECTED before it ever reaches
 * PostgreSQL - "must NOT silently become valid" (spec section 21) is
 * simplest to guarantee by never persisting it as if it were a real
 * observation. Borderline records (incomplete OHLC, stale relative to a
 * freshness threshold) ARE persisted, but tagged with the matching
 * `data_quality_status` so nothing downstream treats them as pristine.
 */

export type QualityStatus = "ok" | "stale" | "incomplete";

export interface QualityCheckResult {
  valid: boolean;
  status: QualityStatus;
  reasons: string[];
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export interface MarketBarQualityInput {
  observedAt: unknown;
  open?: number | undefined;
  high?: number | undefined;
  low?: number | undefined;
  close?: number | undefined;
  volume?: number | undefined;
  timeframe: unknown;
  receivedAt: Date;
  /** If provided, bars older than this many ms (relative to receivedAt) are marked stale. */
  maxStalenessMs?: number | undefined;
}

export function checkMarketBarQuality(input: MarketBarQualityInput): QualityCheckResult {
  const reasons: string[] = [];

  if (!isValidDate(input.observedAt)) reasons.push("observedAt is missing or invalid");
  if (typeof input.timeframe !== "string" || input.timeframe.trim() === "") {
    reasons.push("timeframe is missing");
  }

  const fields: Array<[string, number | undefined]> = [
    ["open", input.open],
    ["high", input.high],
    ["low", input.low],
    ["close", input.close],
    ["volume", input.volume],
  ];
  const presentFields = fields.filter(([, v]) => v !== undefined);

  for (const [name, value] of presentFields) {
    if (!isFiniteNumber(value)) reasons.push(`${name} is not a finite number`);
  }
  if (isFiniteNumber(input.open) && input.open < 0) reasons.push("open is negative");
  if (isFiniteNumber(input.high) && input.high < 0) reasons.push("high is negative");
  if (isFiniteNumber(input.low) && input.low < 0) reasons.push("low is negative");
  if (isFiniteNumber(input.close) && input.close < 0) reasons.push("close is negative");
  if (isFiniteNumber(input.volume) && input.volume < 0) reasons.push("volume is negative");
  if (isFiniteNumber(input.high) && isFiniteNumber(input.low) && input.high < input.low) {
    reasons.push("high is less than low");
  }
  if (presentFields.length === 0) reasons.push("no OHLCV fields present");

  if (reasons.length > 0) {
    return { valid: false, status: "incomplete", reasons };
  }

  const isComplete = ["open", "high", "low", "close"].every(
    (name) => fields.find(([n]) => n === name)?.[1] !== undefined,
  );

  if (
    input.maxStalenessMs !== undefined &&
    isValidDate(input.observedAt) &&
    input.receivedAt.getTime() - input.observedAt.getTime() > input.maxStalenessMs
  ) {
    return { valid: true, status: "stale", reasons: ["observedAt exceeds freshness threshold"] };
  }

  return { valid: true, status: isComplete ? "ok" : "incomplete", reasons: [] };
}

export interface MacroObservationQualityInput {
  observedAt: unknown;
  value: unknown;
  region: unknown;
  seriesCode: unknown;
}

export function checkMacroObservationQuality(
  input: MacroObservationQualityInput,
): QualityCheckResult {
  const reasons: string[] = [];
  if (!isValidDate(input.observedAt)) reasons.push("observedAt is missing or invalid");
  if (!isFiniteNumber(input.value)) reasons.push("value is not a finite number");
  if (typeof input.region !== "string" || input.region.trim() === "") {
    reasons.push("region is missing");
  }
  if (typeof input.seriesCode !== "string" || input.seriesCode.trim() === "") {
    reasons.push("seriesCode is missing");
  }
  if (reasons.length > 0) return { valid: false, status: "incomplete", reasons };
  return { valid: true, status: "ok", reasons: [] };
}

export interface NewsItemQualityInput {
  headline: unknown;
  sourceUrl: unknown;
  sourceTimestamp: unknown;
}

export function checkNewsItemQuality(input: NewsItemQualityInput): QualityCheckResult {
  const reasons: string[] = [];
  if (typeof input.headline !== "string" || input.headline.trim() === "") {
    reasons.push("headline is missing");
  }
  if (typeof input.sourceUrl !== "string" || input.sourceUrl.trim() === "") {
    reasons.push("sourceUrl is missing");
  } else {
    try {
      // eslint-disable-next-line no-new
      new URL(input.sourceUrl);
    } catch {
      reasons.push("sourceUrl is not a valid URL");
    }
  }
  if (!isValidDate(input.sourceTimestamp)) {
    reasons.push("sourceTimestamp is missing or invalid");
  }
  if (reasons.length > 0) return { valid: false, status: "incomplete", reasons };
  return { valid: true, status: "ok", reasons: [] };
}

export interface TelegramMessageQualityInput {
  externalMessageId: unknown;
  messageTimestamp: unknown;
  rawText: unknown;
}

export function checkTelegramMessageQuality(
  input: TelegramMessageQualityInput,
): QualityCheckResult {
  const reasons: string[] = [];
  if (typeof input.externalMessageId !== "string" || input.externalMessageId.trim() === "") {
    reasons.push("externalMessageId is missing");
  }
  if (!isValidDate(input.messageTimestamp)) {
    reasons.push("messageTimestamp is missing or invalid");
  }
  if (typeof input.rawText !== "string" || input.rawText.trim() === "") {
    reasons.push("rawText is missing");
  }
  if (reasons.length > 0) return { valid: false, status: "incomplete", reasons };
  return { valid: true, status: "ok", reasons: [] };
}
