/**
 * Stage 08 A4 against REAL PostgreSQL: the audited correction command. Dry run by default; writes only with a confirmation bound to the exact plan; the original attribution is preserved; owner authorisation, duplicates, concurrency,
 * invalid input and the absence of any direct-write path are all tested. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../../../scripts/ops/outcome-correction";
import { advanceOpenOrders } from "../../../packages/execution/src/index";
import { buildAttribution } from "../../../packages/outcomes/src/index";
import { insertAttribution, latestAttributionForPosition, loadAttributionFacts } from "../../../packages/database/src/index";
import { makeOutcomeHarness } from "../../support/outcomeHarness";
import { requireTestDatabaseUrl } from "../targetConfig";

const URL_ = requireTestDatabaseUrl(), { db, owner, close, unsyncedClose, fx } = makeOutcomeHarness(URL_);
afterAll(close);
const env = { DATABASE_URL: URL_, LIVE_TRADING: "false" };
const run = async (args: string[]) => { const o: string[] = [], e: string[] = []; const code = await main(args, env, (l) => o.push(l), (l) => e.push(l)); return { code, out: o.join("\n"), err: e.join("\n"), json: o.length ? (JSON.parse(o[0] as string) as Record<string, unknown>) : null }; };
const REASON = "recomputed after the late confidence record was reviewed", EVID = "ticket:OPS-4711";
const cmd = (a: { userId: string; id: string }, extra: string[] = [], reason = REASON, evidence = EVID) => ["--user", a.userId, "--attribution", a.id, "--reason", reason, "--evidence", evidence, ...extra];
const versions = async (positionId: string) => (await (await owner()).query("select version, finality, correction_reason, supersedes_id, evidence_refs, data_quality from outcome_attributions where paper_position_id = $1 order by version", [positionId])).rows;
const audits = async (entityId?: string) => (await (await owner()).query(entityId ? "select * from audit_events where event_type = 'outcome.corrected' and entity_id = $1" : "select * from audit_events where event_type = 'outcome.corrected'", entityId ? [entityId] : [])).rows;

/** A closed position whose FINAL attribution v1 was recorded in an earlier state (it carries a data-quality code the current evidence no longer produces), so a re-derivation really differs. */
async function withStaleFinal() {
  const a = await unsyncedClose(); await advanceOpenOrders(a.deps);
  const facts = (await loadAttributionFacts(db, a.userId, a.pos.id))!, base = buildAttribution(facts, null)!;
  expect(base.finality).toBe("FINAL");
  const id = (await insertAttribution(db, a.userId, { ...base, dataQuality: [...base.dataQuality, "MANUAL_REVIEW_PENDING"] }))!;
  return { ...a, id };
}

