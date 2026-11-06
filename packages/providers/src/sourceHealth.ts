import { ALL_PROVIDERS, type ProviderName } from "./runner";

/**
 * Source health profile (P0 #2). A pure, read-only description of how healthy each provider file is, built from what is already on disk (file metadata and the document's own `as_of`) and,
 * optionally, the exporter's pass log. It stores nothing, changes nothing and is not read by any risk decision: it is evidence for people and for the decision card. Reason codes are fixed
 * words; nothing from a URL, a key, a headline or an error message is ever copied into the profile.
 */
export const HEALTH_STATUSES = ["OK", "DEGRADED", "STALE", "FAILING", "MISSING", "INVALID"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];
/** Worst first. */
const SEVERITY: Record<HealthStatus, number> = { INVALID: 5, MISSING: 4, FAILING: 3, STALE: 2, DEGRADED: 1, OK: 0 };

export interface FileObservation {
  provider: ProviderName;
  present: boolean;
  /** false when the file exists but is not a JSON object with a usable `as_of`. */
  readable: boolean;
  asOf: string | null;
  modifiedAt: string | null;
  format: string | null;
  source: string | null;
  count: number | null;
}
export interface PassEvent { at: string; provider: ProviderName; outcome: "published" | "failed" | "skipped"; reason: string | null }
export interface HealthPolicy {
  /** The document's `as_of` may be at most this old; null = not judged on data age. */
  dataMaxAgeHours: number | null;
  /** The file must have been rewritten within this many minutes (the exporter runs hourly; one missed pass is tolerated). */
  exportMaxAgeMinutes: number;
}
const EXPORT_MAX = 150;
export const DEFAULT_HEALTH_POLICY: Record<ProviderName, HealthPolicy> = {
  news: { dataMaxAgeHours: 6, exportMaxAgeMinutes: EXPORT_MAX },
  sentiment: { dataMaxAgeHours: 6, exportMaxAgeMinutes: EXPORT_MAX },
  calendar: { dataMaxAgeHours: 6, exportMaxAgeMinutes: EXPORT_MAX },
  // The macro and quote `as_of` is the OLDEST index timestamp, which only advances on a Kite feed run (and not at weekends), so it is judged on a longer horizon.
  macro: { dataMaxAgeHours: 72, exportMaxAgeMinutes: EXPORT_MAX },
  "market-quotes": { dataMaxAgeHours: 72, exportMaxAgeMinutes: EXPORT_MAX },
  holidays: { dataMaxAgeHours: 6, exportMaxAgeMinutes: EXPORT_MAX },
  constituents: { dataMaxAgeHours: 6, exportMaxAgeMinutes: EXPORT_MAX },
};

export interface ProviderHealth {
  provider: ProviderName;
  status: HealthStatus;
  /** Fixed codes explaining the status; empty when OK. */
  reasons: string[];
  asOf: string | null;
  dataAgeSeconds: number | null;
  modifiedAt: string | null;
  exportAgeSeconds: number | null;
  count: number | null;
  source: string | null;
  lastPass: { at: string; outcome: PassEvent["outcome"]; reason: string | null } | null;
  /** Consecutive failed passes at the end of the log (a skipped pass is a configuration state, not a failure). */
  consecutiveFailures: number | null;
  /** true when the data may be shown to agents as current: OK or DEGRADED. A stale, failing, missing or invalid source is not usable. */
  usable: boolean;
}
export interface SourceHealthProfile {
  generatedAt: string;
  overall: HealthStatus;
  passLogAvailable: boolean;
  counts: Record<HealthStatus, number>;
  providers: ProviderHealth[];
  /** Always false: a health profile is evidence, never an approval or a trading signal. */
  grantsApproval: false;
}

const REASON = /^[a-z0-9_.-]{1,60}$/;
const ms = (iso: string | null): number | null => { if (iso === null) return null; const t = Date.parse(iso); return Number.isNaN(t) ? null : t; };

