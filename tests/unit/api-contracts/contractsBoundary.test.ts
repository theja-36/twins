/** The package must be browser-safe: only relative imports, no dependency, no Node built-in, no environment access, no secret, no arithmetic on money. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url).pathname;
const PKG = join(ROOT, "packages/api-contracts");
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (["node_modules", "dist", ".next", "standalone", "playwright-report", "test-results"].includes(n) ? [] : files(p)) : /\.tsx?$/.test(p) ? [p] : []; });
const src = files(join(PKG, "src")).map((f) => ({ f: f.slice(ROOT.length), text: readFileSync(f, "utf8") }));
const code = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("@twins/api-contracts is browser-safe", () => {
  it("has source files and a package manifest with NO dependency of any kind and no scripts", () => {
    expect(src.length).toBeGreaterThanOrEqual(7);
    const m = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as Record<string, unknown>;
    expect(m["name"]).toBe("@twins/api-contracts"); expect(m["private"]).toBe(true); expect(m["type"]).toBe("module");
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "scripts", "bin"]) expect(m, k).not.toHaveProperty(k);
  });
  it("imports only relative modules (no backend package, no Node built-in, no third-party module)", () => {
    for (const { f, text } of src) {
      const specs = [...code(text).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string);
      for (const s of specs) expect(s.startsWith("./"), `${f} imports ${s}`).toBe(true);
      expect(code(text), f).not.toMatch(/\brequire\s*\(/);
    }
  });
  it("never reads the environment, a secret, a token or the shared service key", () => {
    for (const { f, text } of src) {
      const c = code(text);
      expect(c, f).not.toMatch(/process\.env|import\.meta\.env|TWINS_API_KEY|TELEGRAM_WEBHOOK_SECRET|DATABASE_URL|REDIS_URL/);
      expect(c, f).not.toMatch(/tws_[A-Za-z0-9_-]{20,}/);
      expect(c, f).not.toMatch(/\b(password|secret|apikey|api_key)\s*[:=]\s*["'][^"']{4,}["']/i);
    }
  });
  it("contains no arithmetic on money: no Number(), parseFloat, parseInt, Math, BigInt or Decimal helpers", () => {
    for (const { f, text } of src) expect(code(text), f).not.toMatch(/\bNumber\s*\(|parseFloat|parseInt|\bMath\.|\bBigInt\b|toFixed|\bDecimal\b/);
  });
  it("the frontend app (if present) imports no backend internal, and browser-side code uses no Node built-in or BFF module", () => {
    const fe = join(ROOT, "frontend");
    if (!existsSync(fe)) return;
    const backend = /@twins\/(database|planning|execution|decision|auth|outcomes|ingestion|agents|risk|paper|kite|backup|config|audit-chain|runtime-state)\b|apps\/api/;
    // Server-only code (the BFF, route handlers, middleware, server components' helpers, tests and e2e) may use Node; anything marked "use client" may not.
    const sources = files(fe).filter((f) => !f.includes("/node_modules/") && !f.includes("/.next/") && !f.includes("/standalone/"));
    for (const f of sources) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(backend);
      if (/^\s*["']use client["']/.test(text)) { expect(text, f).not.toMatch(/from\s+["']node:/); expect(text, f).not.toMatch(/from\s+["']@\/bff\//); }
    }
  });
});
