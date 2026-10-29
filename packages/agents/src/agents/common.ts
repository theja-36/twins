import type { AgentEvidence, AgentFinding, AgentOutput, AgentVerdict, FindingSeverity } from "../contract";

/** Collects the findings of an agent's checks and derives its verdict: the WORST finding level decides (BLOCKING > ADVERSE > CAUTION > SUPPORTIVE). Nothing is ever guessed to pass. */
export type Level = "BLOCKING" | "ADVERSE" | "CAUTION" | "INFO";
const SEVERITY: Record<Level, FindingSeverity> = { BLOCKING: "CRITICAL", ADVERSE: "HIGH", CAUTION: "MEDIUM", INFO: "INFO" };
const RANK: Record<Level, number> = { BLOCKING: 0, ADVERSE: 1, CAUTION: 2, INFO: 3 };

export class Collector {
  readonly items: Array<{ level: Level; finding: AgentFinding }> = [];
  checks = 0;
  /** Counts a check (pass or fail). */
  check(): void { this.checks += 1; }
  add(level: Level, code: string, summary: string, detail?: AgentFinding["detail"]): void {
    this.items.push({ level, finding: { code, severity: SEVERITY[level], summary, ...(detail ? { detail } : {}) } });
  }
  count(level: Level): number { return this.items.filter((i) => i.level === level).length; }
  verdict(): AgentVerdict { return this.count("BLOCKING") > 0 ? "BLOCKING" : this.count("ADVERSE") > 0 ? "ADVERSE" : this.count("CAUTION") > 0 ? "CAUTION" : "SUPPORTIVE"; }
  /** Deterministic confidence in the verdict: a structural rule that fired is certain; the absence of findings cannot prove everything is fine. */
  confidence(): number { const v = this.verdict(); return v === "BLOCKING" ? 100 : v === "ADVERSE" ? 90 : v === "CAUTION" ? 85 : 90; }
  /** At most 20 findings, most severe first (then by code); reports whether any were dropped. */
  findings(): { list: AgentFinding[]; truncated: boolean } {
    const sorted = [...this.items].sort((a, b) => RANK[a.level] - RANK[b.level] || (a.finding.code < b.finding.code ? -1 : a.finding.code > b.finding.code ? 1 : 0));
    return { list: sorted.slice(0, 20).map((i) => i.finding), truncated: sorted.length > 20 };
  }
  output(evidence: AgentEvidence[], extra: Record<string, unknown> = {}): AgentOutput {
    const { list, truncated } = this.findings();
    return {
      verdict: this.verdict(), confidence: this.confidence(), findings: list, evidence,
      output: { checksRun: this.checks, blockingCount: this.count("BLOCKING"), adverseCount: this.count("ADVERSE"), cautionCount: this.count("CAUTION"), failedCodes: [...new Set(this.items.filter((i) => i.level !== "INFO").map((i) => i.finding.code))].sort(), truncatedFindings: truncated, ...extra },
    };
  }
}
export const COMMON_OUTPUT_FIELDS = {
  checksRun: { type: "number" as const, required: true }, blockingCount: { type: "number" as const, required: true }, adverseCount: { type: "number" as const, required: true },
  cautionCount: { type: "number" as const, required: true }, failedCodes: { type: "string[]" as const, required: true }, truncatedFindings: { type: "boolean" as const, required: true },
};
export const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
/** A real calendar date in YYYY-MM-DD form. */
export function isRealDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
export const evidenceRef = (kind: string, id: unknown): AgentEvidence[] => (typeof id === "string" && /^[A-Za-z0-9_.:/#@=-]{1,160}$/.test(id) ? [{ kind, ref: `${kind}:${id}` }] : []);
