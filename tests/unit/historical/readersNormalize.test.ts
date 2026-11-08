import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildVersions, dryRun, inspectInput, InputError, normalizeText, parseCsv, prepareRecords, readAll, validateRawRecord } from "../../../packages/historical/src/index";
import { makeRecords, MSG, tempDir, writeCsv, writeJson, writeJsonl } from "../../support/historicalFixtures";

const ROOT = join(__dirname, "../../..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const NOW = new Date("2026-10-30T10:00:00Z");
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return (e as InputError).code; } };
const collect = async (path: string) => { const files = await inspectInput(path); const out = []; for await (const r of readAll(files)) out.push(r); return out; };

describe("reading a local export", () => {
  it("reads JSONL (blank lines skipped, a malformed line is a record-level error with its line number)", async () => {
    const d = tempDir();
    const p = writeJsonl(d, "a.jsonl", makeRecords("synthetic-a", 2), ["", "{not json"]);
    const rows = await collect(p);
    expect(rows.map((r) => [r.line, r.error ?? "ok"])).toEqual([[1, "ok"], [2, "ok"], [4, "malformed_json"]]);
  });
  it("reads a JSON array and an object with a `records` array; anything else is a file-level error", async () => {
    const d = tempDir();
    expect((await collect(writeJson(d, "a.json", makeRecords("synthetic-a", 3)))).length).toBe(3);
    expect((await collect(writeJson(d, "b.json", { records: makeRecords("synthetic-a", 2) }))).length).toBe(2);
    expect(await code(collect(writeJson(d, "c.json", { nope: 1 })))).toBe("invalid_json_structure");
    writeFileSync(join(d, "d.json"), "{broken");
    expect(await code(collect(join(d, "d.json")))).toBe("malformed_json_file");
  });
  it("reads CSV: quoted commas, doubled quotes, newlines in a text, the media and single-edit columns", async () => {
    const d = tempDir();
    const p = writeCsv(d, "a.csv", ["channel", "message_id", "timestamp", "text", "author", "media", "edited_at", "edit_text"], [
      { channel: "synthetic-a", message_id: 1, timestamp: "2024-03-04T04:00:00Z", text: 'BUY RELIANCE @ 2800, "quoted"\nSL 2750 TGT 2900', author: "synthetic_author", media: "photo:files/a.jpg;video:files/b.mp4" },
      { channel: "synthetic-a", message_id: 2, timestamp: 1709524860, text: MSG.equity, edited_at: "2024-03-04T05:00:00Z", edit_text: MSG.equityNoStop },
    ]);
    const rows = await collect(p);
    expect(rows).toHaveLength(2);
    const a = validateRawRecord(rows[0]!.value, NOW), b = validateRawRecord(rows[1]!.value, NOW);
    expect(a).toMatchObject({ ok: true, message: { text: 'BUY RELIANCE @ 2800, "quoted"\nSL 2750 TGT 2900', author: "synthetic_author", media: [{ type: "photo", ref: "files/a.jpg" }, { type: "video", ref: "files/b.mp4" }] } });
    expect(b).toMatchObject({ ok: true, message: { messageId: "2", edits: [{ text: MSG.equityNoStop }] } });
    expect(parseCsv('a,b\n"x,1","y""z"\n')).toEqual([["a", "b"], ["x,1", 'y"z']]);
    expect(() => parseCsv('a\n"open')).toThrow(/csv_unterminated_quote/);
  });
  it("a CSV with a missing required column, a repeated column or a short row is refused / reported", async () => {
    const d = tempDir();
    writeFileSync(join(d, "h.csv"), "channel,timestamp,text\nx,2024-03-04T04:00:00Z,hi\n");
    expect(await code(collect(join(d, "h.csv")))).toBe("csv_header_invalid");
    writeFileSync(join(d, "r.csv"), "channel,message_id,timestamp,text\nsynthetic-a,1,2024-03-04T04:00:00Z\n");
    expect((await collect(join(d, "r.csv")))[0]).toMatchObject({ error: "csv_row_malformed", line: 2 });
  });
  it("refuses credential / session-like files and anything that is not a plain local text export", async () => {
    const d = tempDir();
    for (const name of ["telegram.session", "bot_token.json", "secrets.json", "id_rsa.json", "session_export.jsonl", "prod.env", "x.pem", "keys.sqlite"]) {
      writeFileSync(join(d, name), '{"a":1}\n');
      expect(await code(inspectInput(join(d, name))), name).toBe("forbidden_file_name");
    }
    writeFileSync(join(d, "data.txt"), "x");
    expect(await code(inspectInput(join(d, "data.txt")))).toBe("unsupported_file_type");
    writeFileSync(join(d, "empty.jsonl"), "");
    expect(await code(inspectInput(join(d, "empty.jsonl")))).toBe("empty_file");
    writeFileSync(join(d, "bin.jsonl"), Buffer.from([0x7b, 0x00, 0x7d, 0x0a]));
    expect(await code(inspectInput(join(d, "bin.jsonl")))).toBe("not_a_text_file");
    expect(await code(inspectInput(join(d, "missing.jsonl")))).toBe("path_not_found");
    writeJsonl(d, "real.jsonl", makeRecords("synthetic-a", 1));
    symlinkSync(join(d, "real.jsonl"), join(d, "link.jsonl"));
    expect(await code(inspectInput(join(d, "link.jsonl")))).toBe("symlink_not_allowed");
  });
  it("a directory is read non-recursively in name order; a forbidden file inside refuses the whole input; unsupported neighbours are ignored", async () => {
    const d = tempDir();
    writeJsonl(d, "b.jsonl", makeRecords("synthetic-a", 1));
    writeJsonl(d, "a.jsonl", makeRecords("synthetic-a", 1, undefined, "2024-04-01T04:00:00Z"));
    writeFileSync(join(d, "notes.txt"), "ignored");
    mkdirSync(join(d, "nested"));
    writeJsonl(join(d, "nested"), "c.jsonl", makeRecords("synthetic-a", 1));
    const files = await inspectInput(d);
    expect(files.map((f) => f.name)).toEqual(["a.jsonl", "b.jsonl"]);
    expect(files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes > 0)).toBe(true);
    writeFileSync(join(d, "my.session"), "x");
    expect(await code(inspectInput(d))).toBe("forbidden_file_name");
    const empty = tempDir();
    writeFileSync(join(empty, "x.txt"), "x");
    expect(await code(inspectInput(empty))).toBe("no_supported_files");
  });
  it("the file hash changes with the content and not with the name", async () => {
    const d = tempDir();
    const a = (await inspectInput(writeJsonl(d, "a.jsonl", makeRecords("synthetic-a", 2))))[0]!;
    const b = (await inspectInput(writeJsonl(d, "b.jsonl", makeRecords("synthetic-a", 2))))[0]!;
    const c = (await inspectInput(writeJsonl(d, "c.jsonl", makeRecords("synthetic-a", 3))))[0]!;
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).not.toBe(c.sha256);
  });
});

