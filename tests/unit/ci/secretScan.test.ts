import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
// @ts-expect-error - plain ES module script (no type declarations)
import { ALLOWED_VALUES, FORBIDDEN_PATHS, scanPaths, scanText } from "../../../scripts/ci/secret-scan.mjs";

/** Credential-shaped values are assembled at run time so this file itself never contains one. */
const gh = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const aws = `AKI${"A"}${"QWERTY123456ZXCV"}`;
const pem = `-----BEGIN ${"RSA "}PRIVATE KEY-----`;
const tg = `${"1234567890"}:${"AAH_x9y8z7W6v5U4t3S2r1Q0p9O8n7M6l5K"}`;

const patterns = (path: string, line: string): string[] => (scanText(path, line) as Array<{ pattern: string }>).map((f) => f.pattern);

describe("secret scan", () => {
  it("detects credential-shaped strings anywhere, including tests and docs", () => {
    expect(patterns("src/a.ts", `const t = "${gh}"`)).toContain("github_token");
    expect(patterns("tests/a.test.ts", `x ${aws}`)).toContain("aws_access_key_id");
    expect(patterns("docs/a.md", pem)).toContain("private_key_block");
    expect(patterns("src/a.ts", `bot ${tg}`)).toContain("telegram_bot_token");
    expect(patterns("src/a.ts", `key sk-${"Z9".repeat(20)}`)).toContain("api_secret_key");
  });
  it("detects a password in a URL and a quoted secret assignment in runtime code, but not in tests, docs or templates (synthetic values are the norm there)", () => {
    const url = `postgresql://app:${"Pq7sT2vXy9"}@db.internal:5432/x`;
    expect(patterns("services/x/src/a.ts", url)).toContain("url_with_password");
    expect(patterns("infrastructure/x.yml", `password: "${"Ab12Cd34Ef56Gh78"}"`)).toContain("quoted_secret_assignment");
    expect(patterns("tests/unit/a.test.ts", url)).toEqual([]);
    expect(patterns("docs/x.md", url)).toEqual([]);
    expect(patterns(".env.example", url)).toEqual([]);
  });
  it("ignores placeholders and interpolations, and allows only the exact documented synthetic values", () => {
    expect(patterns("infrastructure/x.yml", "DATABASE_URL: postgresql://u:${POSTGRES_PASSWORD}@postgres:5432/db")).toEqual([]);
    expect(patterns("infrastructure/x.env", "TOKEN=CHANGE_ME_token_value_here1234567890")).toEqual([]);
    for (const [value, reason] of ALLOWED_VALUES as Map<string, string>) {
      expect(reason.length).toBeGreaterThan(10); // every allowance states why
      expect(patterns("services/x/src/a.ts", `postgresql://u:${value}@h/db`).filter((p) => p === "url_with_password")).toEqual([]);
    }
    expect(patterns("services/x/src/a.ts", `postgresql://u:${"ci_only_not_a_secret"}X@h/db`)).toContain("url_with_password"); // an almost-equal value is NOT allowed
  });
  it("refuses tracked secret material by path but not templates", () => {
    const hit = (p: string) => (scanPaths([p]) as unknown[]).length === 1;
    for (const p of [".env", ".env.production", "infrastructure/staging/staging.env", "infrastructure/staging/bot.env", "keys/a.pem", "x/id.key", "a.session", "backup.dump", "backup.dump.enc", "a.sqlite"]) expect(hit(p), p).toBe(true);
    for (const p of [".env.example", "infrastructure/staging/staging.env.example", "infrastructure/staging/bot.env.example", "README.md"]) expect(hit(p), p).toBe(false);
    expect((FORBIDDEN_PATHS as RegExp[]).length).toBeGreaterThan(5);
  });
  it("never prints the matched text, and the repository itself is clean", () => {
    const r = spawnSync("node", ["scripts/ci/secret-scan.mjs"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/tracked files scanned, no findings/);
  });
});
