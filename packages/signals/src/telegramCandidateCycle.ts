import { getRevisionStates, type RevisionState } from "@twins/ingestion";
import { listActiveTelegramCandidates, listPendingClaims, recordCandidacy, type ActiveRow, type Db, type PendingClaim } from "@twins/database";
import { classifySignal } from "./classification/classify";
import { storeClassification } from "./classification/persist";
import type { ClassificationResult } from "./classification/types";
import type { OptionsClaim } from "./options/types";
import { DEFAULT_TELEGRAM_CANDIDACY, evaluateTelegramClaim, originKeyOf, type ActiveTelegramCandidate, type TelegramCandidacyConfig } from "./telegramCandidate";

/**
 * The Telegram claim -> candidate cycle (Stage 03, G-19). ONE bounded batch per run: it reads parsed claims that have no decision yet, applies the pure policy and records each decision (candidate + append-only audit) atomically.
 * A new NEW candidate is then claimed by the SHARED research dispatch exactly like an independent one (the dispatcher is source-agnostic): this cycle never researches, ranks, sizes, decides or approves anything.
 * Safe to repeat and to run in two workers at once (unique per claim and per policy version). A claim that fails for an infrastructure reason is NOT recorded, so the next run retries it; each claim is isolated from the others.
 * Off by default (TWINS_TELEGRAM_CANDIDATES_ENABLED) and stops when the intake control or the kill switch says so.
 */
export interface TelegramCandidateRunConfig extends TelegramCandidacyConfig { enabled: boolean; batch: number; lookbackHours: number; intervalMs: number }
export const DEFAULT_TELEGRAM_CANDIDATE_RUN: TelegramCandidateRunConfig = { ...DEFAULT_TELEGRAM_CANDIDACY, enabled: false, batch: 50, lookbackHours: 24, intervalMs: 60_000 };
export function loadTelegramCandidateConfig(env: Record<string, string | undefined> = process.env): TelegramCandidateRunConfig {
  const d = DEFAULT_TELEGRAM_CANDIDATE_RUN, b = env["TWINS_TELEGRAM_CANDIDATES_ENABLED"];
  if (b !== undefined && b !== "" && b !== "true" && b !== "false") throw new Error('TWINS_TELEGRAM_CANDIDATES_ENABLED must be exactly "true" or "false"');
  const num = (n: string, def: number, lo: number, hi: number): number => { const v = env[n]; if (v === undefined || v === "") return def; const x = Number(v); if (!Number.isFinite(x) || !Number.isInteger(x) || x < lo || x > hi) throw new Error(`${n} must be an integer between ${lo} and ${hi}`); return x; };
  return { ...d, enabled: b === "true", ttlMinutes: num("TWINS_TELEGRAM_CANDIDATE_TTL_MINUTES", d.ttlMinutes, 5, 1440), batch: num("TWINS_TELEGRAM_CANDIDATE_BATCH", d.batch, 1, 500), lookbackHours: num("TWINS_TELEGRAM_CANDIDATE_LOOKBACK_HOURS", d.lookbackHours, 1, 168), intervalMs: num("TWINS_TELEGRAM_CANDIDATE_INTERVAL_MS", d.intervalMs, 10_000, 3_600_000), maxCaptureDelaySeconds: num("TWINS_TELEGRAM_CANDIDATE_MAX_DELAY_SECONDS", d.maxCaptureDelaySeconds, 1, 86_400) };
}
export interface TelegramCandidateDeps {
  db: Db; config: TelegramCandidateRunConfig; now?: () => Date; log?: (event: string, fields: Record<string, unknown>) => void;
  /** The runtime safety state (intake control and kill switch). Absent: always allowed (tests). */
  allowed?: () => Promise<boolean>;
  /** Restricts the cycle to some channels (a rollout or test scope); absent: every channel. */
  scope?: { sourceIds?: readonly string[] };
}
export interface TelegramCandidateReport { skipped: "DISABLED" | "SAFETY_STOPPED" | null; examined: number; created: number; superseded: number; byOutcome: Record<string, number>; failed: number }
const empty = (): TelegramCandidateReport => ({ skipped: null, examined: 0, created: 0, superseded: 0, byOutcome: {}, failed: 0 });
const isClaim = (v: unknown): v is OptionsClaim => typeof v === "object" && v !== null && "underlying" in v && "entry" in v && "targets" in v;

