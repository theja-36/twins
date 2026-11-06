import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALL_PROVIDERS, FILES } from "./runner";
import type { FileObservation } from "./sourceHealth";

const MAX_BYTES = 10_000_000;
const iso = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/** Reads the provider files READ-ONLY (stat + parse) and describes each one. A missing directory or file is `present: false`; nothing is written and no content beyond the summary fields is returned. */
export function observeProviderFiles(dir: string): FileObservation[] {
  return ALL_PROVIDERS.map((provider) => {
    const path = join(dir, FILES[provider]);
    let size: number, mtime: Date;
    try { const st = statSync(path); size = st.size; mtime = st.mtime; } catch { return { provider, present: false, readable: false, asOf: null, modifiedAt: null, format: null, source: null, count: null }; }
    const base = { provider, present: true, modifiedAt: mtime.toISOString() };
    if (size > MAX_BYTES) return { ...base, readable: false, asOf: null, format: null, source: null, count: null };
    try {
      const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
      if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { ...base, readable: false, asOf: null, format: null, source: null, count: null };
      const asOf = iso(doc["as_of"]);
      const obj = (k: string): number | null => (doc[k] && typeof doc[k] === "object" && !Array.isArray(doc[k]) ? Object.keys(doc[k] as object).length : null);
      const arr = (k: string): number | null => (Array.isArray(doc[k]) ? (doc[k] as unknown[]).length : null);
      const count = arr("items") ?? arr("events") ?? obj("entries") ?? obj("quotes") ?? obj("contexts") ?? obj("indices") ?? obj("markets");
      return { ...base, readable: asOf !== null, asOf, format: typeof doc["format"] === "string" ? doc["format"].slice(0, 60) : null, source: typeof doc["source"] === "string" ? doc["source"].slice(0, 40) : null, count };
    } catch { return { ...base, readable: false, asOf: null, format: null, source: null, count: null }; }
  });
}
