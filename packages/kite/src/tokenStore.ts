import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { KiteError } from "./errors";
import { advisoryExpiry } from "./session";

/**
 * The daily Kite access token on the host (P0-2 token persistence). One small JSON file, mode 0600, written atomically (private temp file in the same directory, fsync, rename), read back only if
 * it is a regular file (never a symlink), owned by this process's user, and not readable by group or others. The token is NEVER logged, returned in an error or placed in a status: every failure
 * is a `KiteError` code. The server decides whether a token still works; the expiry here is ADVISORY (tokens lapse around 06:00 IST the next day) and only drives reminders and a pre-open check.
 */
export interface StoredToken { accessToken: string; issuedAt: string; apiKeyFingerprint: string }
export type TokenStatus =
  | { present: false; reason: "missing" | "unsafe_permissions" | "unreadable" }
  | { present: true; issuedAt: string; advisoryExpiresAt: string; advisoryExpired: boolean; ageSeconds: number };

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const FP = /^[0-9a-f]{12}$/;
/** A short, non-reversible tag of the api key, so a token issued for another app is refused without storing the key. */
export const apiKeyFingerprint = (apiKey: string): string => createHash("sha256").update(`twins-kite-api-key:${apiKey}`).digest("hex").slice(0, 12); // a tag, not a credential

export class KiteTokenStore {
  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {
    if (!path || !path.startsWith("/")) throw new KiteError("CONFIG");
  }

  save(accessToken: string, apiKey: string): void {
    if (!TOKEN.test(accessToken)) throw new KiteError("CONFIG");
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify({ accessToken, issuedAt: this.now().toISOString(), apiKeyFingerprint: apiKeyFingerprint(apiKey) })}\n`;
    const tmp = join(dir, `.kite-token.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      const b = Buffer.from(body);
      let off = 0;
      while (off < b.length) off += writeSync(fd, b, off, b.length - off);
      fsyncSync(fd);
    } catch (e) { closeSync(fd); rmSync(tmp, { force: true }); throw e instanceof KiteError ? e : new KiteError("CONFIG"); }
    closeSync(fd);
    renameSync(tmp, this.path);
  }

  /** The stored token, or null when none is usable. Unsafe permissions or a foreign api key are reported through `status()`, never by returning the token. */
  load(apiKey: string): StoredToken | null {
    if (this.safety() !== "ok") return null;
    try {
      const j = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredToken>;
      if (typeof j.accessToken !== "string" || !TOKEN.test(j.accessToken) || typeof j.issuedAt !== "string" || Number.isNaN(Date.parse(j.issuedAt)) || typeof j.apiKeyFingerprint !== "string" || !FP.test(j.apiKeyFingerprint)) return null;
      if (j.apiKeyFingerprint !== apiKeyFingerprint(apiKey)) return null;
      return { accessToken: j.accessToken, issuedAt: j.issuedAt, apiKeyFingerprint: j.apiKeyFingerprint };
    } catch { return null; }
  }

  status(): TokenStatus {
    const s = this.safety();
    if (s !== "ok") return { present: false, reason: s };
    try {
      const j = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredToken>;
      if (typeof j.issuedAt !== "string" || Number.isNaN(Date.parse(j.issuedAt)) || typeof j.accessToken !== "string" || !TOKEN.test(j.accessToken)) return { present: false, reason: "unreadable" };
      const issued = new Date(j.issuedAt);
      const exp = advisoryExpiry(issued);
      const now = this.now();
      return { present: true, issuedAt: issued.toISOString(), advisoryExpiresAt: exp.toISOString(), advisoryExpired: now.getTime() >= exp.getTime(), ageSeconds: Math.max(0, Math.floor((now.getTime() - issued.getTime()) / 1000)) };
    } catch { return { present: false, reason: "unreadable" }; }
  }

  /** Removes the file (after the server rejected the token, or on logout of the host session). */
  clear(): void { rmSync(this.path, { force: true }); }

  private safety(): "ok" | "missing" | "unsafe_permissions" {
    try {
      const st = lstatSync(this.path);
      if (st.isSymbolicLink() || !st.isFile()) return "unsafe_permissions";
      if ((st.mode & 0o077) !== 0) return "unsafe_permissions";
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) return "unsafe_permissions";
      return "ok";
    } catch { return "missing"; }
  }
}
