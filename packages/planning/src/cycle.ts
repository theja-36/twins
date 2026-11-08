import { listActiveAccounts, listActiveControls, listCandidates, getEffectiveRiskPolicy, setRiskControl } from "@twins/database";
import { haltTriggers, DEFAULT_RISK_EXTRAS } from "./risk";
import { evaluateCandidateForAccount, type EvaluationDeps } from "./evaluate";

/** Evaluation settings. DISABLED by default; strict parsing (a malformed value throws at start-up). */
export interface EvaluationConfig { enabled: boolean; batchLimit: number; reevaluateMinutes: number }
export const DEFAULT_EVALUATION_CONFIG: EvaluationConfig = { enabled: false, batchLimit: 50, reevaluateMinutes: 15 };
export function loadEvaluationConfig(env: Record<string, string | undefined> = process.env): EvaluationConfig {
  const b = env["TWINS_EVALUATION_ENABLED"];
  if (b !== undefined && b !== "" && b !== "true" && b !== "false") throw new Error('TWINS_EVALUATION_ENABLED must be exactly "true" or "false"');
  const int = (n: string, d: number, lo: number, hi: number): number => { const v = env[n]; if (v === undefined || v === "") return d; const x = Number(v); if (!Number.isInteger(x) || x < lo || x > hi) throw new Error(`${n} must be an integer between ${lo} and ${hi}`); return x; };
  return { enabled: b === "true", batchLimit: int("TWINS_EVALUATION_BATCH", DEFAULT_EVALUATION_CONFIG.batchLimit, 1, 500), reevaluateMinutes: int("TWINS_EVALUATION_REEVALUATE_MINUTES", DEFAULT_EVALUATION_CONFIG.reevaluateMinutes, 1, 1440) };
}
export interface EvaluationCycleReport { skipped: "DISABLED" | null; candidates: number; accounts: number; evaluated: number; recent: number; notConfigured: number; failed: number; haltsSet: number; verdicts: Record<string, number> }
/** Evaluates every READY_FOR_DECISION candidate (either source) for every active account that has a capital profile and a risk policy, and records the daily-loss / drawdown halts the portfolio state calls for. One account's failure never stops the others. */
export async function runEvaluationCycle(d: EvaluationDeps & { config: EvaluationConfig; scope?: { underlyings: readonly string[] } }): Promise<EvaluationCycleReport> {
  const r: EvaluationCycleReport = { skipped: null, candidates: 0, accounts: 0, evaluated: 0, recent: 0, notConfigured: 0, failed: 0, haltsSet: 0, verdicts: {} };
  if (!d.config.enabled) return { ...r, skipped: "DISABLED" };
  const now = (d.now ?? (() => new Date()))(), X = d.extras ?? DEFAULT_RISK_EXTRAS;
  const cands = await listCandidates(d.db, { states: ["READY_FOR_DECISION"], limit: d.config.batchLimit, ...(d.scope ? { scope: d.scope } : {}) });
  const accounts = await listActiveAccounts(d.db);
  r.candidates = cands.length; r.accounts = accounts.length;
  for (const a of accounts) {
    // halts first: a breached daily or drawdown limit must be in force before anything else is evaluated for the account
    try {
      const pol = await getEffectiveRiskPolicy(d.db, a.userId, a.accountId, now);
      const pf = pol && d.portfolio ? await d.portfolio.portfolioFor({ userId: a.userId, accountId: a.accountId, now }) : null;
      if (pol && pf) {
        const active = await listActiveControls(d.db, a.userId, now);
        for (const h of haltTriggers(pf, { maxDailyLoss: pol.maxDailyLoss, maxDrawdownPct: pol.maxDrawdownPct }, X, now)) {
          if (active.some((k) => k.userId === a.userId && k.scope === "USER" && k.kind === h.kind)) continue;
          await setRiskControl(d.db, { scope: "USER", scopeKey: a.userId, kind: h.kind, userId: a.userId }, { reason: h.reason, actor: "planning-cycle", actorKind: "SYSTEM", expiresAt: h.expiresAt });
          r.haltsSet++;
        }
      }
    } catch (e) { r.failed++; d.log?.("planning.halt_check_failed", { errorName: e instanceof Error ? e.name : "Error" }); }
    for (const c of cands) {
      try {
        const o = await evaluateCandidateForAccount({ ...d, reevaluateMinutes: d.config.reevaluateMinutes }, { userId: a.userId, accountId: a.accountId, candidate: c });
        if (o.status === "EVALUATED") { r.evaluated++; r.verdicts[o.verdict] = (r.verdicts[o.verdict] ?? 0) + 1; } else if (o.status === "RECENT") r.recent++; else r.notConfigured++;
      } catch (e) { r.failed++; d.log?.("planning.evaluate_failed", { candidateId: c.id, errorName: e instanceof Error ? e.name : "Error" }); }
    }
  }
  return r;
}
