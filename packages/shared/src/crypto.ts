import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality comparison using `crypto.timingSafeEqual`.
 * Protects against timing side-channel attacks on secret tokens (spec/audit SEC-02).
 *
 * Rules:
 * - Safely returns false on undefined, null, non-string, or empty inputs without throwing.
 * - Safely returns false if byte lengths differ.
 * - Compares byte contents in constant time when lengths match.
 */
export function constantTimeCompare(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  if (a.length === 0 || b.length === 0) {
    return false;
  }

  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");

  if (bufA.length !== bufB.length) {
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

