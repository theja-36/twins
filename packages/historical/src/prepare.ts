import { CONTRACT_VERSION, validateRawRecord, type HistoricalMessage } from "./contract";
import { contentSha256, identityKey, messageKey, sha256 } from "./identity";
import { InputError, readAll, type InputFile } from "./readers";
import { redactSecrets } from "./redact";
import { NORMALIZER_VERSION, PARSER_VERSION } from "./normalize";
import type { SourceBasisConfig } from "@twins/signals";

/**
 * Turns the validated records of an input into message VERSIONS ready to store (Stage 4 / Task 1): the original text, then each edit in time order, every text redacted
 * of secret-shaped and personal strings BEFORE hashing or storing. Pure: no database. A message whose edit is textually identical to an earlier version yields no new version.
 */
export interface MessageVersion {
  timestamp: Date;
  editedAt: Date | null;
  /** Redacted text. */
  text: string;
  contentSha: string;
  identity: string;
  redactedKinds: string[];
  fromEditsArray: boolean;
}
export type Prepared =
  | { kind: "invalid"; file: number; line: number; code: string }
  | { kind: "ok"; file: number; line: number; message: HistoricalMessage; versions: MessageVersion[]; warnings: string[] };

export function buildVersions(m: HistoricalMessage): { versions: MessageVersion[]; warnings: string[] } {
  const warnings: string[] = [];
  const out: MessageVersion[] = [];
  const seen = new Set<string>();
  const add = (text: string, editedAt: Date | null, fromEditsArray: boolean): void => {
    const r = redactSecrets(text);
    if (r.kinds.length > 0) warnings.push("secret_redacted");
    const contentSha = contentSha256(r.text);
    const identity = identityKey(m.channel, m.messageId, m.timestamp, contentSha);
    if (seen.has(identity)) { warnings.push("edit_text_identical"); return; }
    seen.add(identity);
    out.push({ timestamp: m.timestamp, editedAt, text: r.text, contentSha, identity, redactedKinds: r.kinds, fromEditsArray });
  };
  add(m.text, null, false);
  for (const e of m.edits) add(e.text, e.editedAt, true);
  if (m.text === "") warnings.push("empty_text");
  return { versions: out, warnings: [...new Set(warnings)] };
}

export async function* prepareRecords(files: InputFile[], now: Date): AsyncGenerator<Prepared> {
  for await (const r of readAll(files)) {
    if (r.error) { yield { kind: "invalid", file: r.file, line: r.line, code: r.error }; continue; }
    const v = validateRawRecord(r.value, now);
    if (!v.ok) { yield { kind: "invalid", file: r.file, line: r.line, code: v.code }; continue; }
    const { versions, warnings } = buildVersions(v.message);
    yield { kind: "ok", file: r.file, line: r.line, message: v.message, versions, warnings: [...new Set([...v.warnings, ...warnings])] };
  }
}

export interface BatchOptions { label: string; defaultMarket: string | null; /** Owner-configured per-source default level basis (premium); part of the batch identity when set. */ sourceBasis?: SourceBasisConfig }
const LABEL = /^[A-Za-z0-9_.:@ -]{1,80}$/;

export function manifestOf(files: InputFile[]) {
  return files.map((f) => ({ name: f.name, format: f.format, sha256: f.sha256, bytes: f.bytes }));
}
export const manifestSha256 = (files: InputFile[]): string => sha256(JSON.stringify(manifestOf(files).map((f) => [f.name, f.sha256, f.bytes])));

/** Same input files + label + parser + normalizer + contract + options = the same batch: re-running an import resolves to the batch it already created. */
export function batchKeyOf(files: InputFile[], o: BatchOptions): string {
  if (!LABEL.test(o.label)) throw new InputError("invalid_label");
  return sha256(JSON.stringify({ manifest: manifestSha256(files), label: o.label, parser: PARSER_VERSION, normalizer: NORMALIZER_VERSION, contract: CONTRACT_VERSION, defaultMarket: o.defaultMarket, ...(o.sourceBasis && o.sourceBasis.premiumSources.size > 0 ? { sourceBasis: { sources: [...o.sourceBasis.premiumSources].sort(), maxStopPct: o.sourceBasis.maxStopPctOfStrike } } : {}) }));
}
export { messageKey };
