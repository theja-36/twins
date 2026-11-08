import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";

/**
 * Credential helpers for the multi-user architecture (ADR-003). Built-in scrypt, no new dependency. A stored password hash is
 * `scrypt$N$r$p$saltB64$hashB64`; a session token is 32 random bytes shown once to the client and stored only as its SHA-256.
 */
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 64, MAXMEM = 128 * N * R * 2;
const MIN_PASSWORD = 12, MAX_PASSWORD = 256;
function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((res, rej) => scryptCb(password.normalize("NFKC"), salt, keylen, { N: n, r, p, maxmem: Math.max(MAXMEM, 128 * n * r * 2) }, (e, k) => (e ? rej(e) : res(k))));
}
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `password must be at least ${MIN_PASSWORD} characters`;
  if (password.length > MAX_PASSWORD) return `password must be at most ${MAX_PASSWORD} characters`;
  return null;
}
export async function hashPassword(password: string): Promise<string> {
  const problem = passwordProblem(password); if (problem) throw new RangeError(problem);
  const salt = randomBytes(16); const key = await scrypt(password, salt, N, R, P, KEYLEN);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}
/** Constant-time verification; a malformed stored hash verifies as false, never throws. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$"); if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 2 ** 20 || (n & (n - 1)) !== 0) return false;
  try {
    const salt = Buffer.from(parts[4] ?? "", "base64"), want = Buffer.from(parts[5] ?? "", "base64");
    if (salt.length < 8 || want.length < 16) return false;
    const got = await scrypt(password, salt, n, r, p, want.length);
    return got.length === want.length && timingSafeEqual(got, want);
  } catch { return false; }
}
export interface SessionToken { token: string; tokenHash: string }
export function newSessionToken(): SessionToken { const token = randomBytes(32).toString("base64url"); return { token, tokenHash: hashSessionToken(token) }; }
export const hashSessionToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const sessionExpired = (expiresAt: string, now: Date): boolean => Date.parse(expiresAt) <= now.getTime();
