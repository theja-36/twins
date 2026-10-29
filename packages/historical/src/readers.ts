import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

/**
 * Reading a local export (Stage 4 / Task 1): JSONL / JSON / CSV only. No network, no Telegram, no session or credential file. A file-level problem is an
 * `InputError` (nothing is written); a bad record is reported per line by code and never by content.
 */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export type InputFormat = "jsonl" | "json" | "csv";
const EXTENSIONS: Record<string, InputFormat> = { ".jsonl": "jsonl", ".ndjson": "jsonl", ".json": "json", ".csv": "csv" };
/** File names that look like credentials / sessions / environment files are refused outright, whatever their extension. */
const FORBIDDEN_NAME = /(^|[._-])(session|sessions|secret|secrets|token|tokens|credential|credentials|passwd|password|id_rsa|id_ed25519|private|env)([._-]|$)|\.(pem|key|p12|pfx|sqlite3?|db|session|env)$/i;

export class InputError extends Error {
  constructor(readonly code: string, readonly file?: string) {
    super(code);
    this.name = "InputError";
  }
}

export interface InputFile { path: string; name: string; format: InputFormat; sha256: string; bytes: number }
export interface RawRecord { file: number; line: number; value?: unknown; error?: string }

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolveHash(h.digest("hex")));
  });
}

function checkFile(path: string): { bytes: number; format: InputFormat } {
  const st = lstatSync(path);
  const name = basename(path);
  if (st.isSymbolicLink()) throw new InputError("symlink_not_allowed", name);
  if (!st.isFile()) throw new InputError("not_a_regular_file", name);
  if (FORBIDDEN_NAME.test(name)) throw new InputError("forbidden_file_name", name);
  const format = EXTENSIONS[extname(name).toLowerCase()];
  if (!format) throw new InputError("unsupported_file_type", name);
  if (st.size === 0) throw new InputError("empty_file", name);
  if (st.size > MAX_FILE_BYTES) throw new InputError("file_too_large", name);
  const head = readFileSync(path, { encoding: null }).subarray(0, 8192);
  if (head.includes(0)) throw new InputError("not_a_text_file", name);
  return { bytes: st.size, format };
}

/** Validates the path and returns the files in a deterministic order (a directory is read non-recursively, sorted by name). Throws InputError. */
export async function inspectInput(inputPath: string): Promise<InputFile[]> {
  const abs = resolve(inputPath);
  let st;
  try { st = lstatSync(abs); } catch { throw new InputError("path_not_found"); }
  if (st.isSymbolicLink()) throw new InputError("symlink_not_allowed", basename(abs));
  const paths: string[] = [];
  if (st.isDirectory()) {
    const names = readdirSync(abs).sort();
    for (const n of names) {
      if (FORBIDDEN_NAME.test(n)) throw new InputError("forbidden_file_name", n);
      if (EXTENSIONS[extname(n).toLowerCase()]) paths.push(join(abs, n));
    }
    if (paths.length === 0) throw new InputError("no_supported_files");
  } else paths.push(abs);
  const files: InputFile[] = [];
  for (const p of paths) {
    const { bytes, format } = checkFile(p);
    files.push({ path: p, name: basename(p), format, sha256: await hashFile(p), bytes });
  }
  return files;
}

/** RFC-4180 style CSV: quoted fields, doubled quotes, newlines inside quotes. Returns rows of cells (no content is ever logged). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false; } else cell += c;
    } else if (c === '"' && cell === "") inQuotes = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cell += c;
  }
  if (inQuotes) throw new InputError("csv_unterminated_quote");
  if (cell !== "" || row.length > 0) { row.push(cell); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}

const CSV_REQUIRED = ["channel", "message_id", "timestamp", "text"];

/** Streams the records of one file. `line` is the 1-based line (JSONL), the 1-based record index (JSON array) or the CSV row number. */
export async function* readRecords(file: InputFile, fileIndex: number): AsyncGenerator<RawRecord> {
  if (file.format === "jsonl") {
    const rl = createInterface({ input: createReadStream(file.path, { encoding: "utf8" }), crlfDelay: Infinity });
    let line = 0;
    for await (const text of rl) {
      line += 1;
      if (text.trim() === "") continue;
      try { yield { file: fileIndex, line, value: JSON.parse(text) }; } catch { yield { file: fileIndex, line, error: "malformed_json" }; }
    }
    return;
  }
  const body = readFileSync(file.path, "utf8").replace(/^﻿/, "");
  if (file.format === "json") {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new InputError("malformed_json_file", file.name); }
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown }).records) ? (parsed as { records: unknown[] }).records : null;
    if (!list) throw new InputError("invalid_json_structure", file.name);
    for (let i = 0; i < list.length; i++) yield { file: fileIndex, line: i + 1, value: list[i] };
    return;
  }
  const rows = parseCsv(body);
  const header = (rows[0] ?? []).map((h) => h.trim());
  if (!CSV_REQUIRED.every((h) => header.includes(h))) throw new InputError("csv_header_invalid", file.name);
  if (new Set(header).size !== header.length) throw new InputError("csv_header_invalid", file.name);
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i] as string[];
    if (cells.length !== header.length) { yield { file: fileIndex, line: i + 1, error: "csv_row_malformed" }; continue; }
    const obj: Record<string, unknown> = {};
    header.forEach((h, k) => { const v = cells[k] as string; if (v !== "") obj[h] = v; });
    if (typeof obj["message_id"] === "string" && /^\d+$/.test(obj["message_id"] as string)) obj["message_id"] = String(obj["message_id"]);
    if (typeof obj["timestamp"] === "string" && /^\d{9,11}$/.test(obj["timestamp"] as string)) obj["timestamp"] = Number(obj["timestamp"]);
    if (obj["text"] === undefined) obj["text"] = "";
    if (typeof obj["media"] === "string") obj["media"] = (obj["media"] as string).split(";").filter(Boolean).map((m) => { const k = m.indexOf(":"); return { type: k < 0 ? m : m.slice(0, k), ref: k < 0 ? "" : m.slice(k + 1) }; });
    if (typeof obj["edit_text"] === "string" && obj["edited_at"] !== undefined) { obj["edits"] = [{ edited_at: obj["edited_at"], text: obj["edit_text"] }]; delete obj["edit_text"]; }
    yield { file: fileIndex, line: i + 1, value: obj };
  }
}

export async function* readAll(files: InputFile[]): AsyncGenerator<RawRecord> {
  for (let i = 0; i < files.length; i++) yield* readRecords(files[i] as InputFile, i);
}
