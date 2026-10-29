import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { computeEventHash, computePayloadHash, type PayloadField } from "./hash";
import { CHAIN_SPECS, DDL_WATCH, GENESIS_HASH, HEADS_TABLE, HEADS_TRIGGERS, INVARIANT_TRIGGERS, SYSTEM_CONTROLS_TRIGGERS, type ChainSpec } from "./specs";

/** Minimal database handle: pg.Pool, pg.Client or a transaction client. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type FailureCode =
  | "missing_rows" // a gap in chain_index, or the newest rows are gone (head says more rows existed)
  | "out_of_order" // chain_index goes backwards or repeats
  | "broken_link" // previous_hash is not the previous row's event_hash
  | "payload_modified" // payload_hash is not the hash of the row's current content
  | "invalid_event_hash" // event_hash is not the hash of (chain, index, previous_hash, payload_hash)
  | "head_mismatch" // audit_chain_heads disagrees with the table
  | "anchor_mismatch" // the row at a previously verified position differs from the external anchor
  | "protection_missing" // a guard trigger is missing or not ENABLE ALWAYS, or a chain table/column is missing
  | "ddl_watch_missing"; // only reported (as a failure) with requireDdlWatch

export interface Failure {
  code: FailureCode;
  chain: string;
  chainIndex?: number;
  rowId?: string;
  detail: string;
}

export interface ChainReport {
  chain: string;
  rows: number;
  lastIndex: number;
  lastHash: string;
  ok: boolean;
  firstFailure?: Failure;
}

export interface AuditReport {
  ok: boolean;
  checkedAt: string;
  chains: ChainReport[];
  protection: { ok: boolean; problems: Failure[] };
  ddlWatch: "installed" | "disabled" | "absent";
  /** The first failure in report order (protection first, then each chain), or undefined when ok. */
  firstFailure?: Failure;
  failures: Failure[];
}

export interface VerifyOptions {
  batchSize?: number;
  /** Treat an absent/disabled DDL watch as a failure (default: reported only; it needs a superuser to install). */
  requireDdlWatch?: boolean;
  /** Path of an external anchor file (kept OUTSIDE the database). Compared when present, rewritten after a passing run. */
  anchorFile?: string;
  chains?: readonly string[];
  now?: () => Date;
}

const asNumber = (v: unknown): number => Number(v);

export async function checkProtection(db: Queryable): Promise<{ problems: Failure[]; ddlWatch: AuditReport["ddlWatch"] }> {
  const problems: Failure[] = [];
  const expected: Array<[string, string, readonly string[]]> = [
    ...CHAIN_SPECS.map((s): [string, string, readonly string[]] => [s.chain, s.table, [...s.triggers, ...INVARIANT_TRIGGERS.filter(([t]) => t === s.table).map(([, name]) => name)]]),
    ["system_controls", "system_controls", SYSTEM_CONTROLS_TRIGGERS],
    [HEADS_TABLE, HEADS_TABLE, HEADS_TRIGGERS],
  ];
  for (const [chain, table, names] of expected) {
    const found = await db.query("select tgname, tgenabled from pg_trigger where tgrelid = to_regclass($1) and not tgisinternal", [`public.${table}`]);
    const have = new Map(found.rows.map((r) => [String(r["tgname"]), String(r["tgenabled"])]));
    for (const name of names) {
      const state = have.get(name);
      if (state === undefined) problems.push({ code: "protection_missing", chain, detail: `trigger ${name} is missing on ${table}` });
      else if (state !== "A") problems.push({ code: "protection_missing", chain, detail: `trigger ${name} on ${table} is not ENABLE ALWAYS (state '${state}')` });
    }
  }
  const evt = await db.query("select evtenabled from pg_event_trigger where evtname = $1", [DDL_WATCH]);
  const ddlWatch: AuditReport["ddlWatch"] = evt.rows.length === 0 ? "absent" : String(evt.rows[0]?.["evtenabled"]) === "D" ? "disabled" : "installed";
  return { problems, ddlWatch };
}