/** Parses exporter pass-log lines (JSON per line). Anything that is not a pass event for a known provider is ignored; reasons that are not plain codes become `unrecognized`. */
export function parsePassLog(text: string): PassEvent[] {
  const out: PassEvent[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(s) as Record<string, unknown>; } catch { continue; }
    const ev = o["event"], provider = o["provider"], ts = o["ts"];
    if ((ev !== "provider.published" && ev !== "provider.failed" && ev !== "provider.skipped") || typeof provider !== "string" || typeof ts !== "string") continue;
    if (!(ALL_PROVIDERS as readonly string[]).includes(provider) || ms(ts) === null) continue;
    const reason = typeof o["reason"] === "string" ? (REASON.test(o["reason"]) ? o["reason"] : "unrecognized") : null;
    out.push({ at: new Date(ts).toISOString(), provider: provider as ProviderName, outcome: ev === "provider.published" ? "published" : ev === "provider.failed" ? "failed" : "skipped", reason });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export function buildSourceHealth(input: { now: Date; observations: readonly FileObservation[]; events?: readonly PassEvent[] | null; policy?: Partial<Record<ProviderName, HealthPolicy>> }): SourceHealthProfile {
  const now = input.now.getTime(), events = input.events ?? null;
  const providers: ProviderHealth[] = ALL_PROVIDERS.map((provider) => {
    const obs = input.observations.find((o) => o.provider === provider) ?? null;
    const policy = input.policy?.[provider] ?? DEFAULT_HEALTH_POLICY[provider];
    const reasons: string[] = [];
    const worst = (s: HealthStatus, status: { v: HealthStatus }): void => { if (SEVERITY[s] > SEVERITY[status.v]) status.v = s; };
    const status = { v: "OK" as HealthStatus };

    const asOfMs = ms(obs?.asOf ?? null), modMs = ms(obs?.modifiedAt ?? null);
    const dataAge = asOfMs === null ? null : Math.max(0, Math.round((now - asOfMs) / 1000));
    const exportAge = modMs === null ? null : Math.max(0, Math.round((now - modMs) / 1000));
    if (obs === null || !obs.present) { reasons.push("file_missing"); worst("MISSING", status); }
    else if (!obs.readable) { reasons.push("file_unreadable"); worst("INVALID", status); }
    else {
      if (policy.dataMaxAgeHours !== null && dataAge !== null && dataAge > policy.dataMaxAgeHours * 3600) { reasons.push("data_stale"); worst("STALE", status); }
      if (exportAge !== null && exportAge > policy.exportMaxAgeMinutes * 60) { reasons.push("export_stale"); worst("STALE", status); }
    }

    const mine = events === null ? null : events.filter((e) => e.provider === provider);
    const last = mine && mine.length > 0 ? mine[mine.length - 1]! : null;
    let consecutive: number | null = null;
    if (mine !== null) {
      consecutive = 0;
      for (let i = mine.length - 1; i >= 0 && mine[i]!.outcome !== "published"; i--) if (mine[i]!.outcome === "failed") consecutive++; else break;
    }
    if (mine !== null && last === null) reasons.push("no_pass_logged");
    else if (last !== null && last.outcome === "failed") {
      reasons.push(consecutive !== null && consecutive >= 2 ? "repeated_failures" : "last_pass_failed");
      worst(consecutive !== null && consecutive >= 2 ? "FAILING" : "DEGRADED", status);
    } else if (last !== null && last.outcome === "skipped") { reasons.push("last_pass_skipped"); worst("DEGRADED", status); }

    return {
      provider, status: status.v, reasons, asOf: obs?.asOf ?? null, dataAgeSeconds: dataAge, modifiedAt: obs?.modifiedAt ?? null, exportAgeSeconds: exportAge, count: obs?.count ?? null,
      source: obs?.source ?? null, lastPass: last === null ? null : { at: last.at, outcome: last.outcome, reason: last.reason }, consecutiveFailures: consecutive,
      usable: status.v === "OK" || status.v === "DEGRADED",
    };
  });
  const counts = Object.fromEntries(HEALTH_STATUSES.map((s) => [s, providers.filter((p) => p.status === s).length])) as Record<HealthStatus, number>;
  const overall = providers.reduce<HealthStatus>((w, p) => (SEVERITY[p.status] > SEVERITY[w] ? p.status : w), "OK");
  return { generatedAt: input.now.toISOString(), overall, passLogAvailable: events !== null, counts, providers, grantsApproval: false };
}
