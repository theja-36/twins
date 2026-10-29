import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAIN_SPECS, GENESIS_HASH, INVARIANT_TRIGGERS, canonicalPayload, checkRuntimeRolePrivileges, computeEventHash, computePayloadHash, formatReport, verifyAuditChains, verifyChain,
  type ChainSpec, type Queryable,
} from "../../../packages/audit-chain/src/index";
import { main as verifyCli } from "../../../scripts/ops/verify-audit-chain";
import { must } from "../../support/must";

/** An in-memory stand-in for the database: chain rows built with the TypeScript hashing, served the way the verifier queries them. */
interface Row { chain_index: number; previous_hash: string; payload_hash: string; event_hash: string; row_id: string; fields: Array<string | null> }
function buildChain(spec: ChainSpec, n: number): Row[] {
  const rows: Row[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const fields = spec.fields.map((_f, k) => (k % 5 === 4 ? null : `v${i}-${k}`));
    const payload_hash = computePayloadHash(fields);
    const event_hash = computeEventHash(spec.chain, i, prev, payload_hash);
    rows.push({ chain_index: i, previous_hash: prev, payload_hash, event_hash, row_id: `row-${i}`, fields });
    prev = event_hash;
  }
  return rows;
}

interface FakeOptions { triggers?: (table: string) => Array<[string, string]>; head?: (chain: string, rows: Row[]) => { last_index: number; last_hash: string } | null; evt?: "E" | "D" | null; anchorHash?: (chain: string, index: number) => string | null }
function fakeDb(data: Record<string, Row[]>, opts: FakeOptions = {}): Queryable & { queries: string[] } {
  const queries: string[] = [];
  const allTriggers = (table: string): Array<[string, string]> => {
    const spec = CHAIN_SPECS.find((s) => s.table === table);
    if (spec) return [...spec.triggers, ...INVARIANT_TRIGGERS.filter(([t]) => t === table).map(([, n]) => n)].map((t) => [t, "A"]);
    const invariantOnly = INVARIANT_TRIGGERS.filter(([t]) => t === table); // e.g. the orders guard (a table that is not a chain)
    if (invariantOnly.length) return invariantOnly.map(([, n]) => [n, "A"]);
    if (table === "system_controls") return ["system_controls_before_update", "system_controls_audit_insert", "system_controls_audit_update", "system_controls_no_delete", "system_controls_no_truncate"].map((t) => [t, "A"]);
    return [["audit_chain_heads_guard", "A"], ["audit_chain_heads_no_truncate", "A"]];
  };
  return {
    queries,
    async query(text, params = []) {
      queries.push(text);
      if (text.includes("from pg_trigger")) {
        const table = String(params[0]).replace("public.", "");
        return { rows: (opts.triggers ?? allTriggers)(table).map(([tgname, tgenabled]) => ({ tgname, tgenabled })) };
      }
      if (text.includes("pg_event_trigger")) return { rows: opts.evt === null ? [] : [{ evtenabled: opts.evt ?? "O" }] };
      if (text.includes("from audit_chain_heads")) {
        const chain = String(params[0]);
        const rows = data[chain] ?? [];
        const head = opts.head ? opts.head(chain, rows) : rows.length ? { last_index: must(rows[rows.length - 1]).chain_index, last_hash: must(rows[rows.length - 1]).event_hash } : { last_index: 0, last_hash: GENESIS_HASH };
        return { rows: head ? [{ last_index: String(head.last_index), last_hash: head.last_hash }] : [] };
      }
      const chainSelect = /from (\w+) t where t\.chain_index > \$1/.exec(text);
      if (chainSelect) {
        const rows = data[must(chainSelect[1])] ?? [];
        const page = rows.filter((r) => r.chain_index > Number(params[0])).sort((a, b) => a.chain_index - b.chain_index).slice(0, Number(params[1]));
        return { rows: page.map((r) => ({ chain_index: String(r.chain_index), previous_hash: r.previous_hash, payload_hash: r.payload_hash, event_hash: r.event_hash, row_id: r.row_id, ...Object.fromEntries(r.fields.map((v, i) => [`f${i}`, v])) })) };
      }
      const anchorSelect = /select event_hash from (\w+) where chain_index = \$1/.exec(text);
      if (anchorSelect) {
        const rows = data[must(anchorSelect[1])] ?? [];
        const found = rows.find((r) => r.chain_index === Number(params[0]));
        const forced = opts.anchorHash?.(must(anchorSelect[1]), Number(params[0]));
        return { rows: forced === null ? [] : forced !== undefined ? [{ event_hash: forced }] : found ? [{ event_hash: found.event_hash }] : [] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    },
  };
}
const fullData = (n = 6): Record<string, Row[]> => Object.fromEntries(CHAIN_SPECS.map((s) => [s.table, buildChain(s, n)]));
const spec = must(CHAIN_SPECS.find((s) => s.chain === "audit_events"));

describe("canonical serialization and hashing", () => {
  it("the payload is a deterministic JSON array of strings/null; the event hash binds domain, chain, index, previous hash and payload hash", () => {
    expect(canonicalPayload(["x", null, 'y "z"'])).toBe('["x",null,"y \\"z\\""]');
    // vectors cross-checked against PostgreSQL (to_json + sha256) when this test was written
    expect(computePayloadHash(["x", null, 'y "z"'])).toBe("979b22ccf9d4635a8f0ae76ff351f4db629bbb3007d2fbeff805e29aca18295e");
    expect(computeEventHash("audit_events", 7, "1".repeat(64), "979b22ccf9d4635a8f0ae76ff351f4db629bbb3007d2fbeff805e29aca18295e")).toBe("371f796b9093b58a5a317f6f12f71d6b44d2aab0dd09ed4b0455031d108d0eca");
  });
  it("changing any one field, the chain name, the index or the previous hash changes the hashes", () => {
    const base = computePayloadHash(["a", "b", null]);
    expect(computePayloadHash(["a", "b", ""])).not.toBe(base); // null is not the empty string
    expect(computePayloadHash(["a", "c", null])).not.toBe(base);
    expect(computePayloadHash(["a", null, "b"])).not.toBe(base); // order matters
    const ev = computeEventHash("audit_events", 1, GENESIS_HASH, base);
    expect(computeEventHash("options_claims", 1, GENESIS_HASH, base)).not.toBe(ev);
    expect(computeEventHash("audit_events", 2, GENESIS_HASH, base)).not.toBe(ev);
    expect(computeEventHash("audit_events", 1, "1".repeat(64), base)).not.toBe(ev);
  });
  it("every chain spec lists its content fields and its guard triggers", () => {
    expect(CHAIN_SPECS.map((s) => s.chain).sort()).toEqual(["audit_events", "circuit_breaker_events", "event_blackout_windows", "loss_events", "options_claims", "risk_decisions", "signal_validations", "stop_loss_validations", "system_control_events", "telegram_messages"]);
    for (const s of CHAIN_SPECS) {
      expect(s.fields.length).toBeGreaterThan(8);
      // the four chain/append-only guards, in this order; risk_decisions additionally has its integrity trigger (evidence, subject and version rules)
      const guards = [`${s.table}_chain_before_insert`, `${s.table}_chain_after_insert`, `${s.table}_no_update_delete`, `${s.table}_no_truncate`];
      expect(s.triggers).toEqual(s.table === "risk_decisions" ? [...guards, "risk_decisions_a_integrity_before_insert", "risk_decisions_b_breaker_before_insert"] : s.table === "circuit_breaker_events" || s.table === "event_blackout_windows" ? [...guards, `${s.table}_a_integrity_before_insert`] : guards);
    }
  });
});

describe("verifyChain: each kind of tampering is detected and located", () => {
  it("an intact chain passes (also across batch boundaries) and an empty chain passes", async () => {
    const data = fullData(7);
    for (const batchSize of [1, 2, 3, 7, 1000]) expect(await verifyChain(fakeDb(data), spec, { batchSize })).toMatchObject({ ok: true, rows: 7, lastIndex: 7 });
    expect(await verifyChain(fakeDb({ audit_events: [] }), spec)).toMatchObject({ ok: true, rows: 0, lastIndex: 0, lastHash: GENESIS_HASH });
  });
  it("a changed payload field", async () => {
    const data = fullData(6);
    must(must(data["audit_events"])[3]).fields[1] = "tampered";
    expect((await verifyChain(fakeDb(data), spec, { batchSize: 2 })).firstFailure).toMatchObject({ code: "payload_modified", chainIndex: 4, rowId: "row-4" });
  });
  it("a changed payload_hash", async () => {
    const data = fullData(6);
    must(must(data["audit_events"])[2]).payload_hash = "e".repeat(64);
    expect((await verifyChain(fakeDb(data), spec)).firstFailure).toMatchObject({ code: "payload_modified", chainIndex: 3 });
  });
  it("a changed event_hash (reported at the row, not at its successor)", async () => {
    const data = fullData(6);
    must(must(data["audit_events"])[2]).event_hash = "f".repeat(64);
    expect((await verifyChain(fakeDb(data), spec)).firstFailure).toMatchObject({ code: "invalid_event_hash", chainIndex: 3 });
  });
  it("a changed previous_hash", async () => {
    const data = fullData(6);
    must(must(data["audit_events"])[4]).previous_hash = "a".repeat(64);
    expect((await verifyChain(fakeDb(data), spec)).firstFailure).toMatchObject({ code: "broken_link", chainIndex: 5 });
  });
  it("a deleted event in the middle, and a deleted first event", async () => {
    const mid = fullData(6);
    must(mid["audit_events"]).splice(2, 1);
    expect((await verifyChain(fakeDb(mid), spec)).firstFailure).toMatchObject({ code: "missing_rows", chainIndex: 4 });
    const first = fullData(6);
    must(first["audit_events"]).splice(0, 1);
    expect((await verifyChain(fakeDb(first), spec)).firstFailure).toMatchObject({ code: "missing_rows", chainIndex: 2 });
  });
  it("the newest events deleted: only the chain head exposes it", async () => {
    const data = fullData(6);
    const head = { last_index: 6, last_hash: must(must(data["audit_events"])[5]).event_hash };
    must(data["audit_events"]).splice(4, 2);
    const r = await verifyChain(fakeDb(data, { head: () => head }), spec);
    expect(r.firstFailure).toMatchObject({ code: "missing_rows", chainIndex: 5 });
    expect(must(r.firstFailure).detail).toMatch(/2 newest row/);
  });
  it("out-of-order and repeated chain indexes", async () => {
    const dup = fullData(6);
    must(must(dup["audit_events"])[4]).chain_index = 4; // two rows with index 4
    expect((await verifyChain(fakeDb(dup), spec)).firstFailure).toMatchObject({ code: "out_of_order", chainIndex: 4 });
    const swapped = fullData(6);
    const r = must(swapped["audit_events"]);
    [must(r[2]).chain_index, must(r[3]).chain_index] = [4, 3]; // the db orders by chain_index, so the contents are swapped: links no longer match
    expect((await verifyChain(fakeDb(swapped), spec)).ok).toBe(false);
  });
  it("a chain head that disagrees with the table (index or hash)", async () => {
    const data = fullData(4);
    const last = must(must(data["audit_events"])[3]);
    expect((await verifyChain(fakeDb(data, { head: () => ({ last_index: 4, last_hash: "9".repeat(64) }) }), spec)).firstFailure).toMatchObject({ code: "head_mismatch" });
    expect((await verifyChain(fakeDb(data, { head: () => null }), spec)).firstFailure).toMatchObject({ code: "head_mismatch" });
    expect((await verifyChain(fakeDb(data, { head: () => ({ last_index: 4, last_hash: last.event_hash }) }), spec)).ok).toBe(true);
  });
  it("an unreadable chain table (migration not applied) is reported, not thrown", async () => {
    const db: Queryable = { query: async () => { throw Object.assign(new Error("column chain_index does not exist"), { code: "42703" }); } };
    expect((await verifyChain(db, spec)).firstFailure).toMatchObject({ code: "protection_missing" });
  });
});

describe("verifyAuditChains: protection, ordering of failures, anchor", () => {
  it("passes on an intact database and reports every chain", async () => {
    const r = await verifyAuditChains(fakeDb(fullData(3)));
    expect(r).toMatchObject({ ok: true, ddlWatch: "installed", failures: [] });
    expect(r.chains.map((c) => c.chain).sort()).toEqual(CHAIN_SPECS.map((c) => c.chain).sort());
  });
  it("a missing or disabled guard trigger fails the run, and protection problems are reported before chain problems", async () => {
    const data = fullData(3);
    must(must(data["telegram_messages"])[1]).fields[0] = "tampered";
    const r = await verifyAuditChains(fakeDb(data, { triggers: (t) => (t === "options_claims" ? [["options_claims_chain_before_insert", "A"], ["options_claims_no_update_delete", "D"]] : t === "audit_events" ? [] : CHAIN_SPECS.find((s) => s.table === t) ? must(CHAIN_SPECS.find((s) => s.table === t)).triggers.map((n) => [n, "A"] as [string, string]) : t === "system_controls" ? ["system_controls_before_update", "system_controls_audit_insert", "system_controls_audit_update", "system_controls_no_delete", "system_controls_no_truncate"].map((n) => [n, "A"] as [string, string]) : [["audit_chain_heads_guard", "A"], ["audit_chain_heads_no_truncate", "A"]]) }));
    expect(r.ok).toBe(false);
    expect(must(r.firstFailure).code).toBe("protection_missing");
    expect(r.protection.problems.some((p) => /options_claims_no_update_delete.*not ENABLE ALWAYS/.test(p.detail))).toBe(true);
    expect(r.protection.problems.some((p) => /audit_events_chain_before_insert is missing/.test(p.detail))).toBe(true);
    expect(r.failures.some((f) => f.code === "payload_modified" && f.chain === "telegram_messages")).toBe(true); // the data problem is still reported
  });
  it("the DDL watch: reported when absent; a failure only with requireDdlWatch", async () => {
    expect((await verifyAuditChains(fakeDb(fullData(2), { evt: null }))).ddlWatch).toBe("absent");
    expect((await verifyAuditChains(fakeDb(fullData(2), { evt: null }))).ok).toBe(true);
    expect((await verifyAuditChains(fakeDb(fullData(2), { evt: "D" }), { requireDdlWatch: true })).firstFailure).toMatchObject({ code: "ddl_watch_missing" });
    expect((await verifyAuditChains(fakeDb(fullData(2)), { requireDdlWatch: true })).ok).toBe(true);
  });
  it("the anchor file: written after a pass, compared on the next run, never overwritten by a failing run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "twins-anchor-unit-"));
    const anchorFile = join(dir, "a.json");
    try {
      const data = fullData(4);
      expect((await verifyAuditChains(fakeDb(data), { anchorFile })).ok).toBe(true);
      const written = JSON.parse(readFileSync(anchorFile, "utf8"));
      expect(written.anchors.audit_events).toMatchObject({ index: 4 });
      expect((await verifyAuditChains(fakeDb(fullData(6)), { anchorFile })).ok).toBe(true); // the chain grew: anchored positions still match
      const before = readFileSync(anchorFile, "utf8");
      const r1 = await verifyAuditChains(fakeDb(fullData(6), { anchorHash: (c, i) => (c === "audit_events" && i === 6 ? "0".repeat(64) : undefined) }), { anchorFile });
      expect(r1.firstFailure).toMatchObject({ code: "anchor_mismatch", chain: "audit_events", chainIndex: 6 });
      const r2 = await verifyAuditChains(fakeDb(fullData(6), { anchorHash: (c, i) => (c === "telegram_messages" && i === 6 ? null : undefined) }), { anchorFile });
      expect(r2.firstFailure).toMatchObject({ code: "anchor_mismatch", chain: "telegram_messages" });
      expect(readFileSync(anchorFile, "utf8")).toBe(before);
      writeFileSync(anchorFile, '{"version":2}');
      await expect(verifyAuditChains(fakeDb(fullData(2)), { anchorFile })).rejects.toThrow(/unsupported format/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("formatReport states PASS/FAIL, each chain and the first failure point", async () => {
    const data = fullData(5);
    must(must(data["options_claims"])[2]).fields[2] = "tampered";
    const text = formatReport(await verifyAuditChains(fakeDb(data)));
    expect(text).toContain("AUDIT CHAIN VERIFICATION: FAIL");
    expect(text).toMatch(/FAIL options_claims/);
    expect(text).toContain("FIRST FAILURE: payload_modified in options_claims at chain_index 3 (row row-3)");
    expect(formatReport(await verifyAuditChains(fakeDb(fullData(2))))).toContain("AUDIT CHAIN VERIFICATION: PASS");
  });
});

describe("verifier CLI (unit)", () => {
  const run = async (argv: string[], db: Queryable, env: Record<string, string | undefined> = { DATABASE_URL: "postgresql://u:pw@h/x" }) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await verifyCli(argv, { env, out: (l) => out.push(l), err: (l) => err.push(l), open: () => ({ db, close: async () => undefined }), now: () => new Date("2026-10-29T00:00:00Z") });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  it("exit 0 with PASS, exit 1 with the first failure on tampering, JSON output, and a status file for scheduled use", async () => {
    const dir = mkdtempSync(join(tmpdir(), "twins-cli-"));
    try {
      const pass = await run(["--status-file", join(dir, "s.json")], fakeDb(fullData(3)));
      expect(pass.code).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, "s.json"), "utf8"))).toMatchObject({ ok: true, ts: "2026-10-29T00:00:00.000Z", first_failure: null });
      const data = fullData(3);
      must(must(data["system_control_events"])[1]).fields[4] = "tampered";
      const fail = await run(["--json"], fakeDb(data));
      expect(fail.code).toBe(1);
      expect(JSON.parse(fail.out)).toMatchObject({ ok: false, firstFailure: { code: "payload_modified", chain: "system_control_events", chainIndex: 2 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("usage and configuration errors exit 2", async () => {
    const db = fakeDb(fullData(1));
    for (const argv of [["--nope"], ["--chain"], ["--chain", "x"], ["--batch-size", "abc"], ["--status-file"], ["--anchor-file"]]) expect((await run(argv, db)).code, argv.join(" ")).toBe(2);
    expect((await run([], db, {})).code).toBe(2);
  });
});

describe("runtime-role privilege self-check (logic)", () => {
  const okRole = { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false };
  const table = (over: Record<string, boolean>) => ({ owner: false, sel: true, ins: true, upd: false, del: false, trunc: false, refs: false, trg: false, ...over });
  function db(role: Record<string, boolean>, perTable: (t: string) => Record<string, boolean>): Queryable {
    return {
      async query(text, params = []) {
        if (text.includes("from pg_roles")) return { rows: [role] };
        if (text.includes("has_schema_privilege")) return { rows: [{ c: false }] };
        return { rows: [perTable(String(params[0]).replace("public.", ""))] };
      },
    };
  }
  const ro = (t: string) => (["system_controls", "system_control_events"].includes(t) ? table({ ins: false }) : ["audit_chain_heads"].includes(t) ? table({ ins: false, sel: false }) : table({}));
  it("a correctly separated runtime role has no problems", async () => {
    expect(await checkRuntimeRolePrivileges(db(okRole, ro))).toEqual([]);
  });
  it("flags superuser, ownership, modify rights on audit tables, writes to controls/heads, and a role that cannot append", async () => {
    const problems = await checkRuntimeRolePrivileges(db({ ...okRole, rolsuper: true }, (t) => (t === "audit_events" ? table({ owner: true, upd: true, trg: true }) : t === "telegram_messages" ? table({ del: true, trunc: true }) : t === "system_controls" ? table({ ins: true }) : t === "options_claims" ? table({ ins: false }) : ro(t))));
    expect(problems).toEqual(expect.arrayContaining(["role_is:rolsuper", "owns:audit_events", "can_update:audit_events", "can_trigger:audit_events", "can_delete:telegram_messages", "can_truncate:telegram_messages", "can_insert:system_controls", "cannot_append:options_claims"]));
  });
});