describe("outcome-correction: dry run, confirmation and the written version", () => {
  it("a dry run (the default) writes nothing and prints the plan with a confirmation token; a wrong token is refused", async () => {
    const a = await withStaleFinal(), before = await versions(a.pos.id);
    const d = await run(cmd(a));
    expect(d.code).toBe(0); expect(d.json).toMatchObject({ result: "DRY_RUN", written: false, owner: a.userId, attributionId: a.id, currentVersion: 1, newVersion: 2, reason: REASON, evidence: EVID });
    expect((d.json!["changes"] as string[])).toContain("dataQuality"); expect(d.json!["confirmToken"]).toMatch(/^[0-9a-f]{16}$/);
    expect(await versions(a.pos.id)).toEqual(before);
    const wrong = await run(cmd(a, ["--confirm", "0000000000000000"]));
    expect(wrong.code).toBe(3); expect(wrong.err).toMatch(/does not match/); expect(await versions(a.pos.id)).toEqual(before);
  }, 120_000);

  it("a confirmed correction appends a reasoned version, preserves the original untouched, names it, records the evidence and writes ONE audit event", async () => {
    const a = await withStaleFinal(), v1 = (await versions(a.pos.id))[0];
    const token = (await run(cmd(a))).json!["confirmToken"] as string;
    const w = await run(cmd(a, ["--confirm", token, "--actor", "ops.alice"]));
    // the actor is part of the plan, so a confirm with a different actor than the dry run is a different request
    expect(w.code).toBe(3);
    const token2 = (await run(cmd(a, ["--actor", "ops.alice"]))).json!["confirmToken"] as string, ok = await run(cmd(a, ["--actor", "ops.alice", "--confirm", token2]));
    expect(ok.code).toBe(0); expect(ok.json).toMatchObject({ result: "WRITTEN", written: true, newVersion: 2 });
    const rows = await versions(a.pos.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(v1); // the original is exactly as it was
    expect(rows[1]).toMatchObject({ version: 2, finality: "FINAL", supersedes_id: a.id });
    expect(rows[1].correction_reason).toContain(REASON); expect(rows[1].correction_reason).toContain(EVID); expect(rows[1].correction_reason).toContain("ops.alice");
    expect(rows[1].evidence_refs).toContain(`correction:${EVID}`); expect(rows[1].data_quality).not.toContain("MANUAL_REVIEW_PENDING"); // the re-derivation from current evidence
    const au = await audits(ok.json!["newAttributionId"] as string);
    expect(au).toHaveLength(1); expect(au[0]).toMatchObject({ actor_type: "user", actor_id: "ops.alice", entity_type: "outcome_attribution" });
    expect(au[0].metadata).toMatchObject({ ownerUserId: a.userId, previousAttributionId: a.id, previousVersion: 1, newVersion: 2, reason: REASON, evidence: EVID }); expect(au[0].metadata.changes).toContain("dataQuality");
    expect(Number(au[0].chain_index)).toBeGreaterThan(0); // part of the hash-chained audit log
  }, 120_000);

  it("repeating a confirmed request changes nothing (ALREADY_APPLIED); naming the superseded version with a different reason is refused", async () => {
    const a = await withStaleFinal(), t = (await run(cmd(a))).json!["confirmToken"] as string;
    expect((await run(cmd(a, ["--confirm", t]))).json!["result"]).toBe("WRITTEN");
    const again = await run(cmd(a, ["--confirm", t]));
    expect(again.code).toBe(0); expect(again.json).toMatchObject({ result: "ALREADY_APPLIED", appliedVersion: 2 });
    expect(await versions(a.pos.id)).toHaveLength(2); expect(await audits((await latestAttributionForPosition(db, a.userId, a.pos.id))!.id)).toHaveLength(1);
    const other = await run(cmd(a, [], "a different reason that was never applied to this record"));
    expect(other.code).toBe(3); expect(other.err).toMatch(/not the latest version/);
  }, 120_000);

  it("two concurrent confirmations write exactly one version and one audit event", async () => {
    const a = await withStaleFinal(), t = (await run(cmd(a))).json!["confirmToken"] as string;
    const rs = await Promise.all([run(cmd(a, ["--confirm", t])), run(cmd(a, ["--confirm", t])), run(cmd(a, ["--confirm", t]))]);
    for (const r of rs) expect(r.code).toBe(0);
    expect(rs.filter((r) => r.json!["result"] === "WRITTEN")).toHaveLength(1); expect(rs.filter((r) => r.json!["result"] === "ALREADY_APPLIED")).toHaveLength(2);
    expect(await versions(a.pos.id)).toHaveLength(2); expect(await audits((await latestAttributionForPosition(db, a.userId, a.pos.id))!.id)).toHaveLength(1);
  }, 120_000);

  it("when re-deriving gives the same record there is nothing to correct and nothing is written", async () => {
    const a = await unsyncedClose(); await advanceOpenOrders(a.deps);
    const id = (await insertAttribution(db, a.userId, buildAttribution((await loadAttributionFacts(db, a.userId, a.pos.id))!, null)!))!;
    const r = await run(cmd({ userId: a.userId, id })); expect(r.code).toBe(0); expect(r.json).toMatchObject({ result: "NO_CHANGE" }); expect(await versions(a.pos.id)).toHaveLength(1);
  }, 120_000);
});

describe("outcome-correction: authorisation and refusals (nothing is ever written)", () => {
  it("another user, an unknown attribution, an inactive owner, a PARTIAL attribution and a stale version are all refused", async () => {
    const a = await withStaleFinal(), b = await withStaleFinal(), before = await versions(a.pos.id), totalBefore = (await audits()).length;
    const cross = await run(cmd({ userId: b.userId, id: a.id }, ["--confirm", "0".repeat(16)])); // b names a's attribution
    expect(cross.code).toBe(3); expect(cross.err).toMatch(/no such attribution for this owner/);
    expect((await run(cmd({ userId: a.userId, id: "00000000-0000-4000-8000-000000000001" }))).err).toMatch(/no such attribution/);
    const o = await owner(); // users.is_active changes only through the privilege door (as in the Stage 01 tests)
    await o.query("begin"); await o.query("select set_config('twins.privilege_door', 'open', true)"); await o.query("update users set is_active = false where id = $1", [b.userId]); await o.query("commit");
    const inactive = await run(cmd({ userId: b.userId, id: b.id })); expect(inactive.code).toBe(3); expect(inactive.err).toMatch(/not an active user/);
    expect((await run(cmd({ userId: "00000000-0000-4000-8000-0000000000aa", id: a.id }))).code).toBe(3); // an owner that does not exist
    const open = await fx.openPosition(async (t, p) => (await owner()).query(t, p as unknown[])); // a PARTIAL attribution of an open position
    const partial = (await insertAttribution(db, open.userId, buildAttribution((await loadAttributionFacts(db, open.userId, open.pos.id))!, null)!))!;
    const p = await run(cmd({ userId: open.userId, id: partial })); expect(p.code).toBe(3); expect(p.err).toMatch(/only a FINAL attribution/);
    expect(await versions(a.pos.id)).toEqual(before); expect((await audits()).length).toBe(totalBefore); expect(await versions(b.pos.id)).toHaveLength(1);
  }, 180_000);

  it("invalid input is a usage error (exit 2): bad ids, missing or short reason, malformed or missing evidence, unknown or repeated flags", async () => {
    const U = "00000000-0000-4000-8000-000000000002", A = "00000000-0000-4000-8000-000000000003";
    const ok = ["--user", U, "--attribution", A, "--reason", REASON, "--evidence", EVID];
    const bad: string[][] = [
      [], ["--user", "nope", ...ok.slice(2)], ["--user", U, "--attribution", "nope", ...ok.slice(4)],
      ok.map((x) => (x === REASON ? "too short" : x)), ok.map((x) => (x === REASON ? "x".repeat(301) : x)),
      ok.map((x) => (x === EVID ? "just some words" : x)), ok.map((x) => (x === EVID ? "ticket:" : x)), ok.map((x) => (x === EVID ? "ticket:../../etc/passwd;rm" : x)), ok.slice(0, 6),
      [...ok, "--sql", "delete from outcome_attributions"], [...ok, "--actor", "bad actor!"], [...ok, "--user", U], [...ok, "--confirm"], ["--user", U],
    ];
    for (const args of bad) { const r = await run(args); expect(r.code, JSON.stringify(args)).toBe(2); expect(r.err).toMatch(/usage/i); }
  });

  it("there is no direct-write path: the command has no SQL of its own, never updates or deletes, and writes only through the audited store function", () => {
    const src = readFileSync("scripts/ops/outcome-correction.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/\b(sql`|\.query\(|\.execute\()|\b(update|delete)\s+(from\s+)?\w|insert\s+into|drop\s+|truncate/i);
    expect([...src.matchAll(/\b(insert\w*|update\w*|delete\w*|store\w*|set[A-Z]\w*)\(/g)].map((m) => m[1])).toEqual(["insertCorrectionWithAudit"]);
    expect(src).toContain("enforceLiveTradingGuard");
  });
});
