import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { driftEventOf, type DriftReport } from "./learning";
import type { ChannelProfile } from "./profile";

/**
 * Versioned channel playbooks (Modules 06 and 07). Learning is VERSIONED: a new playbook version starts as a DRAFT, must be EVALUATED on out-of-sample evidence, and can become ACTIVE
 * (able to influence live decision policy) only when the OWNER activates it. Automation can propose and evaluate, never activate. A rollback is a recorded event, not an edit.
 * Each version is mirrored by a `learning_versions` row (kind PLAYBOOK) whose state changes are appended to `learning_version_events`.
 */
export type PlaybookState = "DRAFT" | "EVALUATING" | "ACTIVE" | "RETIRED" | "ROLLED_BACK";
export type Actor = { kind: "OWNER" | "SYSTEM"; id: string };

const NEXT: Record<PlaybookState, readonly PlaybookState[]> = { DRAFT: ["EVALUATING", "RETIRED"], EVALUATING: ["ACTIVE", "DRAFT", "RETIRED"], ACTIVE: ["RETIRED", "ROLLED_BACK"], RETIRED: [], ROLLED_BACK: [] };
/** The ordinary transitions. RETIRED -> ACTIVE exists only through `rollbackPlaybook`. */
export const isLegalPlaybookTransition = (from: PlaybookState, to: PlaybookState): boolean => NEXT[from].includes(to);

export interface PlaybookEvaluation { outOfSample: boolean; resolved: number; driftFlag: boolean; evaluatedAt: string; metrics: Record<string, unknown> }
export const MIN_ACTIVATION_RESOLVED = 30;
/** The gate for letting a version influence live policy. Returns the reasons it is refused (empty = allowed). It never asks for profitability: it asks for honest, sufficient, out-of-sample evidence and an owner. */
export function activationRefusals(actor: Actor, evaluation: PlaybookEvaluation | null): string[] {
  const why: string[] = [];
  if (actor.kind !== "OWNER") why.push("only_the_owner_can_activate");
  if (evaluation === null) { why.push("not_evaluated"); return why; }
  if (!evaluation.outOfSample) why.push("evaluation_not_out_of_sample");
  if (evaluation.resolved < MIN_ACTIVATION_RESOLVED) why.push("evaluation_sample_too_small");
  if (evaluation.driftFlag) why.push("drift_detected");
  return why;
}

export interface PlaybookContent {
  description: string; entryContext: string; entryRules: Record<string, unknown>; exitRules: Record<string, unknown>; stopLossBehaviour: Record<string, unknown>; targetBehaviour: Record<string, unknown>; riskRules: Record<string, unknown>;
  preferredInstruments: string[]; preferredRegimes: string[]; historicalPerformance: null; sampleSize: number; confidence: string; limitations: string[]; profileVersion: string;
}
/** Builds the playbook text and rules from a channel profile. Deterministic. Performance is null until an out-of-sample evaluation exists; nothing is claimed about results. */
export function buildPlaybookContent(p: ChannelProfile): PlaybookContent {
  const top = (d: { top: string | null }, none: string): string => d.top ?? none;
  const instruments = Object.entries(p.underlyings.counts).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 3);
  const regimes = p.marketConditions.top ? [p.marketConditions.top] : [];
  return {
    description: `Observed style of this channel over ${p.sampleSize} signal(s): entry ${top(p.entryStyle, "no clear style")}, option side ${top(p.optionTypePreference, "no clear preference")}, setup ${top(p.setups, "not stated")}, horizon ${top(p.horizons, "not stated")}. Descriptive only.`,
    entryContext: `Usually sent in the ${top(p.tradingTimes, "no single")} session window; market condition ${top(p.marketConditions, "unknown")}.`,
    entryRules: { entryStyle: p.entryStyle.top, optionSide: p.optionTypePreference.top, strikeDistancePct: p.strikeDistancePct },
    exitRules: { targetCount: p.rules.targets.count, firstTargetDistancePct: p.rules.targets.firstDistancePct, rewardToRisk: p.rules.targets.rewardToRisk },
    stopLossBehaviour: { presentShare: p.rules.stop.presentShare, distancePct: p.rules.stop.distancePct, basisStatedShare: p.rules.stop.basisStatedShare },
    targetBehaviour: { count: p.rules.targets.count, firstDistancePct: p.rules.targets.firstDistancePct },
    riskRules: { bands: p.rules.risk.bands.counts, noStopShare: p.rules.risk.noStopShare },
    preferredInstruments: instruments, preferredRegimes: regimes, historicalPerformance: null, sampleSize: p.sampleSize, confidence: p.strategyConfidence, limitations: [...p.limitations], profileVersion: p.version,
  };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const P = schema.playbookVersions, L = schema.learningVersions, E = schema.learningVersionEvents;

