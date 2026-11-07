import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { CONTRACT_VERSION } from "./contract";
import { dryRun, type DryRunSummary } from "./dryRun";
import { messageKey } from "./identity";
import { normalizeText, NORMALIZER_VERSION, PARSER_VERSION } from "./normalize";
import { manifestOf, manifestSha256, batchKeyOf, prepareRecords, type BatchOptions, type Prepared } from "./prepare";
import { InputError, type InputFile } from "./readers";

/**
 * The historical import (Stage 4 / Task 1). Idempotent, resumable, append-only:
 *  - the WHOLE input is validated by a dry run before the first write (a file-level problem writes nothing; records that fail validation refuse the import unless `allowInvalid`);
 *  - the batch is identified by the input hashes + label + parser + options, so re-running the same import resolves to the same batch;
 *  - every message version has a stable identity: a re-delivery is recorded as a `duplicate_delivery` warning, never as a second record; an edit is a NEW revision row linked to
 *    the original version; nothing is ever updated;
 *  - work is committed in chunks, each with a checkpoint row in the same transaction, so a crash loses at most one chunk and a re-run resumes after the last checkpoint.
 * It writes only the historical_* tables: no signal, options claim, risk decision, approval card, order or broker call exists on this path, and the importer reads no control
 * state (it is research storage, not trade state). Message content is never logged.
 */
export const IMPORTER_VERSION = "historical-import-v1";
const ACTOR = /^(service|operator):[a-z0-9][a-z0-9._-]{1,40}$/;
const LOCK_NS = 1953723;

export interface ImportOptions extends BatchOptions {
  createdBy: string;
  /** The source path exactly as the operator confirmed it (stored as a base name only). */
  confirmedSource: string;
  chunkSize?: number;
  allowInvalid?: boolean;
  now?: Date;
  /** Test hook: called after each committed chunk; throwing simulates a crash. */
  afterChunk?: (sequence: number) => void;
}

export interface Counters {
  recordsConsumed: number; validRecords: number; invalidRecords: number; messageVersions: number; newSourceRecords: number; duplicates: number; revisions: number; normalizedRecords: number;
  byParseStatus: Record<string, number>; byValidation: Record<string, number>; warningsByCode: Record<string, number>; errorsByCode: Record<string, number>;
}
const zero = (): Counters => ({ recordsConsumed: 0, validRecords: 0, invalidRecords: 0, messageVersions: 0, newSourceRecords: 0, duplicates: 0, revisions: 0, normalizedRecords: 0, byParseStatus: {}, byValidation: {}, warningsByCode: {}, errorsByCode: {} });
const bump = (o: Record<string, number>, k: string, n = 1): void => { o[k] = (o[k] ?? 0) + n; };

export interface ImportResult {
  batchId: string;
  batchKey: string;
  outcome: "IMPORTED" | "RESUMED" | "ALREADY_COMPLETED";
  resumedFromRecord: number;
  checkpoints: number;
  counters: Counters;
}