describe("normalization (uses the existing parser and stop-loss rule; nothing is guessed)", () => {
  const n = (text: string, ctx: { recordMarket?: string | null; defaultMarket?: string | null } = {}) => normalizeText(text, { recordMarket: ctx.recordMarket ?? null, defaultMarket: ctx.defaultMarket ?? null });
  it("a complete option claim: every field from the message, market from the index mapping (labelled), VALID", () => {
    const f = n(MSG.completeOption);
    expect(f).toMatchObject({
      parseStatus: "OPTIONS_CLAIM", market: "NSE", marketSource: "underlying_mapping", instrumentType: "option", underlying: "NIFTY", strike: 24500, optionType: "CE", side: "buy", expiryDate: "2031-10-29", stopLoss: 90, targets: [150, 180],
      levelBasis: "premium", conditions: ["entry_above"], missingFields: [], ambiguousFields: [], validationResult: "VALID", stopLossValidation: { result: "VALID", reasonCode: null },
    });
    expect(f.expiry).toMatchObject({ status: "full", day: 29, month: 10, year: 2031 });
  });
  // [description, text, expected validation, missing, ambiguous]
  const rows: Array<[string, string, string, string[], string[]]> = [
    ["option without an expiry", MSG.optionNoExpiry, "INCOMPLETE", ["expiry", "market"].filter((x) => x === "expiry"), []],
    ["option with a day and month but no year", MSG.optionYearMissing, "AMBIGUOUS", [], ["expiry"]],
    ["option with a period word", MSG.optionPeriodWord, "AMBIGUOUS", [], ["expiry"]],
    ["option without a stated level basis", MSG.optionNoBasis, "INCOMPLETE", ["level_basis"], []],
    ["equity without a stop-loss", MSG.equityNoStop, "INCOMPLETE", ["market", "stop_loss"], []],
    ["equity with a stop on the wrong side", MSG.equityBadStop, "INCOMPLETE", ["market"], []],
    ["several directives", MSG.several, "AMBIGUOUS", [], ["directives"]],
    ["no signal", MSG.noise, "NOT_A_SIGNAL", [], []],
  ];
  it.each(rows)("%s -> %s", (_d, text, validation, missing, ambiguous) => {
    const f = n(text);
    expect(f.validationResult).toBe(validation);
    expect(f.missingFields).toEqual(expect.arrayContaining(missing));
    expect(f.ambiguousFields).toEqual(expect.arrayContaining(ambiguous));
  });
  it("never fabricates a missing field: no expiry date, strike, entry, stop-loss or target appears that the message did not state", () => {
    const f = n(MSG.optionNoExpiry);
    expect(f).toMatchObject({ expiryDate: null, expiry: { status: "missing" } });
    const g = n(MSG.optionYearMissing);
    expect(g).toMatchObject({ expiryDate: null, expiry: { status: "day_month" } });
    const e = n(MSG.equityNoStop);
    expect(e).toMatchObject({ stopLoss: null, entry: { type: "at", price: 3500 }, targets: [3600] });
    expect(e.missingFields).toContain("stop_loss");
    expect(n(MSG.noise)).toMatchObject({ underlying: null, strike: null, stopLoss: null, targets: [], expiryDate: null, market: null });
  });
  it("an equity signal has NO market unless the record or the batch states one (never inferred); the stop-loss rule's verdict is stored", () => {
    expect(n(MSG.equity)).toMatchObject({ market: null, marketSource: null, missingFields: ["market"], validationResult: "INCOMPLETE", stopLossValidation: { result: "VALID" } });
    expect(n(MSG.equity, { defaultMarket: "NSE" })).toMatchObject({ market: "NSE", marketSource: "batch_default", missingFields: [], validationResult: "VALID" });
    expect(n(MSG.equity, { recordMarket: "BSE", defaultMarket: "NSE" })).toMatchObject({ market: "BSE", marketSource: "record" });
    expect(n(MSG.completeOption, { recordMarket: "NFO" })).toMatchObject({ market: "NFO", marketSource: "record" });
    expect(n(MSG.equityBadStop, { defaultMarket: "NSE" })).toMatchObject({ validationResult: "AMBIGUOUS", stopLossValidation: { result: "INVALID" }, warnings: ["stop_loss_invalid"] });
    expect(n(MSG.equityNoStop, { defaultMarket: "NSE" }).stopLossValidation).toMatchObject({ result: "MISSING", reasonCode: "MISSING_STOP_LOSS" });
  });
  it("keeps the parser's own output untouched in `parsed`, and the parse status is one of the five", () => {
    expect(n(MSG.equity).parsed).toMatchObject({ direction: "buy", symbol: "RELIANCE", entryPrice: 2800, stopLoss: 2750, targets: [2900, 3000] });
    for (const t of Object.values(MSG)) expect(["SIGNAL", "OPTIONS_CLAIM", "AMBIGUOUS", "UNSUPPORTED", "NO_SIGNAL"]).toContain(n(t).parseStatus);
    expect(n("BUY BANKEX 50000 CE 29 OCT 2031 @ 120 SL 90 TGT 150 premium")).toMatchObject({ parseStatus: expect.stringMatching(/UNSUPPORTED|SIGNAL|AMBIGUOUS/) });
  });
  it("is deterministic", () => {
    for (const t of Object.values(MSG)) expect(n(t)).toEqual(n(t));
  });
});

