import { listActiveAccounts, listActiveControls, listCandidates, getEffectiveRiskPolicy, recordUserHalt } from "@twins/database";
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
/** `haltCheckFailed`: accounts whose halt state could not be established this cycle (their candidates were NOT evaluated: fail closed). `haltConfigFault`: at least one of them failed with a configuration error (permission denied or missing function), which a retry cannot fix and an operator must see. */
export interface EvaluationCycleReport { skipped: "DISABLED" | null; candidates: number; accounts: number; evaluated: number; recent: number; notConfigured: number; failed: number; haltsSet: number; haltCheckFailed: number; haltConfigFault: boolean; verdicts: Record<string, number> }
const pgCode = (e: unknown): string | null => { const o = e as { code?: unknown; cause?: { code?: unknown } } | null; const c = o?.code ?? o?.cause?.code; return typeof c === "string" ? c : null; };
/** SQLSTATE 42501 (insufficient privilege) and 42883 (undefined function): the runtime role cannot call the halt door. Not retried. */
const CONFIG_FAULT = new Set(["42501", "42883"]);
/** Evaluates every READY_FOR_DECISION candidate (either source) for every active account that has a capital profile and a risk policy, and records the daily-loss / drawdown halts the portfolio state calls for. One account's failure never stops the others. */
export async function runEvaluationCycle(d: EvaluationDeps & { config: EvaluationConfig; scope?: { underlyings: readonly string[] } }): Promise<EvaluationCycleReport> {
  const r: EvaluationCycleReport = { skipped: null, candidates: 0, accounts: 0, evaluated: 0, recent: 0, notConfigured: 0, failed: 0, haltsSet: 0, haltCheckFailed: 0, haltConfigFault: false, verdicts: {} };
  if (!d.config.enabled) return { ...r, skipped: "DISABLED" };
  const now = (d.now ?? (() => new Date()))(), X = d.extras ?? DEFAULT_RISK_EXTRAS;
  const cands = await listCandidates(d.db, { states: ["READY_FOR_DECISION"], limit: d.config.batchLimit, ...(d.scope ? { scope: d.scope } : {}) });
  const accounts = await listActiveAccounts(d.db);
  r.candidates = cands.length; r.accounts = accounts.length;
  for (const a of accounts) {
    // halts first: a breached daily or drawdown limit must be in force before anything else is evaluated for the account.
    // FAIL CLOSED: if the risk state cannot be read, or a required halt cannot be persisted, this account's candidates are NOT evaluated this cycle (no silent continue). One bounded retry for a transient failure; a configuration fault is not retried.
    let established = false, lastError: unknown = null;
    for (let attempt = 0; attempt < 2 && !established; attempt++) {
      try {
        const pol = await getEffectiveRiskPolicy(d.db, a.userId, a.accountId, now);
        const pf = pol && d.portfolio ? await d.portfolio.portfolioFor({ userId: a.userId, accountId: a.accountId, now }) : null;
        let set = 0;
        if (pol && pf) {
          const active = await listActiveControls(d.db, a.userId, now);
          for (const h of haltTriggers(pf, { maxDailyLoss: pol.maxDailyLoss, maxDrawdownPct: pol.maxDrawdownPct }, X, now)) {
            if (active.some((k) => k.userId === a.userId && k.scope === "USER" && k.kind === h.kind)) continue;
            await recordUserHalt(d.db, a.userId, { kind: h.kind, reason: h.reason, expiresAt: h.expiresAt });
            set++;
          }
        }
        r.haltsSet += set; established = true;
      } catch (e) { lastError = e; if (CONFIG_FAULT.has(pgCode(e) ?? "")) break; }
    }
    if (!established) {
      const code = pgCode(lastError), configFault = CONFIG_FAULT.has(code ?? "");
      r.failed++; r.haltCheckFailed++; if (configFault) r.haltConfigFault = true;
      d.log?.("planning.halt_write_failed", { errorName: lastError instanceof Error ? lastError.name : "Error", code, configFault, failClosed: true });
      continue;
    }
    for (const c of cands) {
      try {
        const o = await evaluateCandidateForAccount({ ...d, reevaluateMinutes: d.config.reevaluateMinutes }, { userId: a.userId, accountId: a.accountId, candidate: c });
        if (o.status === "EVALUATED") { r.evaluated++; r.verdicts[o.verdict] = (r.verdicts[o.verdict] ?? 0) + 1; } else if (o.status === "RECENT") r.recent++; else r.notConfigured++;
      } catch (e) { r.failed++; d.log?.("planning.evaluate_failed", { candidateId: c.id, errorName: e instanceof Error ? e.name : "Error" }); }
    }
  }
  return r;
}
