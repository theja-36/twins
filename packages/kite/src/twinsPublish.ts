import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspectSnapshot, listSnapshots, snapshotFileName, writeSnapshot, type SnapshotConfig, type SnapshotIo, type SnapshotKind, type SnapshotReport } from "@twins/agents/src/snapshots";
import type { ExportResult, KiteSnapshotKind } from "./twinsExport";

export const GENERATION_FILE = ".kite-generation.json";
const ORDER: KiteSnapshotKind[] = ["instrument-reference", "ohlc", "last-price", "quotes", "option-quotes", "option-chain"];

export interface GenerationManifest {
  generation: string;
  status: "publishing" | "complete";
  complete: boolean; // false = the export itself was incomplete (only possible with requireComplete=false)
  startedAt: string;
  kinds: Partial<Record<KiteSnapshotKind, string>>; // sha256 of each file of this generation
}

export type PublishResult =
  | { published: true; generation: string; kinds: KiteSnapshotKind[]; complete: boolean }
  | { published: false; generation: string; reason: string; detail: string[]; rolledBack: boolean; touched: boolean };

export interface PublishOptions {
  now: Date;
  /** Default true: an incomplete export (any requested entry missing) is refused and nothing is touched. */
  requireComplete?: boolean;
  /** Test seam (same shape the snapshot writer uses). */
  io?: Partial<SnapshotIo>;
}

