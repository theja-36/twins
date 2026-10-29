import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RetentionClass } from "./retention";

/** Deterministic SHA-256 (lowercase hex) of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
export const sha256Bytes = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/** Non-sensitive facts captured from the database at one exported snapshot (the same snapshot the dump uses). */
export interface SnapshotFacts {
  /** Rows recorded in drizzle.__drizzle_migrations. */
  migrations: number;
  /** Exact row counts of the critical tables. */
  tableCounts: Record<string, number>;
  /** audit_chain_heads: chain -> { lastIndex, lastHash } (hashes are one-way digests, not content). */
  chainHeads: Record<string, { lastIndex: number; lastHash: string }>;
}

export const MANIFEST_VERSION = 1;
export const ENCRYPTION_METHOD = "age v1 (X25519 recipient, ChaCha20-Poly1305), client-side";

/** One record per stored object. Contains no secret, no key, no row content. */
export interface BackupManifest {
  manifestVersion: number;
  /** Object file name, e.g. twins-staging-20301231T023000Z.tar.age */
  name: string;
  /** Object keys this artifact is stored under, one per retention class. */
  keys: string[];
  retentionClasses: RetentionClass[];
  environment: string;
  createdAt: string;
  bytes: number;
  /** SHA-256 of the ENCRYPTED artifact (what is stored off-host). */
  sha256: string;
  /** SHA-256 of the plaintext tar, so a drill can prove decryption reproduced the original. */
  plainSha256: string;
  encryption: string;
  recipientFingerprint: string;
  bundle: { dumpSha256: string; dumpBytes: number; files: string[]; anchorIncluded: boolean };
  snapshot: SnapshotFacts;
  /** Non-secret fingerprint of the host that created the backup; a restore on a host with a different fingerprint is cross-host evidence. */
  sourceHost: string;
  tool: { name: string; version: number };
  /** Set by the post-upload verification. */
  uploadVerifiedAt?: string;
}

const NAME = /^twins-[a-z0-9-]{1,30}-\d{8}T\d{6}Z\.tar\.age$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function artifactName(environment: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const name = `twins-${environment}-${stamp}.tar.age`;
  if (!NAME.test(name)) throw new Error("environment name must be 1-30 characters of a-z 0-9 -");
  return name;
}

export function parseManifest(text: string): BackupManifest {
  let m: BackupManifest;
  try {
    m = JSON.parse(text) as BackupManifest;
  } catch {
    throw new Error("manifest is not valid JSON");
  }
  if (m?.manifestVersion !== MANIFEST_VERSION || typeof m.name !== "string" || !NAME.test(m.name)) throw new Error("manifest: unsupported version or name");
  if (!HEX64.test(m.sha256) || !HEX64.test(m.plainSha256) || !Number.isSafeInteger(m.bytes) || m.bytes <= 0) throw new Error("manifest: bad checksum or size");
  if (!Array.isArray(m.keys) || m.keys.length === 0 || m.keys.some((k) => typeof k !== "string" || k.includes(".."))) throw new Error("manifest: bad keys");
  return m;
}

/** Append-only local manifest log (one JSON object per line). */
export async function appendManifestLog(path: string, m: BackupManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(m)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** The UTC creation time encoded in an artifact key / name (`twins-<env>-YYYYMMDDTHHMMSSZ.tar.age`). Deterministic: independent of the provider's clock or copy times. */
export function timestampFromKey(key: string): Date | undefined {
  const m = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.tar\.age$/.exec(key);
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
  return Number.isNaN(d.getTime()) ? undefined : d;
}