/** Verifies one chain end to end, streaming in keyset batches. Stops at the first failure and reports it. */
export async function verifyChain(db: Queryable, spec: ChainSpec, options: VerifyOptions = {}): Promise<ChainReport> {
  const batch = options.batchSize ?? 1000;
  const select = `select t.chain_index::text as chain_index, t.previous_hash, t.payload_hash, t.event_hash, t.id::text as row_id, ${spec.fields.map((f, i) => `(${f}) as f${i}`).join(", ")}
                    from ${spec.table} t where t.chain_index > $1::bigint order by t.chain_index asc limit $2`;
  let expectedIndex = 1;
  let expectedPrev = GENESIS_HASH;
  let rows = 0;
  let lastIndex = 0;
  let lastHash = GENESIS_HASH;
  let cursor = 0;
  const fail = (f: Omit<Failure, "chain">): ChainReport => ({ chain: spec.chain, rows, lastIndex, lastHash, ok: false, firstFailure: { chain: spec.chain, ...f } });

  for (;;) {
    let page;
    try {
      page = await db.query(select, [cursor, batch]);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return fail({ code: "protection_missing", detail: `cannot read ${spec.table} chain columns (${typeof code === "string" ? code : "error"}); migration 0010 not applied?` });
    }
    if (page.rows.length === 0) break;
    for (const r of page.rows) {
      const index = asNumber(r["chain_index"]);
      const rowId = String(r["row_id"]);
      if (index !== expectedIndex) {
        if (index > expectedIndex) return fail({ code: "missing_rows", chainIndex: index, rowId, detail: `expected chain_index ${expectedIndex}, found ${index}: ${index - expectedIndex} row(s) missing before this one` });
        return fail({ code: "out_of_order", chainIndex: index, rowId, detail: `chain_index ${index} appears where ${expectedIndex} was expected` });
      }
      if (String(r["previous_hash"]) !== expectedPrev) {
        return fail({ code: "broken_link", chainIndex: index, rowId, detail: `previous_hash does not equal the event_hash of chain_index ${index - 1}` });
      }
      const fields: PayloadField[] = spec.fields.map((_f, i) => (r[`f${i}`] === null || r[`f${i}`] === undefined ? null : String(r[`f${i}`])));
      if (computePayloadHash(fields) !== String(r["payload_hash"])) {
        return fail({ code: "payload_modified", chainIndex: index, rowId, detail: "the stored payload_hash does not match the row's current content (content changed, or payload_hash altered)" });
      }
      if (computeEventHash(spec.chain, index, String(r["previous_hash"]), String(r["payload_hash"])) !== String(r["event_hash"])) {
        return fail({ code: "invalid_event_hash", chainIndex: index, rowId, detail: "event_hash is not the hash of (chain, chain_index, previous_hash, payload_hash)" });
      }
      expectedPrev = String(r["event_hash"]);
      expectedIndex = index + 1;
      cursor = index;
      rows += 1;
      lastIndex = index;
      lastHash = String(r["event_hash"]);
    }
    if (page.rows.length < batch) break;
  }

  // The newest rows can be removed without breaking any link; the head table (written only by the chain trigger) exposes that.
  const head = await db.query(`select last_index::text as last_index, last_hash from ${HEADS_TABLE} where chain_name = $1`, [spec.chain]).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const h = head.rows[0];
  if (!h) return fail({ code: "head_mismatch", detail: `no ${HEADS_TABLE} row for chain ${spec.chain}` });
  const headIndex = asNumber(h["last_index"]);
  if (headIndex > lastIndex) return fail({ code: "missing_rows", chainIndex: lastIndex + 1, detail: `${headIndex - lastIndex} newest row(s) are missing: the chain head says chain_index ${headIndex} existed, the table ends at ${lastIndex}` });
  if (headIndex !== lastIndex || String(h["last_hash"]) !== lastHash) return fail({ code: "head_mismatch", chainIndex: lastIndex, detail: `${HEADS_TABLE} says (${headIndex}, ${String(h["last_hash"]).slice(0, 12)}...) but the table ends at (${lastIndex}, ${lastHash.slice(0, 12)}...)` });
  return { chain: spec.chain, rows, lastIndex, lastHash, ok: true };
}

interface AnchorFile {
  version: 1;
  anchors: Record<string, { index: number; hash: string; verifiedAt: string }>;
}

function readAnchor(path: string): AnchorFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as AnchorFile;
  if (parsed.version !== 1 || typeof parsed.anchors !== "object") throw new Error("anchor file has an unsupported format");
  return parsed;
}

