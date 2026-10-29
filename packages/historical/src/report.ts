import { sql } from "drizzle-orm";
import type { Db } from "@twins/database";

/** The import report (Stage 4 / Task 1): counts, codes and ids only - never message content. */
export interface ImportReport {
  batch: { id: string; label: string; format: string; contractVersion: string; parserVersion: string; defaultMarket: string | null; manifestSha256: string; files: Array<{ name: string; sha256: string; bytes: number; format: string }>; confirmedSource: string; createdBy: string; createdAt: string };
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  checkpoints: number;
  recordsConsumed: number;
  sourceRecords: number;
  originalMessages: number;
  revisions: number;
  redactedRecords: number;
  normalizedRecords: number;
  byParseStatus: Record<string, number>;
  byValidation: Record<string, number>;
  byStopLoss: Record<string, number>;
  missingFields: Record<string, number>;
  ambiguousFields: Record<string, number>;
  warnings: Record<string, number>;
  errors: Record<string, number>;
  duplicateDeliveries: number;
}

const rows = async (db: Db, q: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> => (await db.execute(q)).rows as Array<Record<string, unknown>>;
const dict = (r: Array<Record<string, unknown>>): Record<string, number> => Object.fromEntries(r.map((x) => [String(x["k"]), Number(x["n"])]));

export async function buildReport(db: Db, batchId: string): Promise<ImportReport | undefined> {
  const [b] = await rows(db, sql`select * from historical_import_batches where id = ${batchId}`);
  if (!b) return undefined;
  const [cp] = await rows(db, sql`select sequence, records_consumed, status from historical_import_checkpoints where batch_id = ${batchId} order by sequence desc limit 1`);
  const [t] = await rows(db, sql`select count(*)::int as n, count(*) filter (where revision_no = 0)::int as orig, count(*) filter (where revision_no > 0)::int as rev, count(*) filter (where raw_text_redacted = 'yes')::int as red from historical_source_records where batch_id = ${batchId}`);
  const [nn] = await rows(db, sql`select count(*)::int as n from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id where s.batch_id = ${batchId}`);
  const j = (col: ReturnType<typeof sql>) => sql`select ${col} as k, count(*)::int as n from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id where s.batch_id = ${batchId} group by 1 order by 1`;
  const byParse = await rows(db, j(sql`n.parse_status`));
  const byVal = await rows(db, j(sql`n.validation_result`));
  const bySl = await rows(db, sql`select n.stop_loss_validation ->> 'result' as k, count(*)::int as n from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id where s.batch_id = ${batchId} and n.stop_loss_validation is not null group by 1 order by 1`);
  const miss = await rows(db, sql`select f as k, count(*)::int as n from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id, jsonb_array_elements_text(n.missing_fields) f where s.batch_id = ${batchId} group by 1 order by 1`);
  const amb = await rows(db, sql`select f as k, count(*)::int as n from historical_normalized_records n join historical_source_records s on s.id = n.source_record_id, jsonb_array_elements_text(n.ambiguous_fields) f where s.batch_id = ${batchId} group by 1 order by 1`);
  const warn = await rows(db, sql`select code as k, count(*)::int as n from historical_import_issues where batch_id = ${batchId} and severity = 'WARNING' group by 1 order by 1`);
  const err = await rows(db, sql`select code as k, count(*)::int as n from historical_import_issues where batch_id = ${batchId} and severity = 'ERROR' group by 1 order by 1`);
  const files = (b["manifest"] as Array<{ name: string; sha256: string; bytes: number; format: string }>) ?? [];
  return {
    batch: { id: String(b["id"]), label: String(b["label"]), format: String(b["format"]), contractVersion: String(b["contract_version"]), parserVersion: String(b["parser_version"]), defaultMarket: (b["default_market"] as string | null) ?? null, manifestSha256: String(b["manifest_sha256"]), files, confirmedSource: String(b["confirmed_source"]), createdBy: String(b["created_by"]), createdAt: new Date(b["created_at"] as string).toISOString() },
    status: !cp ? "NOT_STARTED" : cp["status"] === "COMPLETED" ? "COMPLETED" : "IN_PROGRESS", checkpoints: cp ? Number(cp["sequence"]) : 0, recordsConsumed: cp ? Number(cp["records_consumed"]) : 0,
    sourceRecords: Number(t?.["n"] ?? 0), originalMessages: Number(t?.["orig"] ?? 0), revisions: Number(t?.["rev"] ?? 0), redactedRecords: Number(t?.["red"] ?? 0), normalizedRecords: Number(nn?.["n"] ?? 0),
    byParseStatus: dict(byParse), byValidation: dict(byVal), byStopLoss: dict(bySl), missingFields: dict(miss), ambiguousFields: dict(amb), warnings: dict(warn), errors: dict(err), duplicateDeliveries: dict(warn)["duplicate_delivery"] ?? 0,
  };
}

export function renderReport(r: ImportReport): string {
  const kv = (o: Record<string, number>): string => (Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k}=${v}`).join(", ") : "none");
  return [
    `HISTORICAL IMPORT REPORT  batch ${r.batch.id}  [${r.status}]`,
    `label=${r.batch.label} created=${r.batch.createdAt} by=${r.batch.createdBy} source=${r.batch.confirmedSource}`,
    `contract=${r.batch.contractVersion} parser=${r.batch.parserVersion} defaultMarket=${r.batch.defaultMarket ?? "none"} manifest=${r.batch.manifestSha256.slice(0, 12)}`,
    `files: ${r.batch.files.map((f) => `${f.name} (${f.format}, ${f.bytes} B, ${f.sha256.slice(0, 12)})`).join("; ")}`,
    `records consumed=${r.recordsConsumed} checkpoints=${r.checkpoints}`,
    `source records=${r.sourceRecords} (original messages=${r.originalMessages}, revisions=${r.revisions}, redacted=${r.redactedRecords}) normalized=${r.normalizedRecords} duplicate deliveries=${r.duplicateDeliveries}`,
    `parse status: ${kv(r.byParseStatus)}`,
    `validation: ${kv(r.byValidation)}`,
    `stop-loss: ${kv(r.byStopLoss)}`,
    `missing fields: ${kv(r.missingFields)}`,
    `ambiguous fields: ${kv(r.ambiguousFields)}`,
    `warnings: ${kv(r.warnings)}`,
    `errors: ${kv(r.errors)}`,
  ].join("\n");
}