export async function runImport(db: Db, files: InputFile[], opts: ImportOptions): Promise<ImportResult> {
  if (!ACTOR.test(opts.createdBy)) throw new InputError("invalid_created_by");
  if (!opts.confirmedSource.trim()) throw new InputError("source_not_confirmed");
  const now = opts.now ?? new Date();
  const chunkSize = Math.max(1, Math.min(opts.chunkSize ?? 500, 5000));
  const pre: DryRunSummary = await dryRun(files, opts, undefined, now); // validates everything, reads every file: any file-level InputError aborts here, before any write
  if (pre.invalidRecords > 0 && !opts.allowInvalid) throw new InputError("invalid_records_present");
  const batchKey = batchKeyOf(files, opts);
  const manifestHash = manifestSha256(files);

  const [created] = await db.insert(schema.historicalImportBatches).values({
    batchKey, label: opts.label, format: [...new Set(files.map((f) => f.format))].sort().join(","), contractVersion: CONTRACT_VERSION, parserVersion: PARSER_VERSION, defaultMarket: opts.defaultMarket,
    manifest: manifestOf(files), manifestSha256: manifestHash, options: { chunkSize, allowInvalid: opts.allowInvalid === true, importer: IMPORTER_VERSION, normalizer: NORMALIZER_VERSION },
    confirmedSource: opts.confirmedSource.replace(/^.*[\\/]/, "").slice(0, 120) || "input", createdBy: opts.createdBy,
  }).onConflictDoNothing({ target: schema.historicalImportBatches.batchKey }).returning({ id: schema.historicalImportBatches.id });
  const [batch] = created ? [created] : await db.select({ id: schema.historicalImportBatches.id }).from(schema.historicalImportBatches).where(eq(schema.historicalImportBatches.batchKey, batchKey));
  if (!batch) throw new InputError("batch_not_found");
  const batchId = batch.id;

  const [last] = await db.select().from(schema.historicalImportCheckpoints).where(eq(schema.historicalImportCheckpoints.batchId, batchId)).orderBy(desc(schema.historicalImportCheckpoints.sequence)).limit(1);
  if (last?.status === "COMPLETED") return { batchId, batchKey, outcome: "ALREADY_COMPLETED", resumedFromRecord: last.recordsConsumed, checkpoints: last.sequence, counters: last.counters as Counters };
  let counters: Counters = last ? (last.counters as Counters) : zero();
  let sequence = last?.sequence ?? 0;
  const skip = last?.recordsConsumed ?? 0;
  const resumed = skip > 0;

  const flush = async (chunk: Prepared[], final: boolean): Promise<void> => {
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      for (const rec of chunk) counters = await processRecord(tx, batchId, files, rec, opts, counters);
      counters.recordsConsumed += chunk.length;
      sequence += 1;
      await tx.insert(schema.historicalImportCheckpoints).values({ batchId, sequence, recordsConsumed: counters.recordsConsumed, counters, status: final ? "COMPLETED" : "IN_PROGRESS" });
    });
    opts.afterChunk?.(sequence);
  };

  let index = 0;
  let chunk: Prepared[] = [];
  for await (const rec of prepareRecords(files, now)) {
    if (index++ < skip) continue;
    chunk.push(rec);
    if (chunk.length >= chunkSize) { await flush(chunk, false); chunk = []; }
  }
  await flush(chunk, true);
  return { batchId, batchKey, outcome: resumed ? "RESUMED" : "IMPORTED", resumedFromRecord: skip, checkpoints: sequence, counters };
}

async function issue(tx: Db, batchId: string, severity: "WARNING" | "ERROR", code: string, file: string | null, line: number | null, sourceRecordId: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  await tx.insert(schema.historicalImportIssues).values({ batchId, sourceRecordId, severity, code, sourceFile: file, sourceLine: line, detail });
}

