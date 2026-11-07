import { schema, type Db } from "@twins/database";

/**
 * Durable shadow observations (HB-25): the WRITER (it lives in the worker, not in the agents package: the agents package may write only its own agent tables). One idempotent INSERT into the append-only `shadow_observations` table (migration 0032). Observe-only: nothing reads the table to decide, size,
 * gate or approve (the column `used_for_decisions` is constrained to false). The result is rebuilt through an allow-list sanitizer (codes and numbers only, bounded) so a shadow can never persist
 * message text, a secret or an oversize blob. The table has no foreign key and a unique key on (kind, decision, version), so a retry or a second worker records nothing new.
 */
export const SHADOW_KINDS = ["agent_engine", "reduce_only_sizing"] as const;
export type ShadowKind = (typeof SHADOW_KINDS)[number];
export interface ShadowObservationInput { kind: ShadowKind; riskDecisionId: string; decisionVersion: number; result: Record<string, unknown> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY = /(secret|token|authorization|password|passwd|api[_-]?key|cookie|credential|raw|text|payload|body|content|message)/i;
const KEY_OK = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const CODE_STRING = /^[A-Za-z0-9_.:+/ -]{0,120}$/;
const MAX_KEYS = 64, MAX_ARRAY = 32, MAX_DEPTH = 4;

/** Keeps booleans, finite numbers, null and short code-like strings; drops everything else (and any key that looks sensitive). Bounded in width and depth. */
export function sanitizeShadowResult(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return CODE_STRING.test(value) ? value : "[dropped]";
  if (depth >= MAX_DEPTH) return "[depth-limited]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => sanitizeShadowResult(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n >= MAX_KEYS) break;
      if (!KEY_OK.test(k) || SENSITIVE_KEY.test(k)) continue;
      out[k] = sanitizeShadowResult(v, depth + 1);
      n += 1;
    }
    return out;
  }
  return "[dropped]";
}

export class ShadowObservationError extends Error { constructor(readonly code: string) { super(code); this.name = "ShadowObservationError"; } }

/** Returns `recorded: false` when the row already existed. Throws ShadowObservationError for invalid input; a database error propagates (the caller treats shadow persistence as best-effort). */
export async function recordShadowObservation(db: Db, input: ShadowObservationInput): Promise<{ recorded: boolean }> {
  if (!(SHADOW_KINDS as readonly string[]).includes(input.kind)) throw new ShadowObservationError("bad_kind");
  if (!UUID.test(input.riskDecisionId)) throw new ShadowObservationError("bad_decision_id");
  if (!Number.isInteger(input.decisionVersion) || input.decisionVersion < 1) throw new ShadowObservationError("bad_version");
  const result = sanitizeShadowResult(input.result) as Record<string, unknown>;
  if (JSON.stringify(result).length > 12_000) throw new ShadowObservationError("result_too_large");
  const rows = await db.insert(schema.shadowObservations)
    .values({ kind: input.kind, riskDecisionId: input.riskDecisionId, decisionVersion: input.decisionVersion, result, usedForDecisions: false })
    .onConflictDoNothing({ target: [schema.shadowObservations.kind, schema.shadowObservations.riskDecisionId, schema.shadowObservations.decisionVersion] })
    .returning({ id: schema.shadowObservations.id });
  return { recorded: rows.length > 0 };
}
