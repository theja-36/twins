import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AgentContractError } from "./contract";

/**
 * Snapshot GENERATIONS (reader-enforced consistency). A publisher that replaces several snapshot files as one unit leaves a manifest next to them
 * (`.snapshot-generation.json`): the generation id, whether it is `publishing` or `complete`, whether it covers everything that was requested, and the SHA-256 of each
 * file it owns. READERS check it: while a generation is `publishing` (a publish in progress, or a crashed one), or when any file it owns differs from the manifest (a
 * mixed old/new directory), none of its files is accepted. A directory without a manifest behaves exactly as before.
 */
export const GENERATION_FILE = ".snapshot-generation.json";
export const PUBLISH_LOCK_FILE = ".snapshot-publish.lock";
export interface GenerationManifest {
  generation: string;
  status: "publishing" | "complete";
  /** false = the export that produced this generation was incomplete (only possible when the publisher was told to accept that). */
  complete: boolean;
  startedAt: string;
  /** kind -> sha256 of `<kind>.json` */
  kinds: Record<string, string>;
}
export type GenerationCheck =
  | { state: "none" }
  | { state: "ok"; manifest: GenerationManifest; manifestText: string }
  | { state: "inconsistent"; code: "MANIFEST_UNREADABLE" | "PUBLISHING" | "FILE_MISMATCH"; manifest?: GenerationManifest; mismatched: string[] };

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const HEX = /^[0-9a-f]{64}$/;

export function readManifest(dir: string): { text: string; manifest: GenerationManifest } | "unreadable" | null {
  let text: string;
  try { text = readFileSync(join(dir, GENERATION_FILE), "utf8"); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable"; }
  try {
    const m = JSON.parse(text) as Partial<GenerationManifest>;
    if (typeof m.generation !== "string" || (m.status !== "publishing" && m.status !== "complete") || typeof m.complete !== "boolean" || typeof m.kinds !== "object" || m.kinds === null || Array.isArray(m.kinds)) return "unreadable";
    if (Object.entries(m.kinds).some(([k, h]) => !/^[a-z-]{1,30}$/.test(k) || typeof h !== "string" || !HEX.test(h))) return "unreadable";
    return { text, manifest: m as GenerationManifest };
  } catch { return "unreadable"; }
}

/** Is the directory's generation complete and are all of its files exactly what the manifest says? */
export function checkGeneration(dir: string): GenerationCheck {
  const r = readManifest(dir);
  if (r === null) return { state: "none" };
  if (r === "unreadable") return { state: "inconsistent", code: "MANIFEST_UNREADABLE", mismatched: [] };
  const mismatched: string[] = [];
  for (const [kind, hash] of Object.entries(r.manifest.kinds)) {
    try { if (sha(readFileSync(join(dir, `${kind}.json`), "utf8")) !== hash) mismatched.push(kind); } catch { mismatched.push(kind); }
  }
  if (r.manifest.status !== "complete") return { state: "inconsistent", code: "PUBLISHING", manifest: r.manifest, mismatched };
  return mismatched.length ? { state: "inconsistent", code: "FILE_MISMATCH", manifest: r.manifest, mismatched } : { state: "ok", manifest: r.manifest, manifestText: r.text };
}

/** Does this generation own the file? (An unreadable manifest is treated as owning everything: fail closed.) */
export function ownsFile(check: GenerationCheck, fileName: string): boolean {
  if (check.state === "none") return false;
  if (check.state === "inconsistent" && check.code === "MANIFEST_UNREADABLE") return true;
  const m = check.state === "ok" ? check.manifest : check.manifest;
  return !!m && Object.keys(m.kinds).some((k) => `${k}.json` === fileName);
}

export interface ReadHooks { /** Test seam: runs between the consistency check and the read of the file itself. */ afterCheck?: () => void }

/**
 * Reads a snapshot file for a provider. Inside a generation directory the file is returned only if the generation is complete and consistent, the bytes read
 * hash to the manifest, and the manifest did not change while reading (so a publish that starts mid-read is caught). Otherwise it throws
 * `SNAPSHOT_GENERATION_INCONSISTENT`. A directory without a manifest is read as before.
 */
export function readVerifiedFile(path: string, hooks: ReadHooks = {}): string {
  const dir = dirname(path), name = basename(path);
  const first = checkGeneration(dir);
  if (first.state === "none" || !ownsFile(first, name)) return readFileSync(path, "utf8");
  if (first.state === "inconsistent") throw new AgentContractError("SNAPSHOT_GENERATION_INCONSISTENT", `the snapshot generation in this directory is not consistent (${first.code}); ${name} is refused`);
  hooks.afterCheck?.();
  const text = readFileSync(path, "utf8");
  const kind = name.replace(/\.json$/, "");
  const again = readManifest(dir);
  if (again === null || again === "unreadable" || again.text !== first.manifestText || sha(text) !== first.manifest.kinds[kind]) {
    throw new AgentContractError("SNAPSHOT_GENERATION_INCONSISTENT", `the snapshot generation changed while ${name} was being read`);
  }
  return text;
}