async function processRecord(tx: Db, batchId: string, files: InputFile[], rec: Prepared, opts: ImportOptions, counters: Counters): Promise<Counters> {
  const file = files[rec.file] as InputFile;
  if (rec.kind === "invalid") {
    counters.invalidRecords += 1;
    bump(counters.errorsByCode, rec.code);
    await issue(tx, batchId, "ERROR", rec.code, file.name, rec.line, null);
    return counters;
  }
  counters.validRecords += 1;
  const m = rec.message;
  const key = messageKey(m.channel, m.messageId);
  let recordWarningsPending = [...rec.warnings];
  for (const v of rec.versions) {
    counters.messageVersions += 1;
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_NS}, hashtext(${key}))`);
    const [existing] = await tx.select({ id: schema.historicalSourceRecords.id }).from(schema.historicalSourceRecords).where(eq(schema.historicalSourceRecords.identityKey, v.identity));
    if (existing) {
      counters.duplicates += 1;
      bump(counters.warningsByCode, "duplicate_delivery");
      await issue(tx, batchId, "WARNING", "duplicate_delivery", file.name, rec.line, existing.id);
      continue;
    }
    const [original] = await tx.select({ id: schema.historicalSourceRecords.id }).from(schema.historicalSourceRecords).where(and(eq(schema.historicalSourceRecords.channelLabel, m.channel), eq(schema.historicalSourceRecords.originalMessageId, m.messageId), eq(schema.historicalSourceRecords.revisionNo, 0)));
    let revisionNo = 0;
    let editOfId: string | null = null;
    const extra: string[] = [];
    if (original) {
      const [mx] = await tx.select({ n: sql<number>`coalesce(max(${schema.historicalSourceRecords.revisionNo}), 0)::int` }).from(schema.historicalSourceRecords).where(and(eq(schema.historicalSourceRecords.channelLabel, m.channel), eq(schema.historicalSourceRecords.originalMessageId, m.messageId)));
      revisionNo = (mx?.n ?? 0) + 1;
      editOfId = original.id;
      counters.revisions += 1;
      extra.push(v.fromEditsArray ? "edit_revision" : "redelivery_conflict");
    }
    const [row] = await tx.insert(schema.historicalSourceRecords).values({
      batchId, identityKey: v.identity, channelLabel: m.channel, originalMessageId: m.messageId, messageTimestamp: v.timestamp, author: m.author, rawText: v.text, contentSha256: v.contentSha, rawTextRedacted: v.redactedKinds.length > 0 ? "yes" : "no",
      mediaRefs: m.media, editOfId, revisionNo, editedAt: v.editedAt, sourceFile: file.name, sourceFileSha256: file.sha256, sourceLine: rec.line,
      provenance: { contractVersion: CONTRACT_VERSION, importer: IMPORTER_VERSION, batchLabel: opts.label, redactedKinds: v.redactedKinds, viaEditsArray: v.fromEditsArray }, createdBy: opts.createdBy,
    }).returning({ id: schema.historicalSourceRecords.id });
    const sourceId = (row as { id: string }).id;
    counters.newSourceRecords += 1;
    const n = normalizeText(v.text, { recordMarket: m.market, defaultMarket: opts.defaultMarket, source: m.channel, ...(opts.sourceBasis ? { sourceBasis: opts.sourceBasis } : {}) });
    const [norm] = await tx.insert(schema.historicalNormalizedRecords).values({
      sourceRecordId: sourceId, parserVersion: PARSER_VERSION, parseStatus: n.parseStatus, market: n.market, marketSource: n.marketSource, instrumentType: n.instrumentType, underlying: n.underlying, expiry: n.expiry, expiryDate: n.expiryDate,
      strike: n.strike === null ? null : String(n.strike), optionType: n.optionType, side: n.side, entry: n.entry, stopLoss: n.stopLoss === null ? null : String(n.stopLoss), levelBasis: n.levelBasis, targets: n.targets, timeValidity: n.timeValidity,
      conditions: n.conditions, missingFields: n.missingFields, ambiguousFields: n.ambiguousFields, validationResult: n.validationResult, stopLossValidation: n.stopLossValidation, parsed: n.parsed, warnings: n.warnings,
    }).onConflictDoNothing({ target: [schema.historicalNormalizedRecords.sourceRecordId, schema.historicalNormalizedRecords.parserVersion] }).returning({ id: schema.historicalNormalizedRecords.id });
    if (norm) counters.normalizedRecords += 1;
    bump(counters.byParseStatus, n.parseStatus);
    bump(counters.byValidation, n.validationResult);
    const warnings = [...new Set([...recordWarningsPending, ...extra, ...n.warnings])];
    recordWarningsPending = [];
    for (const w of warnings) {
      bump(counters.warningsByCode, w);
      await issue(tx, batchId, "WARNING", w, file.name, rec.line, sourceId);
    }
  }
  return counters;
}

export async function batchIdOf(db: Db, files: InputFile[], opts: BatchOptions): Promise<string | undefined> {
  const [b] = await db.select({ id: schema.historicalImportBatches.id }).from(schema.historicalImportBatches).where(eq(schema.historicalImportBatches.batchKey, batchKeyOf(files, opts)));
  return b?.id;
}