export async function createPlaybook(db: Db, o: { sourceKind: "TELEGRAM_CHANNEL" | "INDEPENDENT"; telegramSourceId: string | null; name: string }): Promise<string> {
  const [row] = await db.insert(schema.strategyPlaybooks).values({ sourceKind: o.sourceKind, telegramSourceId: o.telegramSourceId, name: o.name }).returning({ id: schema.strategyPlaybooks.id });
  if (!row) throw new Error("playbook not created");
  return row.id;
}

/** Adds the next DRAFT version of a playbook (with its mirrored PROPOSED learning version and first event). Returns the new version id and number. */
export async function proposeVersion(db: Db, playbookId: string, content: PlaybookContent, actor: Actor): Promise<{ versionId: string; version: number }> {
  return db.transaction(async (tx) => {
    const last = await tx.select({ v: P.version }).from(P).where(eq(P.playbookId, playbookId)).orderBy(desc(P.version)).limit(1).for("update");
    const version = (last[0]?.v ?? 0) + 1;
    const [pv] = await tx.insert(P).values({ playbookId, version, state: "DRAFT", content, sampleSize: 0, limitations: content.limitations.join("; ") }).returning({ id: P.id });
    const [lv] = await tx.insert(L).values({ kind: "PLAYBOOK", subjectId: playbookId, version, state: "PROPOSED" }).returning({ id: L.id });
    if (!pv || !lv) throw new Error("version not created");
    await tx.insert(E).values({ learningVersionId: lv.id, fromState: null, toState: "PROPOSED", actor: `${actor.kind}:${actor.id}`, reason: "proposed" });
    return { versionId: pv.id, version };
  });
}

async function mirror(tx: Tx, playbookId: string, version: number): Promise<string> {
  const [row] = await tx.select({ id: L.id }).from(L).where(and(eq(L.kind, "PLAYBOOK"), eq(L.subjectId, playbookId), eq(L.version, version))).for("update");
  if (!row) throw new Error("mirrored learning version missing");
  return row.id;
}
const LEARNING_STATE: Record<PlaybookState, "PROPOSED" | "EVALUATING" | "ACTIVE" | "REJECTED" | "ROLLED_BACK"> = { DRAFT: "PROPOSED", EVALUATING: "EVALUATING", ACTIVE: "ACTIVE", RETIRED: "REJECTED", ROLLED_BACK: "ROLLED_BACK" };
export class PlaybookError extends Error { constructor(readonly code: string, readonly reasons: string[] = []) { super(code); } }

/**
 * Moves one version through the lifecycle. ACTIVE needs the owner and a passing out-of-sample evaluation, and retires the previously active version in the same transaction.
 * Every change is mirrored to the learning version and appended as an event. A refused move changes nothing.
 */
export async function transitionVersion(db: Db, versionId: string, to: PlaybookState, actor: Actor, reason: string, evaluation: PlaybookEvaluation | null = null): Promise<void> {
  await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(P).where(eq(P.id, versionId)).for("update");
    if (!cur) throw new PlaybookError("version_not_found");
    const from = cur.state as PlaybookState;
    if (!isLegalPlaybookTransition(from, to)) throw new PlaybookError("illegal_transition", [`${from}->${to}`]);
    if (to === "ACTIVE") {
      const why = activationRefusals(actor, evaluation); if (why.length) throw new PlaybookError("activation_refused", why);
      const prev = await tx.select().from(P).where(and(eq(P.playbookId, cur.playbookId), eq(P.state, "ACTIVE"))).for("update");
      for (const p of prev) await retire(tx, p.playbookId, p.version, p.id, "ACTIVE", actor, `superseded by version ${cur.version}`);
    }
    const lvId = await mirror(tx, cur.playbookId, cur.version);
    if (to === "ACTIVE" && evaluation) {
      await tx.update(P).set({ state: "ACTIVE", performance: evaluation.metrics, sampleSize: evaluation.resolved, updatedAt: new Date() }).where(eq(P.id, versionId));
      await tx.update(L).set({ state: "ACTIVE", evaluation, influencesLive: true, activatedAt: new Date() }).where(eq(L.id, lvId));
    } else {
      await tx.update(P).set({ state: to, updatedAt: new Date() }).where(eq(P.id, versionId));
      await tx.update(L).set({ state: LEARNING_STATE[to], influencesLive: false, ...(evaluation ? { evaluation } : {}) }).where(eq(L.id, lvId));
    }
    await tx.insert(E).values({ learningVersionId: lvId, fromState: LEARNING_STATE[from], toState: LEARNING_STATE[to], actor: `${actor.kind}:${actor.id}`, reason });
  });
}