function toActive(r: ActiveRow): ActiveTelegramCandidate | null {
  if (!isClaim(r.claim)) return null;
  return { id: r.id, claimId: r.claimId, originKey: originKeyOf({ sourceId: r.sourceId, externalMessageId: r.externalMessageId, originMessageId: r.originMessageId }), underlying: r.underlying, strike: r.strike, optionType: r.optionType, side: r.side, entryKind: r.entryKind, entryLow: r.entryLow, entryHigh: r.entryHigh, stopLoss: r.stopLoss, targets: r.targets, view: r.claim.impliedUnderlyingView, messageTimestamp: r.messageTimestamp, candidateVersion: r.candidateVersion };
}
async function revisionOf(db: Db, c: PendingClaim): Promise<"current" | "superseded" | "ambiguous" | "unknown"> {
  const origin = c.originMessageId ?? (c.externalMessageId.endsWith("_edit") ? c.externalMessageId.replace(/_edit$/, "") : null);
  if (!origin) return "unknown";
  const states = await getRevisionStates(db, c.sourceId, origin);
  const mine = states.find((s) => s.id === c.messageId);
  return mine ? (mine.state as RevisionState) : "unknown";
}

export async function runTelegramCandidateCycle(d: TelegramCandidateDeps): Promise<TelegramCandidateReport> {
  const out = empty();
  if (!d.config.enabled) return { ...out, skipped: "DISABLED" };
  if (d.allowed && !(await d.allowed())) return { ...out, skipped: "SAFETY_STOPPED" };
  const now = (d.now ?? (() => new Date()))(), since = new Date(now.getTime() - d.config.lookbackHours * 3_600_000);
  const pending = await listPendingClaims(d.db, { policyVersion: d.config.policyVersion, since, limit: d.config.batch, ...(d.scope?.sourceIds ? { sourceIds: d.scope.sourceIds } : {}) });
  const activeBySource = new Map<string, ActiveTelegramCandidate[]>();
  for (const c of pending) {
    out.examined++;
    try {
      if (!isClaim(c.claim)) { out.failed++; d.log?.("telegram.candidate.bad_claim", { claimId: c.claimId }); continue; }
      let active = activeBySource.get(c.sourceId);
      if (!active) { active = (await listActiveTelegramCandidates(d.db, { sourceId: c.sourceId, since })).map(toActive).filter((x): x is ActiveTelegramCandidate => x !== null); activeBySource.set(c.sourceId, active); }
      let classification: ClassificationResult | null = null;
      try { classification = classifySignal({ claim: c.claim, messageText: c.rawText, messageTimestamp: c.messageTimestamp }); await storeClassification(d.db, c.claimId, classification); } catch { classification = null; } // evidence only: a classifier failure never blocks, and never invents a value
      const decision = evaluateTelegramClaim({ claimId: c.claimId, parserVersion: c.parserVersion, claim: c.claim, message: { id: c.messageId, sourceId: c.sourceId, externalMessageId: c.externalMessageId, originMessageId: c.originMessageId, messageTimestamp: c.messageTimestamp, receivedAt: c.receivedAt, observedAt: c.observedAt, firstSeenEdited: c.firstSeenEdited, captureMethod: c.captureMethod, editDate: c.editDate }, revision: await revisionOf(d.db, c), classification, now, active, cfg: d.config });
      const base = { claimId: c.claimId, policyVersion: d.config.policyVersion, now };
      const res = decision.outcome === "CREATED"
        ? await recordCandidacy(d.db, { ...base, outcome: "CREATED", reasons: decision.reasons, detail: { supersedes: decision.supersedes }, draft: decision.draft, supersedes: decision.supersedes })
        : decision.outcome === "DUPLICATE"
          ? await recordCandidacy(d.db, { ...base, outcome: "DUPLICATE", reasons: decision.reasons, detail: {}, duplicateOf: decision.duplicateOf })
          : await recordCandidacy(d.db, { ...base, outcome: decision.outcome, reasons: decision.reasons, detail: decision.detail });
      if (!res.recorded) continue; // another worker decided this claim first
      out.byOutcome[decision.outcome] = (out.byOutcome[decision.outcome] ?? 0) + 1;
      if (res.created && decision.outcome === "CREATED" && res.candidateId) {
        out.created++; out.superseded += res.superseded;
        const gone = new Set(decision.supersedes);
        activeBySource.set(c.sourceId, [...active.filter((a) => !gone.has(a.id)), { id: res.candidateId, claimId: c.claimId, originKey: originKeyOf(c), underlying: decision.draft.underlying, strike: decision.draft.strike, optionType: decision.draft.optionType, side: "BUY", entryKind: decision.draft.entryKind, entryLow: decision.draft.entryLow, entryHigh: decision.draft.entryHigh, stopLoss: decision.draft.stopLoss, targets: decision.draft.targets, view: c.claim.impliedUnderlyingView, messageTimestamp: c.messageTimestamp, candidateVersion: decision.draft.candidateVersion }]);
      }
    } catch (e) { out.failed++; d.log?.("telegram.candidate.failed", { claimId: c.claimId, errorName: e instanceof Error ? e.name : "Error" }); } // the name only: a message could embed row values
  }
  return out;
}
