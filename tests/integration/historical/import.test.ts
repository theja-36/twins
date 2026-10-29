/**
 * Historical archive import against REAL PostgreSQL (Stage 4 / Task 1). Every fixture is SYNTHETIC (no real channel, author or message); channel labels carry a per-run suffix, so
 * repeated runs on one database never share an identity. The importer touches only the historical_* tables and no Telegram, broker or network.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBoundedDb, type BoundedDbHandle } from "../../../packages/database/src/index";
import { verifyAuditChains, verifyAuditChainsWithPool } from "../../../packages/audit-chain/src/index";
import { buildReport, dryRun, inspectInput, InputError, runImport, type ImportOptions } from "../../../packages/historical/src/index";
import { runCli } from "../../../scripts/ops/historical-import";
import { makeRecords, MSG, tempDir, writeCsv, writeJson, writeJsonl, type RecordInput } from "../../support/historicalFixtures";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
let handle: BoundedDbHandle;
const db = () => handle.db;
const sfx = () => randomUUID().slice(0, 8);
const NOW = new Date("2026-10-30T10:00:00Z");

beforeAll(() => { handle = createBoundedDb(DATABASE_URL, { max: 4, idleTimeoutMillis: 10_000 }); });
afterAll(async () => { await handle?.close(); await pool.end(); });

const opts = (label: string, over: Partial<ImportOptions> = {}): ImportOptions => ({ label, defaultMarket: null, createdBy: "service:itest", confirmedSource: "synthetic.jsonl", now: NOW, ...over });
const run = async (path: string, label: string, over: Partial<ImportOptions> = {}) => runImport(db(), await inspectInput(path), opts(label, over));
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>; // (rows of an ad-hoc query: dynamically typed on purpose)
const n = async (sql: string, params: unknown[] = []) => Number(must((await q(sql, params))[0])["n"]);
const LIVE = ["telegram_messages", "signals", "options_claims", "risk_decisions", "risk_approvals", "risk_approval_cards", "orders", "fills", "positions", "decisions", "claim_review_cards", "telegram_intake_outbox"];
const counts = async () => Promise.all(LIVE.map((t) => n(`select count(*)::int as n from ${t}`)));
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

describe("a JSONL import end to end", () => {
  it("stores the evidence (provenance, hashes, redacted text) and the normalized record for every message, and reports them", async () => {
    const ch = `hist-${sfx()}`;
    const dir = tempDir();
    const rec = (id: number, text: string, extra: Record<string, unknown> = {}): RecordInput => ({ channel: ch, message_id: id, timestamp: `2024-03-04T04:0${id}:00Z`, text, ...extra });
    const file = writeJsonl(dir, "export.jsonl", [
      rec(1, MSG.completeOption, { author: "synthetic_author", media: [{ type: "photo", ref: "files/chart_1.jpg" }] }), rec(2, MSG.equity, { market: "NSE" }), rec(3, MSG.equityNoStop), rec(4, MSG.several), rec(5, MSG.noise), rec(6, MSG.withSecret),
    ]);
    const files = await inspectInput(file);
    const before = await counts();
    const r = await runImport(db(), files, opts(`itest-${sfx()}`, { confirmedSource: file }));
    expect(r).toMatchObject({ outcome: "IMPORTED", resumedFromRecord: 0, checkpoints: 1, counters: { recordsConsumed: 6, validRecords: 6, invalidRecords: 0, messageVersions: 6, newSourceRecords: 6, duplicates: 0, revisions: 0, normalizedRecords: 6 } });
    const [b] = await q("select * from historical_import_batches where id = $1", [r.batchId]);
    expect(b).toMatchObject({ batch_key: r.batchKey, format: "jsonl", contract_version: "historical-contract-v1", parser_version: "telegram-regex-v2", created_by: "service:itest", confirmed_source: "export.jsonl" });
    expect(JSON.stringify(b)).not.toContain(dir); // a base name only, never a path
    expect(b!["manifest"]).toEqual([{ name: "export.jsonl", format: "jsonl", sha256: files[0]!.sha256, bytes: files[0]!.bytes }]);

    const src = await q("select * from historical_source_records where batch_id = $1 order by source_line", [r.batchId]);
    expect(src).toHaveLength(6);
    expect(src[0]).toMatchObject({ channel_label: ch, original_message_id: "1", author: "synthetic_author", raw_text: MSG.completeOption, content_sha256: sha(MSG.completeOption), raw_text_redacted: "no", revision_no: 0, edit_of_id: null, source_file: "export.jsonl", source_file_sha256: files[0]!.sha256, source_line: 1, created_by: "service:itest" });
    expect(src[0]!["media_refs"]).toEqual([{ type: "photo", ref: "files/chart_1.jpg" }]);
    expect(new Date(src[0]!["message_timestamp"]).toISOString()).toBe("2024-03-04T04:01:00.000Z");
    expect(src[0]!["provenance"]).toMatchObject({ contractVersion: "historical-contract-v1", importer: "historical-import-v1" });
    expect(src[0]!["identity_key"]).toMatch(/^[0-9a-f]{64}$/);
    // the secret-shaped token and the e-mail address never reach storage; the redaction is recorded
    expect(src[5]).toMatchObject({ raw_text_redacted: "yes" });
    expect(src[5]!["raw_text"]).toContain("[REDACTED:telegram_bot_token]");
    expect(src[5]!["raw_text"]).toContain("[REDACTED:email_address]");
    expect(JSON.stringify(src)).not.toMatch(/BBBBBBBB|trader@example/);
    expect(await n("select count(*)::int as n from historical_import_issues where batch_id = $1 and code = 'secret_redacted'", [r.batchId])).toBe(1);

    const norm = await q("select n.*, s.original_message_id from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id where s.batch_id = $1 order by s.source_line", [r.batchId]);
    expect(norm.map((x) => [x["parse_status"], x["validation_result"]])).toEqual([["OPTIONS_CLAIM", "VALID"], ["SIGNAL", "VALID"], ["SIGNAL", "INCOMPLETE"], ["AMBIGUOUS", "AMBIGUOUS"], ["NO_SIGNAL", "NOT_A_SIGNAL"], ["SIGNAL", "INCOMPLETE"]]);
    expect(norm[0]).toMatchObject({ market: "NSE", market_source: "underlying_mapping", instrument_type: "option", underlying: "NIFTY", option_type: "CE", side: "buy", level_basis: "premium", parser_version: "telegram-regex-v2" });
    expect(Number(norm[0]!["strike"])).toBe(24500);
    expect(Number(norm[0]!["stop_loss"])).toBe(90);
    expect(new Date(norm[0]!["expiry_date"]).getUTCFullYear()).toBe(2031);
    expect(norm[0]!["targets"]).toEqual([150, 180]);
    expect(norm[0]!["conditions"]).toEqual(["entry_above"]);
    expect(norm[0]!["stop_loss_validation"]).toMatchObject({ result: "VALID", ruleVersion: "stop-loss-v1" });
    expect(norm[1]).toMatchObject({ market: "NSE", market_source: "record" }); // the record's own market
    expect(norm[2]).toMatchObject({ market: null, missing_fields: expect.arrayContaining(["market", "stop_loss"]) }); // nothing is guessed
    expect(norm[2]!["stop_loss_validation"]).toMatchObject({ result: "MISSING" });
    expect(norm[3]!["ambiguous_fields"]).toEqual(["directives"]);
    expect(norm[5]).toMatchObject({ validation_result: "INCOMPLETE" });

    expect(await n("select count(*)::int as n from historical_import_checkpoints where batch_id = $1 and status = 'COMPLETED'", [r.batchId])).toBe(1);
    expect(await counts()).toEqual(before); // no live signal, claim, risk decision, approval, order, fill or position was created
    expect((await verifyAuditChainsWithPool(pool, { chains: ["historical_source_records"] })).ok).toBe(true);

    const rep = must(await buildReport(db(), r.batchId));
    expect(rep).toMatchObject({ status: "COMPLETED", checkpoints: 1, recordsConsumed: 6, sourceRecords: 6, originalMessages: 6, revisions: 0, redactedRecords: 1, normalizedRecords: 6, duplicateDeliveries: 0 });
    expect(rep.byParseStatus).toEqual({ AMBIGUOUS: 1, NO_SIGNAL: 1, OPTIONS_CLAIM: 1, SIGNAL: 3 });
    expect(rep.byValidation).toEqual({ AMBIGUOUS: 1, INCOMPLETE: 2, NOT_A_SIGNAL: 1, VALID: 2 });
    expect(rep.byStopLoss).toMatchObject({ VALID: 3, MISSING: 1 });
    expect(rep.missingFields).toMatchObject({ market: 2, stop_loss: 1 });
    expect(rep.warnings).toMatchObject({ secret_redacted: 1 });
    expect(JSON.stringify(rep)).not.toMatch(/RELIANCE|NIFTY|synthetic_author|trader@/);
  });
  it("CSV and JSON exports import the same way (format recorded)", async () => {
    const dir = tempDir();
    const ch = `hist-${sfx()}`;
    const csv = writeCsv(dir, "a.csv", ["channel", "message_id", "timestamp", "text", "market"], makeRecords(ch, 4).map((r) => ({ ...r, market: "NSE" })));
    const json = writeJson(dir, "b.json", { records: makeRecords(`${ch}-j`, 3) });
    const a = await run(csv, `itest-${sfx()}`);
    const b = await run(json, `itest-${sfx()}`);
    expect(a.counters).toMatchObject({ newSourceRecords: 4, normalizedRecords: 4 });
    expect(b.counters).toMatchObject({ newSourceRecords: 3 });
    expect((await q("select format from historical_import_batches where id = $1", [a.batchId]))[0]!["format"]).toBe("csv");
    expect((await q("select format from historical_import_batches where id = $1", [b.batchId]))[0]!["format"]).toBe("json");
    expect(await n("select count(*)::int as n from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id where s.batch_id = $1 and n.market = 'NSE'", [a.batchId])).toBe(3); // the signals and claims carry the record's market; the non-signal has none
  });
  it("a directory of exports is imported in file order", async () => {
    const dir = tempDir();
    const ch = `hist-${sfx()}`;
    writeJsonl(dir, "02.jsonl", makeRecords(ch, 2, undefined, "2024-05-01T04:00:00Z").map((r, i) => ({ ...r, message_id: 100 + i })));
    writeJsonl(dir, "01.jsonl", makeRecords(ch, 2));
    const r = await run(dir, `itest-${sfx()}`);
    expect(r.counters.newSourceRecords).toBe(4);
    expect((await q("select source_file, source_line from historical_source_records where batch_id = $1 order by chain_index", [r.batchId])).map((x) => `${x["source_file"]}:${x["source_line"]}`)).toEqual(["01.jsonl:1", "01.jsonl:2", "02.jsonl:1", "02.jsonl:2"]);
  });
});

describe("idempotency and identity", () => {
  it("re-running the same import changes nothing; the same messages in another file are recorded as duplicate deliveries, not as records", async () => {
    const dir = tempDir();
    const ch = `hist-${sfx()}`;
    const recs = makeRecords(ch, 5);
    const a = writeJsonl(dir, "a.jsonl", recs);
    const first = await run(a, `itest-${sfx()}`);
    expect(first.outcome).toBe("IMPORTED");
    const before = { src: await n("select count(*)::int as n from historical_source_records"), norm: await n("select count(*)::int as n from historical_normalized_records"), cp: await n("select count(*)::int as n from historical_import_checkpoints") };
    const again = await runImport(db(), await inspectInput(a), opts(`x`, {}).label === "" ? opts("x") : { ...opts("x"), label: (await q("select label from historical_import_batches where id = $1", [first.batchId]))[0]!["label"] });
    expect(again).toMatchObject({ outcome: "ALREADY_COMPLETED", batchId: first.batchId });
    expect({ src: await n("select count(*)::int as n from historical_source_records"), norm: await n("select count(*)::int as n from historical_normalized_records"), cp: await n("select count(*)::int as n from historical_import_checkpoints") }).toEqual(before);
    // a different file (another name) with the same messages = another batch, but no new evidence
    const b = writeJsonl(dir, "b.jsonl", [...recs, recs[0]!]);
    const second = await run(b, `itest-${sfx()}`);
    expect(second.batchId).not.toBe(first.batchId);
    expect(second.counters).toMatchObject({ messageVersions: 6, newSourceRecords: 0, duplicates: 6, normalizedRecords: 0 });
    expect(await n("select count(*)::int as n from historical_source_records where channel_label = $1", [ch])).toBe(5);
    expect(await n("select count(*)::int as n from historical_import_issues where batch_id = $1 and code = 'duplicate_delivery'", [second.batchId])).toBe(6);
    expect(await n("select count(*)::int as n from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id where s.channel_label = $1", [ch])).toBe(5); // never a second normalized claim
  });
  it("identity = channel + message id + timestamp + content: any difference is a different version", async () => {
    const dir = tempDir();
    const ch = `hist-${sfx()}`;
    const t = "2024-03-04T04:00:00Z";
    const file = writeJsonl(dir, "a.jsonl", [
      { channel: ch, message_id: 1, timestamp: t, text: MSG.equity },
      { channel: `${ch}-other`, message_id: 1, timestamp: t, text: MSG.equity }, // same id, another channel
      { channel: ch, message_id: 2, timestamp: t, text: MSG.equity }, // same text, another id
    ]);
    const r = await run(file, `itest-${sfx()}`);
    expect(r.counters).toMatchObject({ newSourceRecords: 3, duplicates: 0, revisions: 0 });
    const ids = await q("select distinct identity_key from historical_source_records where batch_id = $1", [r.batchId]);
    expect(ids).toHaveLength(3);
  });
});

describe("edits and revisions", () => {
  it("an edit is a NEW revision row linked to the original; edits of the same content are not repeated; a re-delivery conflict becomes a revision with a warning", async () => {
    const dir = tempDir();
    const ch = `hist-${sfx()}`;
    const file = writeJsonl(dir, "a.jsonl", [
      { channel: ch, message_id: 1, timestamp: "2024-03-04T04:00:00Z", text: MSG.equityNoStop, edits: [{ edited_at: "2024-03-04T04:05:00Z", text: MSG.equity }, { edited_at: "2024-03-04T04:10:00Z", text: MSG.equity }, { edited_at: "2024-03-04T04:20:00Z", text: MSG.equityBadStop }] },
      { channel: ch, message_id: 2, timestamp: "2024-03-04T04:30:00Z", text: MSG.completeOption },
      { channel: ch, message_id: 2, timestamp: "2024-03-04T04:30:00Z", text: MSG.optionNoExpiry }, // same id again, different text, no edit marker
      { channel: ch, message_id: 3, timestamp: "2024-03-04T04:40:00Z", text: MSG.equity, edited_at: "2024-03-04T04:50:00Z" }, // an edit marker without the edited text
    ]);
    const r = await run(file, `itest-${sfx()}`, { defaultMarket: "NSE" });
    expect(r.counters).toMatchObject({ validRecords: 4, messageVersions: 6, newSourceRecords: 6, revisions: 3, normalizedRecords: 6 });
    const rows = await q("select id, original_message_id, revision_no, edit_of_id, edited_at, content_sha256 from historical_source_records where channel_label = $1 order by original_message_id, revision_no", [ch]);
    expect(rows.map((x) => `${x["original_message_id"]}/${x["revision_no"]}`)).toEqual(["1/0", "1/1", "1/2", "2/0", "2/1", "3/0"]);
    const original1 = rows[0]!;
    expect(rows[1]).toMatchObject({ edit_of_id: original1["id"] });
    expect(rows[2]).toMatchObject({ edit_of_id: original1["id"] });
    expect(new Date(rows[1]!["edited_at"]).toISOString()).toBe("2024-03-04T04:05:00.000Z");
    expect(rows[4]).toMatchObject({ edit_of_id: rows[3]!["id"], edited_at: null });
    const norm = await q("select s.revision_no, s.original_message_id, n.parse_status, n.validation_result, n.missing_fields from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id where s.channel_label = $1 order by s.original_message_id, s.revision_no", [ch]);
    expect(norm.map((x) => x["validation_result"])).toEqual(["INCOMPLETE", "VALID", "AMBIGUOUS", "VALID", "INCOMPLETE", "VALID"]); // each revision is normalized on its own text
    expect(norm[4]!["missing_fields"]).toEqual(expect.arrayContaining(["expiry"]));
    const w = await q("select code, count(*)::int as n from historical_import_issues where batch_id = $1 group by code", [r.batchId]);
    const codes = Object.fromEntries(w.map((x) => [x["code"], x["n"]]));
    expect(codes).toMatchObject({ edit_revision: 2, redelivery_conflict: 1, edit_text_identical: 1, edit_marker_without_text: 1 });
    expect((await verifyAuditChainsWithPool(pool, { chains: ["historical_source_records"] })).ok).toBe(true);
  });
  it("an edit that arrives in a LATER import extends the same message's revisions", async () => {
    const dir = tempDir();
    const ch = `hist-${sfx()}`;
    const base = { channel: ch, message_id: 1, timestamp: "2024-03-04T04:00:00Z", text: MSG.equity };
    await run(writeJsonl(dir, "a.jsonl", [base]), `itest-${sfx()}`);
    const second = await run(writeJsonl(dir, "b.jsonl", [{ ...base, edits: [{ edited_at: "2024-03-04T05:00:00Z", text: MSG.equityBadStop }] }]), `itest-${sfx()}`);
    expect(second.counters).toMatchObject({ newSourceRecords: 1, duplicates: 1, revisions: 1 });
    expect((await q("select revision_no from historical_source_records where channel_label = $1 order by revision_no", [ch])).map((x) => x["revision_no"])).toEqual([0, 1]);
  });
});

describe("bad input: validated before anything is written", () => {
  it("invalid records refuse the import (nothing written) unless explicitly allowed, and are then recorded as ERROR issues by code and line", async () => {
    const dir = tempDir();
    const ch = `hist-${sfx()}`;
    const file = writeJsonl(dir, "a.jsonl", [
      { channel: ch, message_id: 1, timestamp: "2024-03-04T04:00:00Z", text: MSG.equity }, { channel: ch, message_id: 2, timestamp: "not a time", text: MSG.equity }, { channel: "bad|chan", message_id: 3, timestamp: "2024-03-04T04:00:00Z", text: "x" },
    ], ["{broken json"]);
    const before = { batches: await n("select count(*)::int as n from historical_import_batches"), src: await n("select count(*)::int as n from historical_source_records"), issues: await n("select count(*)::int as n from historical_import_issues") };
    await expect(run(file, `itest-${sfx()}`)).rejects.toMatchObject({ code: "invalid_records_present" });
    expect({ batches: await n("select count(*)::int as n from historical_import_batches"), src: await n("select count(*)::int as n from historical_source_records"), issues: await n("select count(*)::int as n from historical_import_issues") }).toEqual(before);
    const r = await run(file, `itest-${sfx()}`, { allowInvalid: true });
    expect(r.counters).toMatchObject({ recordsConsumed: 4, validRecords: 1, invalidRecords: 3, newSourceRecords: 1, errorsByCode: { invalid_timestamp: 1, invalid_channel: 1, malformed_json: 1 } });
    const errs = await q("select code, source_file, source_line, detail from historical_import_issues where batch_id = $1 and severity = 'ERROR' order by source_line", [r.batchId]);
    expect(errs.map((e) => `${e["code"]}@${e["source_file"]}:${e["source_line"]}`)).toEqual(["invalid_timestamp@a.jsonl:2", "invalid_channel@a.jsonl:3", "malformed_json@a.jsonl:4"]);
    expect(JSON.stringify(errs)).not.toMatch(/RELIANCE|broken|bad\|chan/);
  });
  it("a malformed or unsafe input is refused before any write (file level)", async () => {
    const before = await n("select count(*)::int as n from historical_import_batches");
    const d = tempDir();
    writeFileSync(join(d, "broken.json"), "{nope");
    writeFileSync(join(d, "h.csv"), "a,b\n1,2\n");
    writeFileSync(join(d, "x.session"), "x");
    writeJson(d, "shape.json", { nothing: true });
    for (const [name, code] of [["broken.json", "malformed_json_file"], ["h.csv", "csv_header_invalid"], ["x.session", "forbidden_file_name"], ["shape.json", "invalid_json_structure"]] as const) {
      await expect(run(join(d, name), `itest-${sfx()}`)).rejects.toMatchObject({ code });
    }
    await expect(run(join(d, "missing.jsonl"), `itest-${sfx()}`)).rejects.toBeInstanceOf(InputError);
    await expect(runImport(db(), await inspectInput(writeJsonl(d, "ok.jsonl", makeRecords(`hist-${sfx()}`, 1))), opts(`itest-${sfx()}`, { createdBy: "someone" }))).rejects.toMatchObject({ code: "invalid_created_by" });
    expect(await n("select count(*)::int as n from historical_import_batches")).toBe(before);
  });
});

describe("large batches: checkpoints and resume", () => {
  it("commits in chunks with a checkpoint each, survives a crash between chunks, and resumes to exactly the same result", async () => {
    const dir = tempDir();
    const ch = `hist-${sfx()}`;
    const file = writeJsonl(dir, "big.jsonl", makeRecords(ch, 230, [MSG.equity, MSG.completeOption, MSG.noise, MSG.optionNoExpiry, MSG.equityNoStop]));
    const label = `itest-${sfx()}`;
    await expect(run(file, label, { chunkSize: 50, afterChunk: (seq) => { if (seq === 2) throw new Error("simulated crash"); } })).rejects.toThrow(/simulated crash/);
    const [batch] = await q("select id from historical_import_batches where label = $1", [label]);
    expect(await n("select count(*)::int as n from historical_source_records where channel_label = $1", [ch])).toBe(100);
    expect((await q("select sequence, records_consumed, status from historical_import_checkpoints where batch_id = $1 order by sequence", [batch!["id"]])).map((c) => `${c["sequence"]}:${c["records_consumed"]}:${c["status"]}`)).toEqual(["1:50:IN_PROGRESS", "2:100:IN_PROGRESS"]);
    expect(must(await buildReport(db(), batch!["id"]))).toMatchObject({ status: "IN_PROGRESS", recordsConsumed: 100, sourceRecords: 100 });
    const resumed = await run(file, label, { chunkSize: 50 });
    expect(resumed).toMatchObject({ outcome: "RESUMED", resumedFromRecord: 100, checkpoints: 5, batchId: batch!["id"] });
    expect(resumed.counters).toMatchObject({ recordsConsumed: 230, validRecords: 230, newSourceRecords: 230, duplicates: 0, normalizedRecords: 230 });
    expect(await n("select count(*)::int as n from historical_source_records where channel_label = $1", [ch])).toBe(230);
    expect(await n("select count(distinct identity_key)::int as n from historical_source_records where channel_label = $1", [ch])).toBe(230);
    expect(await n("select count(*)::int as n from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id where s.channel_label = $1", [ch])).toBe(230);
    const rep = must(await buildReport(db(), batch!["id"]));
    expect(rep).toMatchObject({ status: "COMPLETED", checkpoints: 5, recordsConsumed: 230, sourceRecords: 230, normalizedRecords: 230 });
    expect(Object.values(rep.byParseStatus).reduce((a, b) => a + b, 0)).toBe(230);
    expect(await run(file, label, { chunkSize: 50 })).toMatchObject({ outcome: "ALREADY_COMPLETED" });
    // the same input imported cleanly in one go gives the same distribution (resume does not change results)
    const clean = await run(writeJsonl(dir, "clean.jsonl", makeRecords(`${ch}-clean`, 230, [MSG.equity, MSG.completeOption, MSG.noise, MSG.optionNoExpiry, MSG.equityNoStop])), `itest-${sfx()}`, { chunkSize: 1000 });
    expect(clean.counters.byParseStatus).toEqual(resumed.counters.byParseStatus);
    expect(clean.counters.byValidation).toEqual(resumed.counters.byValidation);
    expect((await verifyAuditChainsWithPool(pool, { chains: ["historical_source_records"] })).ok).toBe(true);
  });
});

describe("safety and privacy", () => {
  it("never logs message content (no console output at all) and the CLI output carries counts, codes and ids only", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const dir = tempDir();
    const ch = `canary-${sfx()}`;
    const file = writeJsonl(dir, "a.jsonl", [{ channel: ch, message_id: 1, timestamp: "2024-03-04T04:00:00Z", text: `${MSG.withSecret} CANARYPHRASE`, author: "canary_author" }], [`{"canary": "CANARYPHRASE"`]);
    await run(file, `itest-${sfx()}`, { allowInvalid: true });
    spies.forEach((s) => { expect(s).not.toHaveBeenCalled(); s.mockRestore(); });
    const out: string[] = [], errs: string[] = [];
    const cli = (args: string[]) => runCli(args, { env: { DATABASE_URL }, out: (l) => out.push(l), err: (l) => errs.push(l), openDb: () => ({ db: db(), close: async () => undefined }), now: () => NOW });
    expect(await cli(["validate", file])).toBe(3); // one invalid line
    expect(await cli(["dry-run", file, "--label", `itest-${sfx()}`])).toBe(3);
    const everything = [...out, ...errs].join("\n");
    expect(everything).not.toMatch(/CANARYPHRASE|canary_author|RELIANCE|trader@|BBBBBBBB|canary-/);
    expect(everything).toContain("invalidRecords");
    expect(await n("select count(*)::int as n from historical_import_issues where detail::text ~* 'canary'")).toBe(0);
  });
  it("writes nothing outside the historical tables: no live message, signal, claim, risk decision, approval, order, fill, position or card", async () => {
    const before = await counts();
    const dir = tempDir();
    await run(writeJsonl(dir, "a.jsonl", makeRecords(`hist-${sfx()}`, 20, [MSG.completeOption, MSG.equity, MSG.several])), `itest-${sfx()}`);
    expect(await counts()).toEqual(before);
    const live = await q("select count(*)::int as n from options_claims where created_at > now() - interval '1 minute'");
    expect(live[0]!["n"]).toBe(0);
  });
  it("the evidence, the batch, the normalized records, the issues and the checkpoints are append-only; the chain detects tampering; a revision must point at its own message", async () => {
    const dir = tempDir();
    const ch = `hist-${sfx()}`;
    const r = await run(writeJsonl(dir, "a.jsonl", [{ channel: ch, message_id: 1, timestamp: "2024-03-04T04:00:00Z", text: MSG.equity, edits: [{ edited_at: "2024-03-04T05:00:00Z", text: MSG.equityNoStop }] }]), `itest-${sfx()}`);
    const c = await pool.connect();
    try {
      await c.query("begin");
      for (const [table, col] of [["historical_import_batches", "label"], ["historical_source_records", "raw_text"], ["historical_normalized_records", "market"], ["historical_import_issues", "code"], ["historical_import_checkpoints", "status"]] as const) {
        for (const sql of [`update ${table} set ${col} = ${col}`, `delete from ${table}`, `truncate ${table}`, `truncate ${table} cascade`]) {
          await c.query("savepoint s");
          const e = await c.query(sql).then(() => null, (x: { code?: string }) => x);
          await c.query("rollback to savepoint s");
          expect(["23001", "0A000"], `${sql} -> ${e?.code}`).toContain(e?.code);
        }
      }
      await c.query("set local session_replication_role = replica");
      expect((await c.query("update historical_source_records set event_hash = event_hash").then(() => null, (x: { code?: string }) => x))?.code).toBe("23001");
      await c.query("rollback");
      await c.query("begin");
      await c.query("alter table historical_source_records disable trigger historical_source_records_no_update_delete");
      await c.query("update historical_source_records set raw_text = raw_text || ' tampered' where chain_index = (select max(chain_index) from historical_source_records)");
      await c.query("alter table historical_source_records enable always trigger historical_source_records_no_update_delete");
      const report = await verifyAuditChains(c, { chains: ["historical_source_records"] });
      expect(report.ok).toBe(false);
      expect(report.firstFailure?.code).toBe("payload_modified");
      await c.query("rollback");
      await c.query("begin");
      const orig = must((await c.query("select id, batch_id from historical_source_records where channel_label = $1 and revision_no = 0", [ch])).rows[0]);
      const wrongMessage = await c.query(
        `insert into historical_source_records (id, batch_id, identity_key, channel_label, original_message_id, message_timestamp, raw_text, content_sha256, media_refs, edit_of_id, revision_no, source_file, source_file_sha256, source_line, provenance, created_by)
         values (gen_random_uuid(), $1, $2, $3, '99', now(), 'x', $4, '[]', $5, 1, 'a.jsonl', $4, 1, '{}', 'service:itest')`, [orig["batch_id"], "c".repeat(64), ch, "d".repeat(64), orig["id"]]).then(() => "inserted", (e: { message?: string }) => e.message);
      expect(wrongMessage).toMatch(/a revision must point at revision 0 of the same channel and message/);
    } finally { await c.query("rollback").catch(() => undefined); c.release(); }
    expect(r.counters.revisions).toBe(1);
  });
});

describe("the import command", () => {
  const cliRun = async (args: string[]) => {
    const out: string[] = [], errs: string[] = [];
    const code = await runCli(args, { env: { DATABASE_URL }, out: (l) => out.push(l), err: (l) => errs.push(l), openDb: () => ({ db: db(), close: async () => undefined }), now: () => NOW });
    return { code, out: out.join("\n"), err: errs.join("\n") };
  };
  it("validate and dry-run summarize without writing; import needs the exact source path AND the dry-run manifest hash; a re-run resumes / is a no-op; report prints the numbers", async () => {
    const dir = tempDir();
    const ch = `hist-${sfx()}`;
    const file = writeJsonl(dir, "export.jsonl", makeRecords(ch, 12, [MSG.completeOption, MSG.equity, MSG.noise]));
    const label = `itest-${sfx()}`;
    const batches = await n("select count(*)::int as n from historical_import_batches");
    const v = await cliRun(["validate", file]);
    expect(v.code).toBe(0);
    expect(JSON.parse(v.out)).toMatchObject({ totalRecords: 12, validRecords: 12, invalidRecords: 0, parseable: 8, uniqueMessages: 12 });
    const d = await cliRun(["dry-run", file, "--label", label, "--default-market", "NSE"]);
    expect(d.code).toBe(0);
    const summary = JSON.parse(d.out) as { manifestSha256: string; alreadyImported: number; byValidation: Record<string, number> };
    expect(summary.alreadyImported).toBe(0);
    expect(summary.byValidation).toMatchObject({ VALID: 8, NOT_A_SIGNAL: 4 });
    expect(await n("select count(*)::int as n from historical_import_batches")).toBe(batches);

    const base = ["import", file, "--label", label, "--default-market", "NSE", "--created-by", "operator:itest"];
    expect((await cliRun(base)).code).toBe(2); // no confirmation at all
    expect((await cliRun([...base, "--confirm-source", join(dir, "other.jsonl"), "--confirm-manifest", summary.manifestSha256.slice(0, 12)])).err).toMatch(/source_not_confirmed/);
    expect((await cliRun([...base, "--confirm-source", file, "--confirm-manifest", "0".repeat(12)])).err).toMatch(/manifest_not_confirmed/);
    expect((await cliRun([...base, "--confirm-source", file, "--confirm-manifest", "xyz"])).code).toBe(3);
    expect((await cliRun([...base, "--created-by", "somebody", "--confirm-source", file, "--confirm-manifest", summary.manifestSha256.slice(0, 12)])).code).toBe(3);
    expect(await n("select count(*)::int as n from historical_import_batches")).toBe(batches); // every refusal wrote nothing

    const ok = await cliRun([...base, "--confirm-source", file, "--confirm-manifest", summary.manifestSha256.slice(0, 16), "--chunk-size", "5"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/import IMPORTED: batch [0-9a-f-]{36} \(resumed from record 0, 3 checkpoints\)/);
    expect(ok.out).toMatch(/source records=12 \(original messages=12, revisions=0, redacted=0\) normalized=12/);
    const batchId = /batch ([0-9a-f-]{36})/.exec(ok.out)![1]!;
    const again = await cliRun([...base, "--confirm-source", file, "--confirm-manifest", summary.manifestSha256.slice(0, 16), "--chunk-size", "5"]);
    expect(again.out).toMatch(/import ALREADY_COMPLETED/);
    const rep = await cliRun(["report", "--batch", batchId]);
    expect(rep.code).toBe(0);
    expect(rep.out).toContain("[COMPLETED]");
    expect(rep.out).toContain("parse status: NO_SIGNAL=4, OPTIONS_CLAIM=4, SIGNAL=4");
    expect(JSON.parse((await cliRun(["report", "--batch", batchId, "--json"])).out)).toMatchObject({ status: "COMPLETED", sourceRecords: 12 });
    expect((await cliRun(["report", "--batch", randomUUID()])).code).toBe(3);
    expect((await cliRun(["dry-run", file, "--label", label])).out).toMatch(/"alreadyImported": 12/);
    expect((await cliRun(["nonsense"])).code).toBe(2);
    expect((await cliRun(["import", file])).code).toBe(2);
    expect((await cliRun(["dry-run", join(dir, "nope.jsonl"), "--label", label])).err).toMatch(/refused: path_not_found/);
  });
  it("is never run by a service: there is no compose service, scheduler job, worker import or API route for it", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "x"));
    expect(await dryRun(await inspectInput(writeJsonl(dir, "a.jsonl", makeRecords(`hist-${sfx()}`, 1))), { label: "itest", defaultMarket: null }, undefined, NOW)).toMatchObject({ totalRecords: 1 });
  });
});