/** A pool-like handle that can hand out one connection (pg.Pool). */
export interface Connectable {
  connect(): Promise<Queryable & { release(error?: Error | boolean): void }>;
}

/**
 * Verifies everything through a POOL: the whole run uses ONE connection inside a REPEATABLE READ, READ ONLY transaction, so rows appended while
 * it runs cannot make the table and the chain head disagree (no false alarm on a busy system). This is what the CLI uses.
 */
export async function verifyAuditChainsWithPool(pool: Connectable, options: VerifyOptions = {}): Promise<AuditReport> {
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    return await verifyAuditChains(client, options);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

/** Verifies everything on a handle the caller already controls (a single connection / transaction client). */
export async function verifyAuditChains(db: Queryable, options: VerifyOptions = {}): Promise<AuditReport> {
  const now = (options.now ?? (() => new Date()))();
  const failures: Failure[] = [];
  const protection = await checkProtection(db);
  if (options.requireDdlWatch && protection.ddlWatch !== "installed") {
    protection.problems.push({ code: "ddl_watch_missing", chain: "schema", detail: `the DDL watch event trigger is ${protection.ddlWatch}` });
  }
  failures.push(...protection.problems);

  const specs = CHAIN_SPECS.filter((s) => !options.chains || options.chains.includes(s.chain));
  const chains: ChainReport[] = [];
  for (const spec of specs) {
    const report = await verifyChain(db, spec, options);
    chains.push(report);
    if (report.firstFailure) failures.push(report.firstFailure);
  }

  let anchor: AnchorFile | undefined;
  if (options.anchorFile && existsSync(options.anchorFile)) {
    anchor = readAnchor(options.anchorFile);
    for (const report of chains) {
      const a = anchor.anchors[report.chain];
      if (!a || !report.ok) continue;
      const spec = specs.find((s) => s.chain === report.chain) as ChainSpec;
      const row = await db.query(`select event_hash from ${spec.table} where chain_index = $1::bigint`, [a.index]);
      if (row.rows.length === 0) failures.push({ code: "anchor_mismatch", chain: report.chain, chainIndex: a.index, detail: `the anchored row (chain_index ${a.index}, verified ${a.verifiedAt}) no longer exists` });
      else if (String(row.rows[0]?.["event_hash"]) !== a.hash) failures.push({ code: "anchor_mismatch", chain: report.chain, chainIndex: a.index, detail: `the row at chain_index ${a.index} differs from the externally anchored hash (history was rewritten)` });
    }
  }

  const ok = failures.length === 0;
  if (ok && options.anchorFile) {
    const next: AnchorFile = { version: 1, anchors: { ...(anchor?.anchors ?? {}) } };
    for (const r of chains) next.anchors[r.chain] = { index: r.lastIndex, hash: r.lastHash, verifiedAt: now.toISOString() };
    writeFileSync(options.anchorFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }
  return { ok, checkedAt: now.toISOString(), chains, protection: { ok: protection.problems.length === 0, problems: protection.problems }, ddlWatch: protection.ddlWatch, ...(failures[0] ? { firstFailure: failures[0] } : {}), failures };
}

export function formatReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`AUDIT CHAIN VERIFICATION: ${report.ok ? "PASS" : "FAIL"} (${report.checkedAt})`);
  lines.push(`protection triggers: ${report.protection.ok ? "ok" : "PROBLEMS"}; ddl watch: ${report.ddlWatch}`);
  for (const c of report.chains) lines.push(`  ${c.ok ? "ok  " : "FAIL"} ${c.chain.padEnd(22)} rows=${String(c.rows).padStart(7)} head=${c.lastIndex} ${c.lastHash.slice(0, 16)}`);
  if (report.firstFailure) {
    const f = report.firstFailure;
    lines.push(`FIRST FAILURE: ${f.code} in ${f.chain}${f.chainIndex !== undefined ? ` at chain_index ${f.chainIndex}` : ""}${f.rowId ? ` (row ${f.rowId})` : ""}: ${f.detail}`);
    if (report.failures.length > 1) lines.push(`(${report.failures.length - 1} further failure(s); see --json)`);
  }
  return lines.join("\n");
}