const text = (doc: Record<string, unknown>): string => `${JSON.stringify(doc, null, 2)}\n`;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function writeManifestText(dir: string, body: string): void {
  const tmp = join(dir, `.kite-generation.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try { const b = Buffer.from(body); let off = 0; while (off < b.length) off += writeSync(fd, b, off, b.length - off); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, join(dir, GENERATION_FILE));
}
const writeManifest = (dir: string, m: GenerationManifest): void => writeManifestText(dir, `${JSON.stringify(m)}\n`);

/**
 * Publishes ONE generation: every document is validated with the consumer's strict parser, written to a private staging directory and inspected with the
 * consumer's own `inspectSnapshot` (must be OK: stale / expired / malformed are refused), and only then moved into the live directory. A manifest marks the
 * generation as "publishing" first and "complete" last; if any step fails, the files already replaced are restored from `.previous` (or removed if they were new)
 * and the manifest says so. A crash in the middle leaves a manifest in state "publishing", which `verifyGeneration` reports as inconsistent: a mixed old/new
 * directory is detectable, never silent.
 */
export function publishGeneration(cfg: SnapshotConfig, result: ExportResult, opts: PublishOptions): PublishResult {
  const gen = result.report.generationId;
  const fail = (reason: string, detail: string[], rolledBack = false, touched = false): PublishResult => ({ published: false, generation: gen, reason, detail, rolledBack, touched });
  if ((opts.requireComplete ?? true) && !result.report.complete) {
    return fail("INCOMPLETE_EXPORT", result.report.kinds.filter((k) => k.missing.length || k.status === "omitted").map((k) => `${k.kind}:${k.missing.length || "omitted"}`));
  }
  const kinds = ORDER.filter((k) => result.documents[k] !== undefined);
  if (kinds.length === 0) return fail("NOTHING_TO_PUBLISH", []);
  const dir = resolve(cfg.dir);
  try { const st = lstatSync(dir); if (st.isSymbolicLink() || !st.isDirectory()) return fail("DIRECTORY_UNSAFE", []); } catch { mkdirSync(dir, { recursive: true, mode: 0o700 }); }

  // 1. stage + inspect with the consumer's own checks
  const staging = join(dir, `.staging-${randomBytes(6).toString("hex")}`);
  mkdirSync(staging, { mode: 0o700 });
  const texts: Partial<Record<KiteSnapshotKind, string>> = {};
  try {
    const problems: string[] = [];
    for (const k of kinds) {
      const t = text(result.documents[k] as Record<string, unknown>);
      texts[k] = t;
      writeFileSync(join(staging, snapshotFileName(k)), t, { mode: 0o600 });
      const r: SnapshotReport = inspectSnapshot(staging, k, cfg, opts.now);
      if (r.status !== "OK") problems.push(`${k}:${r.status}:${r.code}`);
    }
    if (problems.length) return fail("STAGED_SNAPSHOT_NOT_OK", problems);
  } finally { rmSync(staging, { recursive: true, force: true }); }

  // 2. publish: manifest "publishing" -> replace each file (previous kept) -> verify -> manifest "complete"
  const manifest: GenerationManifest = { generation: gen, status: "publishing", complete: result.report.complete, startedAt: opts.now.toISOString(), kinds: Object.fromEntries(kinds.map((k) => [k, sha(texts[k] as string)])) };
  const written: Array<{ kind: KiteSnapshotKind; replaced: boolean }> = [];
  let previousManifest: string | null = null;
  try { previousManifest = readFileSync(join(dir, GENERATION_FILE), "utf8"); } catch { previousManifest = null; }
  const rollback = (): boolean => {
    let ok = true;
    for (const w of [...written].reverse()) {
      const target = join(dir, snapshotFileName(w.kind));
      try {
        if (w.replaced) { const prev = readFileSync(join(dir, ".previous", snapshotFileName(w.kind))); const tmp = `${target}.${randomBytes(4).toString("hex")}.rollback`; writeFileSync(tmp, prev, { mode: 0o600 }); renameSync(tmp, target); } else unlinkSync(target);
      } catch { ok = false; }
    }
    // the manifest goes back to describing the generation that is on disk again
    try { if (previousManifest !== null) writeManifestText(dir, previousManifest); else unlinkSync(join(dir, GENERATION_FILE)); } catch { ok = false; }
    return ok;
  };
  try {
    writeManifest(dir, manifest);
    for (const k of kinds) {
      const w = writeSnapshot(cfg, k, texts[k] as string, { confirmOverwrite: k, now: opts.now, ...(opts.io ? { io: opts.io } : {}) });
      written.push({ kind: k, replaced: w.replaced });
    }
    const verdict = listSnapshots(cfg, opts.now);
    const bad = kinds.filter((k) => verdict.reports.find((r) => r.kind === k)?.status !== "OK");
    if (bad.length) { const ok = rollback(); return fail("PUBLISHED_SNAPSHOT_NOT_OK", bad, ok, true); }
    writeManifest(dir, { ...manifest, status: "complete" });
    return { published: true, generation: gen, kinds, complete: result.report.complete };
  } catch (e) {
    const ok = rollback();
    return fail(e instanceof Error && (e as { code?: string }).code ? String((e as { code?: string }).code) : "PUBLISH_FAILED", [], ok, true);
  }
}

export interface GenerationCheck { consistent: boolean; status: GenerationManifest["status"] | "none"; generation: string | null; mismatched: string[] }

/** Does the directory hold exactly one complete generation? Detects an interrupted publish (manifest still "publishing") and files that differ from the manifest. */
export function verifyGeneration(cfg: SnapshotConfig): GenerationCheck {
  const dir = resolve(cfg.dir);
  let m: GenerationManifest;
  try { m = JSON.parse(readFileSync(join(dir, GENERATION_FILE), "utf8")) as GenerationManifest; } catch { return { consistent: false, status: "none", generation: null, mismatched: [] }; }
  const mismatched: string[] = [];
  for (const [kind, hash] of Object.entries(m.kinds)) {
    try { if (sha(readFileSync(join(dir, snapshotFileName(kind as SnapshotKind)), "utf8")) !== hash) mismatched.push(kind); } catch { mismatched.push(kind); }
  }
  return { consistent: m.status === "complete" && mismatched.length === 0, status: m.status, generation: m.generation, mismatched };
}