describe("versions, redaction and the dry run", () => {
  it("builds the original plus each edit, redacts before hashing, drops an identical edit, and warns", () => {
    const v = validateRawRecord({ channel: "synthetic-a", message_id: 1, timestamp: "2024-03-04T04:00:00Z", text: MSG.withSecret, edits: [{ edited_at: "2024-03-04T05:00:00Z", text: MSG.withSecret }, { edited_at: "2024-03-04T06:00:00Z", text: MSG.equity }] }, NOW);
    expect(v.ok).toBe(true);
    const { versions, warnings } = buildVersions((v as { message: Parameters<typeof buildVersions>[0] }).message);
    expect(versions).toHaveLength(2);
    expect(versions[0]!.text).toContain("[REDACTED:telegram_bot_token]");
    expect(versions[0]!.text).toContain("[REDACTED:email_address]");
    expect(versions[0]!.text).not.toMatch(/BBBBBBBB|trader@/);
    expect(versions[0]!.redactedKinds).toEqual(["email_address", "telegram_bot_token"]);
    expect(versions[1]).toMatchObject({ fromEditsArray: true, redactedKinds: [] });
    expect(warnings).toEqual(expect.arrayContaining(["secret_redacted", "edit_text_identical"]));
    expect(new Set(versions.map((x) => x.identity)).size).toBe(2);
  });
  it("the dry run summarizes without a database: totals, invalid by code, parseable, duplicates inside the input, revisions, warnings, missing / ambiguous", async () => {
    const d = tempDir();
    const ch = "synthetic-dry";
    const rec = (id: number, text: string, extra: Record<string, unknown> = {}) => ({ channel: ch, message_id: id, timestamp: `2024-03-04T04:0${id}:00Z`, text, ...extra });
    const p = writeJsonl(d, "a.jsonl", [
      rec(1, MSG.completeOption), rec(2, MSG.equity), rec(2, MSG.equity), rec(3, MSG.noise), rec(4, MSG.optionNoExpiry), rec(5, MSG.withSecret),
      rec(6, MSG.equity, { edits: [{ edited_at: "2024-03-04T06:00:00Z", text: MSG.equityNoStop }] }), { channel: "bad|channel", message_id: 9, timestamp: "2024-03-04T04:00:00Z", text: "x" },
    ], ["{broken"]);
    const files = await inspectInput(p);
    const s = await dryRun(files, { label: "unit-dry", defaultMarket: null }, undefined, NOW);
    expect(s).toMatchObject({ totalRecords: 9, validRecords: 7, invalidRecords: 2, invalidByCode: { invalid_channel: 1, malformed_json: 1 }, messageVersions: 7, uniqueMessages: 6, revisions: 1, duplicatesInInput: 1, alreadyImported: null });
    expect(s.parseable).toBe(6);
    expect(s.byParseStatus).toMatchObject({ OPTIONS_CLAIM: 2, SIGNAL: 4, NO_SIGNAL: 1 });
    expect(s.missingFields["expiry"]).toBe(1);
    expect(s.warningsByCode).toMatchObject({ secret_redacted: 1, edit_revision: 1 });
    expect(s.batchKey).toMatch(/^[0-9a-f]{64}$/);
    expect(s.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(s)).not.toMatch(/RELIANCE|NIFTY|trader@|BBBBBBBB|synthetic-dry/); // counts and codes only
    expect((await dryRun(files, { label: "unit-dry", defaultMarket: null }, undefined, NOW)).batchKey).toBe(s.batchKey); // stable
    expect((await dryRun(files, { label: "other-label", defaultMarket: null }, undefined, NOW)).batchKey).not.toBe(s.batchKey);
    expect((await dryRun(files, { label: "unit-dry", defaultMarket: "NSE" }, undefined, NOW)).batchKey).not.toBe(s.batchKey);
  });
  it("a conflicting re-delivery (same message id, different content, no edit marker) is counted as a revision", async () => {
    const d = tempDir();
    const p = writeJsonl(d, "a.jsonl", [{ channel: "synthetic-c", message_id: 1, timestamp: "2024-03-04T04:00:00Z", text: MSG.equity }, { channel: "synthetic-c", message_id: 1, timestamp: "2024-03-04T04:00:00Z", text: MSG.equityNoStop }]);
    const s = await dryRun(await inspectInput(p), { label: "unit-conflict", defaultMarket: null }, undefined, NOW);
    expect(s).toMatchObject({ uniqueMessages: 1, revisions: 1, messageVersions: 2 });
    expect(s.warningsByCode["redelivery_conflict"]).toBe(1);
  });
  it("an invalid label is refused", async () => {
    const d = tempDir();
    const files = await inspectInput(writeJsonl(d, "a.jsonl", makeRecords("synthetic-a", 1)));
    await expect(dryRun(files, { label: "bad/label", defaultMarket: null }, undefined, NOW)).rejects.toMatchObject({ code: "invalid_label" });
    void prepareRecords;
  });
});

