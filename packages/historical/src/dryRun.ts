import { inArray } from "drizzle-orm";
import { schema, type Db } from "@twins/database";
import { CONTRACT_VERSION } from "./contract";
import { messageKey } from "./identity";
import { manifestOf, manifestSha256, prepareRecords, batchKeyOf, type BatchOptions } from "./prepare";
import { normalizeText, NORMALIZER_VERSION, PARSER_VERSION } from "./normalize";
import type { InputFile } from "./readers";

/**
 * The read-only DRY RUN (Stage 4 / Task 1): validates the whole input, normalizes every message version in memory and summarizes - total records, parseable
 * records, duplicates (inside the input and, when a database handle is given, already imported), revisions, warnings and errors - without writing anything.
 */
export interface DryRunSummary {
  contractVersion: string;
  parserVersion: string;
  normalizerVersion: string;
  batchKey: string;
  manifestSha256: string;
  files: Array<{ name: string; format: string; sha256: string; bytes: number }>;
  totalRecords: number;
  validRecords: number;
  invalidRecords: number;
  invalidByCode: Record<string, number>;
  messageVersions: number;
  uniqueMessages: number;
  revisions: number;
  duplicatesInInput: number;
  alreadyImported: number | null;
  parseable: number;
  byParseStatus: Record<string, number>;
  byValidation: Record<string, number>;
  byStopLoss: Record<string, number>;
  missingFields: Record<string, number>;
  ambiguousFields: Record<string, number>;
  warningsByCode: Record<string, number>;
}

const bump = (o: Record<string, number>, k: string, n = 1): void => { o[k] = (o[k] ?? 0) + n; };

export async function dryRun(files: InputFile[], opts: BatchOptions, db?: Db, now: Date = new Date()): Promise<DryRunSummary> {
  const s: DryRunSummary = {
    contractVersion: CONTRACT_VERSION, parserVersion: PARSER_VERSION, normalizerVersion: NORMALIZER_VERSION, batchKey: batchKeyOf(files, opts), manifestSha256: manifestSha256(files), files: manifestOf(files),
    totalRecords: 0, validRecords: 0, invalidRecords: 0, invalidByCode: {}, messageVersions: 0, uniqueMessages: 0, revisions: 0, duplicatesInInput: 0, alreadyImported: null, parseable: 0,
    byParseStatus: {}, byValidation: {}, byStopLoss: {}, missingFields: {}, ambiguousFields: {}, warningsByCode: {},
  };
  const identities = new Set<string>();
  const keys = new Set<string>();
  for await (const r of prepareRecords(files, now)) {
    s.totalRecords += 1;
    if (r.kind === "invalid") { s.invalidRecords += 1; bump(s.invalidByCode, r.code); continue; }
    s.validRecords += 1;
    for (const w of r.warnings) bump(s.warningsByCode, w);
    const key = messageKey(r.message.channel, r.message.messageId);
    for (const v of r.versions) {
      if (identities.has(v.identity)) { s.duplicatesInInput += 1; continue; }
      const firstOfMessage = !keys.has(key);
      identities.add(v.identity);
      keys.add(key);
      s.messageVersions += 1;
      if (firstOfMessage) s.uniqueMessages += 1;
      else { s.revisions += 1; bump(s.warningsByCode, v.fromEditsArray ? "edit_revision" : "redelivery_conflict"); }
      const n = normalizeText(v.text, { recordMarket: r.message.market, defaultMarket: opts.defaultMarket });
      bump(s.byParseStatus, n.parseStatus);
      bump(s.byValidation, n.validationResult);
      if (n.parseStatus === "SIGNAL" || n.parseStatus === "OPTIONS_CLAIM") s.parseable += 1;
      if (n.stopLossValidation) bump(s.byStopLoss, n.stopLossValidation.result);
      for (const f of n.missingFields) bump(s.missingFields, f);
      for (const f of n.ambiguousFields) bump(s.ambiguousFields, f);
      for (const w of n.warnings) bump(s.warningsByCode, w);
    }
  }
  if (db) {
    const all = [...identities];
    let found = 0;
    for (let i = 0; i < all.length; i += 1000) {
      const rows = await db.select({ k: schema.historicalSourceRecords.identityKey }).from(schema.historicalSourceRecords).where(inArray(schema.historicalSourceRecords.identityKey, all.slice(i, i + 1000)));
      found += rows.length;
    }
    s.alreadyImported = found;
  }
  return s;
}
