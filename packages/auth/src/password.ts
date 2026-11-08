import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password handling (Stage 01). scrypt with a per-password random salt, parameters stored in the hash so they can be raised later; verification is constant-time.
 * A password is never logged, returned or stored in any other form. Unknown or malformed stored hashes verify as false (never throw).
 */
export interface ScryptParams { N: number; r: number; p: number }
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
const KEYLEN = 64, SALT_BYTES = 16, MAXMEM = 128 * 1024 * 1024;
const derive = (password: string, salt: Buffer, q: ScryptParams): Promise<Buffer> =>
  new Promise((resolve, reject) => { const o: ScryptOptions = { N: q.N, r: q.r, p: q.p, maxmem: MAXMEM }; scrypt(password.normalize("NFKC"), salt, KEYLEN, o, (e, k) => (e ? reject(e) : resolve(k))); });

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(SALT_BYTES), key = await derive(password, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
function parse(stored: string): { q: ScryptParams; salt: Buffer; key: Buffer } | null {
  const [alg, n, r, p, salt, key, extra] = stored.split("$");
  if (alg !== "scrypt" || extra !== undefined || !salt || !key) return null;
  const q = { N: Number(n), r: Number(r), p: Number(p) };
  if (![q.N, q.r, q.p].every((v) => Number.isInteger(v) && v > 0) || q.N > 2 ** 20 || (q.N & (q.N - 1)) !== 0) return null;
  const s = Buffer.from(salt, "base64"), k = Buffer.from(key, "base64");
  return s.length >= 8 && k.length === KEYLEN ? { q, salt: s, key: k } : null;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const p = parse(stored);
  if (!p) { await derive(password, Buffer.alloc(SALT_BYTES), DEFAULT_SCRYPT); return false; } // same cost as a real check: a malformed hash is not faster
  const k = await derive(password, p.salt, p.q);
  return k.length === p.key.length && timingSafeEqual(k, p.key);
}
/** True when the stored hash uses weaker parameters than the current default (re-hash on next successful login). */
export const needsRehash = (stored: string, want: ScryptParams = DEFAULT_SCRYPT): boolean => { const p = parse(stored); return p === null || p.q.N < want.N || p.q.r < want.r || p.q.p < want.p; };

const COMMON = new Set(["password1234", "123456789012", "qwertyuiop12", "letmein12345", "administrator", "iloveyou1234", "password12345", "welcome12345", "changeme1234"]);
/** Policy: 12-256 characters, not a common password, not the email or its local part, not a single repeated character. Returns reasons (empty = acceptable). */
export function passwordProblems(password: string, email: string): string[] {
  const out: string[] = [], pw = password.normalize("NFKC"), lower = pw.toLowerCase(), local = email.split("@")[0]?.toLowerCase() ?? "";
  if (pw.length < 12) out.push("at least 12 characters");
  if (pw.length > 256) out.push("at most 256 characters");
  if (/^(.)\1+$/.test(pw)) out.push("not a single repeated character");
  if (COMMON.has(lower)) out.push("not a commonly used password");
  if (lower === email.toLowerCase() || (local.length >= 4 && lower.includes(local))) out.push("must not contain your email name");
  return out;
}
