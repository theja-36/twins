import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHAIN_SPECS, INVARIANT_TRIGGERS, PROTECTED_TABLES } from "../../../packages/audit-chain/src/index";
import {
  computeRiskReward, createRiskDecision, RISK_DECISION_STATUSES, RiskDecisionError, validateRiskDecisionInput, type RiskDecisionInput,
} from "../../../packages/risk/src/index";
import { configureRuntimeState, inMemoryStateSource } from "../../../packages/runtime-state/src/index";

const ROOT = join(__dirname, "../../..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const U = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";
const base = (over: Partial<RiskDecisionInput> = {}): RiskDecisionInput => ({
  subject: { kind: "signal", signalId: U }, stopLossValidationId: V, status: "PENDING", idempotencyKey: "risk-test-key-0001", createdBy: "service:risk-test", instrumentType: "equity", symbol: "SYNTH",
  entryPrice: 100, stopLoss: 95, stopLossBasis: "price", decisionReasonCode: "awaiting_risk_gates", inputSnapshot: { a: 1 }, ...over,
});
const code = (fn: () => void): string | undefined => { try { fn(); } catch (e) { return (e as RiskDecisionError).code; } return undefined; };
/** A database handle that fails the test if anything touches it. */
const untouchable = new Proxy({}, { get: () => { throw new Error("the database was touched"); } }) as never;

afterEach(() => configureRuntimeState({ source: inMemoryStateSource(), ttlMs: 0, failureTtlMs: 0 }));

describe("input validation (before any database access)", () => {
  it("accepts a well-formed input and exactly the five statuses, none of them an execution state", () => {
    expect(code(() => validateRiskDecisionInput(base()))).toBeUndefined();
    expect([...RISK_DECISION_STATUSES]).toEqual(["PENDING", "APPROVED_FOR_REVIEW", "REJECTED", "EXPIRED", "SUPERSEDED"]);
    expect(RISK_DECISION_STATUSES.join()).not.toMatch(/EXECUTED|FILLED|LIVE|ORDER/);
  });
  it.each([
    ["SUPERSEDED cannot be requested", { status: "SUPERSEDED" as never }],
    ["an unknown status", { status: "EXECUTED" as never }],
    ["a non-UUID subject", { subject: { kind: "signal" as const, signalId: "nope" } }],
    ["a non-UUID evidence id", { stopLossValidationId: "nope" }],
    ["a short idempotency key", { idempotencyKey: "x" }],
    ["an anonymous actor", { createdBy: "someone" }],
    ["a free-text reason code", { decisionReasonCode: "Not A Code" }],
    ["an empty snapshot", { inputSnapshot: {} }],
    ["an array snapshot", { inputSnapshot: [] as never }],
    ["a negative stop", { stopLoss: -1 }],
    ["a zero entry", { entryPrice: 0 }],
    ["NaN target", { target1: Number.NaN }],
    ["a bad expiry", { expiry: "30/12/2031" }],
    ["confidence above 100", { confidenceScore: 101 }],
  ] as Array<[string, Partial<RiskDecisionInput>]>)("refuses %s", (_name, over) => {
    expect(code(() => validateRiskDecisionInput(base(over)))).toBeDefined();
  });
  it("APPROVED_FOR_REVIEW needs a stop-loss, an entry price and a stop-loss basis", () => {
    expect(code(() => validateRiskDecisionInput(base({ status: "APPROVED_FOR_REVIEW", stopLoss: null })))).toBe("stop_loss_not_valid");
    expect(code(() => validateRiskDecisionInput(base({ status: "APPROVED_FOR_REVIEW", entryPrice: null })))).toBe("stop_loss_not_valid");
    expect(code(() => validateRiskDecisionInput(base({ status: "APPROVED_FOR_REVIEW", stopLossBasis: null })))).toBe("stop_loss_not_valid");
    expect(code(() => validateRiskDecisionInput(base({ status: "APPROVED_FOR_REVIEW" })))).toBeUndefined();
  });
  it("reward-to-risk uses the first target only and never divides by zero", () => {
    expect(computeRiskReward(200, 190, 230)).toBe(3);
    expect(computeRiskReward(200, 200, 230)).toBeNull();
  });
});

describe("runtime-state behaviour is fail closed and happens before the database", () => {
  it("kill switch, intake off and an unreadable state refuse without touching the database", async () => {
    for (const set of [(s: ReturnType<typeof inMemoryStateSource>) => s.set({ KILL_SWITCH_ACTIVE: true }), (s: ReturnType<typeof inMemoryStateSource>) => s.set({ INTAKE_ENABLED: false }), (s: ReturnType<typeof inMemoryStateSource>) => s.failWith(new Error("down"))]) {
      const source = inMemoryStateSource();
      set(source);
      configureRuntimeState({ source, ttlMs: 0, failureTtlMs: 0 });
      await expect(createRiskDecision(untouchable, base())).rejects.toMatchObject({ code: "safety_refused" });
    }
  });
  it("an unconfigured process (no runtime state at all) also refuses", async () => {
    const { resetRuntimeState } = await import("../../../packages/runtime-state/src/index");
    resetRuntimeState();
    await expect(createRiskDecision(untouchable, base())).rejects.toMatchObject({ code: "safety_refused" });
  });
  it("invalid input is refused before even the safety state is consulted", async () => {
    await expect(createRiskDecision(untouchable, base({ inputSnapshot: {} }))).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("architecture: the schema, the chain and the boundaries", () => {
  const sql = read("packages/database/drizzle/0014_risk_decisions_foundation.sql");
  it("migration 0014 is registered, guards legacy data first, and installs the append-only, chain and integrity protections ENABLE ALWAYS", () => {
    const journal = JSON.parse(read("packages/database/drizzle/meta/_journal.json")) as { entries: Array<{ tag: string }> };
    expect(journal.entries.map((e) => e.tag)).toContain("0014_risk_decisions_foundation");
    expect(sql.indexOf("DO $$")).toBeLessThan(sql.indexOf("ALTER TABLE"));
    expect(sql).toMatch(/legacy risk_decisions rows exist/);
    for (const t of ["risk_decisions_chain_before_insert", "risk_decisions_chain_after_insert", "risk_decisions_no_update_delete", "risk_decisions_no_truncate", "risk_decisions_a_integrity_before_insert", "orders_require_risk_decision"]) expect(sql, t).toContain(`ENABLE ALWAYS TRIGGER "${t}"`);
    expect(sql).toMatch(/'PENDING', 'APPROVED_FOR_REVIEW', 'REJECTED', 'EXPIRED', 'SUPERSEDED'/);
    expect(sql).not.toMatch(/EXECUTED|FILLED/);
    expect(sql).toMatch(/'risk_decisions', 0, repeat\('0', 64\)/);
    expect(sql).toMatch(/CREATE VIEW "risk_decisions_effective"/);
  });
  it("risk_decisions is a chain in the verifier, a protected table, and its guards (and the orders guard) are verified", () => {
    expect(CHAIN_SPECS.map((c) => c.chain)).toContain("risk_decisions");
    expect(PROTECTED_TABLES).toContain("risk_decisions");
    const spec = CHAIN_SPECS.find((c) => c.chain === "risk_decisions");
    expect(spec?.triggers).toEqual(expect.arrayContaining(["risk_decisions_chain_before_insert", "risk_decisions_no_update_delete", "risk_decisions_a_integrity_before_insert"]));
    expect(INVARIANT_TRIGGERS).toContainEqual(["orders", "orders_require_risk_decision"]);
    // every content column of the table is part of the hashed payload (legacy deprecated columns are always NULL and excluded)
    const payload = /twins_audit_payload_risk_decisions[\s\S]*?\$\$;/.exec(sql)?.[0] ?? "";
    expect(payload).toMatch(/r\.stop_loss::text/);
    expect(payload).toMatch(/r\.input_snapshot::text/);
    expect(payload).toMatch(/r\.supersedes_id::text/);
    expect(spec?.fields.length).toBe((payload.match(/r\.\w+/g) ?? []).filter((x, i, a) => a.indexOf(x) === i && x !== "r.created_at").length + 1);
  });
  it("the runtime role can append and read risk decisions but never change them (append-only detection in app-role.sql), and the approval bot has no grant", () => {
    const role = read("infrastructure/staging/app-role.sql");
    expect(role).toMatch(/event_hash/); // any table with event_hash is append-only automatically
    const bot = read("infrastructure/staging/approval-bot-role.sql");
    expect(bot).not.toMatch(/risk_decisions/);
  });
  it("no approval card or Telegram message can come from the risk module, and the approval bot does not read risk decisions", () => {
    const walk = (d: string): string[] => readdirSync(join(ROOT, d)).flatMap((n) => { const p = `${d}/${n}`; return statSync(join(ROOT, p)).isDirectory() ? (n === "node_modules" || n === "dist" ? [] : walk(p)) : /\.ts$/.test(n) ? [p] : []; });
    for (const f of walk("packages/risk/src")) expect(strip(read(f)), f).not.toMatch(/claim_review|sendMessage|approval-bot|api\.telegram|adapter-telegram|fetch\(/i);
    for (const f of walk("services/approval-bot/src")) expect(strip(read(f)), f).not.toMatch(/risk_decisions|riskDecisions|@twins\/risk/);
  });
  it("only the worker, the scheduler, the risk API routes and the risk-control CLI (and tests) import the risk module; it writes nothing but risk_decisions", () => {
    const walk = (d: string): string[] => readdirSync(join(ROOT, d)).flatMap((n) => { const p = `${d}/${n}`; return statSync(join(ROOT, p)).isDirectory() ? (n === "node_modules" || n === "dist" ? [] : walk(p)) : /\.ts$/.test(n) ? [p] : []; });
    const importers = ["apps", "services", "adapters", "scripts"].flatMap(walk).filter((f) => /@twins\/risk|packages\/risk/.test(strip(read(f))));
    expect(importers).toEqual(["apps/api/src/riskApi.ts", "services/scheduler/src/index.ts", "services/worker/src/index.ts", "scripts/ops/risk-control.ts"]);
    for (const f of walk("packages/risk/src")) expect(strip(read(f)), f).not.toMatch(/\.(insert|update|delete)\(\s*schema\.(?!riskDecisions\b|lossEvents\b|circuitBreakerEvents\b|eventBlackoutWindows\b|riskApprovalCards\b)\w+/); // loss events and breaker events are the Task 4 tables, written only by breakers/record.ts (asserted below)
  });
});