async function retire(tx: Tx, playbookId: string, version: number, versionId: string, from: PlaybookState, actor: Actor, reason: string): Promise<void> {
  const lvId = await mirror(tx, playbookId, version);
  await tx.update(P).set({ state: "RETIRED", updatedAt: new Date() }).where(eq(P.id, versionId));
  await tx.update(L).set({ state: "REJECTED", influencesLive: false }).where(eq(L.id, lvId));
  await tx.insert(E).values({ learningVersionId: lvId, fromState: LEARNING_STATE[from], toState: "REJECTED", actor: `${actor.kind}:${actor.id}`, reason });
}

/**
 * Rolls the playbook back: the ACTIVE version becomes ROLLED_BACK and the most recent earlier RETIRED version that carries stored evaluation is made ACTIVE again.
 * Owner only. If there is no earlier evaluated version the playbook is simply left with no active version (nothing is invented).
 */
export async function rollbackPlaybook(db: Db, playbookId: string, actor: Actor, reason: string): Promise<{ rolledBack: number; restored: number | null }> {
  if (actor.kind !== "OWNER") throw new PlaybookError("activation_refused", ["only_the_owner_can_activate"]);
  return db.transaction(async (tx) => {
    const [active] = await tx.select().from(P).where(and(eq(P.playbookId, playbookId), eq(P.state, "ACTIVE"))).for("update");
    if (!active) throw new PlaybookError("no_active_version");
    const lvActive = await mirror(tx, playbookId, active.version);
    await tx.update(P).set({ state: "ROLLED_BACK", updatedAt: new Date() }).where(eq(P.id, active.id));
    await tx.update(L).set({ state: "ROLLED_BACK", influencesLive: false }).where(eq(L.id, lvActive));
    await tx.insert(E).values({ learningVersionId: lvActive, fromState: "ACTIVE", toState: "ROLLED_BACK", actor: `${actor.kind}:${actor.id}`, reason });
    const earlier = (await tx.select().from(P).where(and(eq(P.playbookId, playbookId), eq(P.state, "RETIRED"))).orderBy(desc(P.version)).for("update")).find((v) => v.version < active.version && v.performance !== null && v.sampleSize > 0);
    if (!earlier) return { rolledBack: active.version, restored: null };
    const lvEarlier = await mirror(tx, playbookId, earlier.version);
    const [lvRow] = await tx.select().from(L).where(eq(L.id, lvEarlier));
    await tx.update(P).set({ state: "ACTIVE", updatedAt: new Date() }).where(eq(P.id, earlier.id));
    await tx.update(L).set({ state: "ACTIVE", influencesLive: true, activatedAt: new Date(), evaluation: lvRow?.evaluation ?? earlier.performance }).where(eq(L.id, lvEarlier));
    await tx.insert(E).values({ learningVersionId: lvEarlier, fromState: "REJECTED", toState: "ACTIVE", actor: `${actor.kind}:${actor.id}`, reason: `rollback restored version ${earlier.version}: ${reason}` });
    return { rolledBack: active.version, restored: earlier.version };
  });
}

/** Records a drift or degradation alert for a playbook version (append-only `strategy_drift_events`). Returns false (writes nothing) when the report has nothing to record. */
export async function recordDriftEvent(db: Db, playbookId: string, version: number, report: DriftReport): Promise<boolean> {
  const e = driftEventOf(report);
  if (e === null) return false;
  await db.insert(schema.strategyDriftEvents).values({ playbookId, version, kind: e.kind, metric: e.metric, baseline: String(e.baseline), observed: String(e.observed), details: e.details });
  return true;
}
