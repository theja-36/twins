import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Static checks of the hosted CI workflow (no YAML parser is a dependency of this repository, so these are text checks with a precise scope). */
const text = readFileSync(".github/workflows/ci.yml", "utf8");
const job = (name: string): string => {
  const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`).exec(text);
  if (!m) throw new Error(`job ${name} not found`);
  return m[1] ?? "";
};
const indexIn = (haystack: string, needle: string): number => {
  const i = haystack.indexOf(needle);
  if (i < 0) throw new Error(`"${needle}" not found`);
  return i;
};

describe("hosted CI workflow", () => {
  it("runs on every push (except dependabot branches, which get their pull_request run) and every pull request, with read-only permissions", () => {
    expect(text).toMatch(/\non:\n  push:\n    branches-ignore: \["dependabot\/\*\*"\]\n  pull_request:\n/);
    expect(text).toMatch(/\npermissions:\n  contents: read\n/);
    expect(text).toMatch(/concurrency:\n  group: ci-\$\{\{ github.workflow \}\}-\$\{\{ github.ref \}\}\n  cancel-in-progress: true/);
  });
  it("has the required jobs and one gate that needs all of them", () => {
    for (const j of ["static", "unit", "integration", "crash-recovery", "ci-gate"]) expect(job(j).length, j).toBeGreaterThan(20);
    expect(job("ci-gate")).toContain("needs: [static, unit, integration, crash-recovery]");
    expect(job("ci-gate")).toContain("if: always()");
    expect(job("ci-gate")).toMatch(/!= "success"/);
  });
  it("pins Node (22 via .nvmrc, matrix 20 and 22 for the engines range), caches npm, installs with npm ci, and does not persist the checkout credentials", () => {
    expect(readFileSync(".nvmrc", "utf8").trim()).toBe("22");
    expect(readFileSync("package.json", "utf8")).toMatch(/"node": ">=20"/);
    expect(text).toMatch(/node-version-file: \.nvmrc/);
    expect(job("unit")).toContain("node: [20, 22]");
    expect(job("integration")).toContain("node: [20, 22]");
    for (const j of ["static", "unit", "integration", "crash-recovery"]) {
      const b = job(j);
      expect(b, j).toContain("cache: npm");
      expect(b, j).toContain("run: npm ci");
      expect(b, j).toContain("persist-credentials: false");
      expect(b, j).not.toMatch(/npm install\b/);
    }
  });
  it("static job: secret scan, lint, typecheck and workspace builds, in that order", () => {
    const b = job("static");
    const order = ["npm run scan:secrets", "npm run lint", "npm run typecheck", "npm run build --workspaces"].map((s) => indexIn(b, s));
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
  it("integration job: disposable Postgres 16 and Redis 7 with health checks, then guard -> migrate -> verify migrations -> integration -> audit verification", () => {
    const b = job("integration");
    expect(b).toContain("image: postgres:16-alpine");
    expect(b).toContain("image: redis:7-alpine");
    expect(b).toContain("--health-cmd \"pg_isready -U twins_ci -d twins_ci\"");
    expect(b).toContain("--health-cmd \"redis-cli ping\"");
    const order = ["ciGuard.test.ts", "npm run db:migrate", "verify-migrations.mjs", "npm run test:integration", "npm run audit:verify"].map((s) => indexIn(b, s));
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(b).toContain("--require-ddl-watch");
    expect(b).toContain('exit "${PIPESTATUS[0]}"'); // a failing verifier must fail the job even though its output is tee'd
  });
  it("crash-recovery job maps Redis to the port the test's child worker insists on and enables the opt-in test", () => {
    const b = job("crash-recovery");
    expect(b).toContain('ports: ["16379:6379"]');
    expect(b).toContain("REDIS_URL: redis://127.0.0.1:16379");
    expect(b).toContain('TWINS_CRASH_TEST: "1"');
    expect(b).toContain("crashRecovery.test.ts");
  });
  it("uploads reports and logs only when something failed", () => {
    for (const j of ["unit", "integration", "crash-recovery"]) {
      const b = job(j);
      expect(b, j).toMatch(/if: failure\(\)\n\s+uses: actions\/upload-artifact@v4/);
    }
  });
  it("uses no repository secrets, no pull_request_target and no write permissions; every credential in the file is the documented throwaway CI value", () => {
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/pull_request_target/);
    expect(text).not.toMatch(/(contents|packages|id-token|pull-requests): write/);
    expect(text).toMatch(/LIVE_TRADING: "false"/);
    const passwords = [...text.matchAll(/POSTGRES_PASSWORD: (\S+)/g)].map((m) => m[1]);
    expect(new Set(passwords)).toEqual(new Set(["ci_only_not_a_secret"]));
  });
});