describe("architecture: research storage only", () => {
  const files = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((x) => (statSync(join(ROOT, dir, x)).isDirectory() ? (x === "node_modules" || x === "dist" ? [] : files(`${dir}/${x}`)) : x.endsWith(".ts") ? [`${dir}/${x}`] : []));
  const src = files("packages/historical/src");
  it("duplicates no parsing: the package reuses the existing parser and stop-loss rule and contains no BUY / SELL / SL / TGT pattern of its own", () => {
    const code = src.map((f) => strip(read(f))).join("\n");
    expect(read("packages/historical/src/normalize.ts")).toMatch(/analyzeTelegramText/);
    expect(read("packages/historical/src/normalize.ts")).toMatch(/validateOptionsClaimStopLoss/);
    expect(code).not.toMatch(/\/[^/\n]*\\b\(?(BUY|SELL)\b|STOP\\s\*LOSS|\bTGT\b/);
  });
  it("writes only the historical_* tables and never touches the live pipeline, risk, approval, order or broker code; no network, no logging of content", () => {
    for (const f of src) {
      const code = strip(read(f));
      expect(code, f).not.toMatch(/schema\.(telegramMessages|signals|optionsClaims|riskDecisions|riskApprovals|riskApprovalCards|orders|fills|positions|decisions|claimReviewCards|claimReviews|telegramIntakeOutbox|auditEvents)\b/);
      expect(code, f).not.toMatch(/@twins\/(risk|runtime-state|adapter|ingestion)|zerodha|kite|broker|api\.telegram\.org|fetch\(|node:https?|node:net|console\./i);
    }
    // Task 1 import code only: the Task 2 outcome engine (src/outcomes/) writes the four outcome tables and the Task 3 scorecards (src/scorecards/) and Task 4 patterns (src/patterns/) write only their own five tables each; the master-build strategy playbooks (src/strategy/) write only their own four tables (pinned by strategyStorage.test.ts); both have their own, stricter boundary tests (outcomeDataset.test.ts, scorecards.test.ts, patterns.test.ts); the live-table and network checks above still cover it
    const inserts = src.filter((f) => !f.includes("/outcomes/") && !f.includes("/scorecards/") && !f.includes("/patterns/") && !f.includes("/strategy/")).flatMap((f) => [...strip(read(f)).matchAll(/\.insert\(\s*schema\.(\w+)\)/g)].map((m) => m[1]));
    expect([...new Set(inserts)].sort()).toEqual(["historicalImportBatches", "historicalImportCheckpoints", "historicalImportIssues", "historicalNormalizedRecords", "historicalSourceRecords"]);
  });
  it("the CLI prints counts, codes and ids only (no message field is ever passed to an output call) and has no compose service", () => {
    const cli = strip(read("scripts/ops/historical-import.ts"));
    expect(cli).not.toMatch(/\.(rawText|text|message)\b/);
    expect(read("infrastructure/staging/docker-compose.staging.yml")).not.toMatch(/historical/i);
    expect(read("packages/database/drizzle/0020_historical_import.sql")).toMatch(/ENABLE ALWAYS TRIGGER "historical_source_records_a_integrity_before_insert"/);
  });
});
