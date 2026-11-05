import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * Publishes one JSON data file for the agents. The document is VALIDATED with the agents' own strict parser BEFORE anything is written, then written to a private temp file (mode 0600),
 * flushed and renamed over the target in one step: a reader sees the old file or the new file, never a partial or an invalid one. An invalid document leaves the previous good file in place.
 */
export class PublishRefusedError extends Error { constructor() { super("document failed validation"); this.name = "PublishRefusedError"; } }

export function publishJson(dir: string, file: string, doc: unknown, validate: (raw: unknown) => unknown): { path: string; bytes: number } {
  if (!/^[a-z0-9][a-z0-9-]{0,40}\.json$/.test(file)) throw new Error("bad data file name");
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  try { validate(JSON.parse(text)); } catch { throw new PublishRefusedError(); }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, file), tmp = join(dir, `.${file}.${process.pid}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    const buf = Buffer.from(text, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } catch (e) { closeSync(fd); rmSync(tmp, { force: true }); throw e; }
  closeSync(fd);
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);
  return { path: target, bytes: Buffer.byteLength(text) };
}
