import { describe, expect, it } from "vitest";
import { hashPassword, hashSessionToken, newSessionToken, passwordProblem, sessionExpired, verifyPassword } from "../../../packages/shared/src/credentials";

describe("credentials", () => {
  it("hashes with a random salt and verifies only the right password", async () => {
    const h1 = await hashPassword("correct horse battery"), h2 = await hashPassword("correct horse battery");
    expect(h1).not.toBe(h2); expect(h1.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h1)).toBe(true); expect(await verifyPassword("correct horse batterY", h1)).toBe(false);
  }, 20_000);
  it("rejects weak passwords and treats malformed stored hashes as a mismatch", async () => {
    expect(passwordProblem("short")).toMatch(/at least 12/); await expect(hashPassword("short")).rejects.toThrow();
    for (const bad of ["", "plain", "scrypt$1$1$1$a$b", "scrypt$x$8$1$AAAA$BBBB", "scrypt$99999999999$8$1$AAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBB"]) expect(await verifyPassword("whatever password", bad), bad).toBe(false);
  });
  it("session tokens are random, stored only as a hash, and expire", () => {
    const a = newSessionToken(), b = newSessionToken();
    expect(a.token).not.toBe(b.token); expect(a.tokenHash).toBe(hashSessionToken(a.token)); expect(a.tokenHash).not.toContain(a.token);
    expect(sessionExpired("2026-01-01T00:00:00Z", new Date("2026-01-01T00:00:01Z"))).toBe(true); expect(sessionExpired("2026-01-01T00:00:10Z", new Date("2026-01-01T00:00:01Z"))).toBe(false);
  });
});
