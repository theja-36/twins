/** The research relay schemas against REAL output of the real orchestrator and handlers (e2e/fixtures/research.sample.json, synthetic FIXTURE candidates, test-only). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_REPORT_KEYS, RESEARCH_PACKAGE_BODY_KEYS } from "@twins/api-contracts";
import { AgentRegistryRelay, ResearchBody, ResearchPackageAbsent, ResearchPackageRelay } from "./schemas.research";
import { hasVerifiedSchema, relaySchemaFor } from "./schemas";

const sample = JSON.parse(readFileSync(new URL("../../e2e/fixtures/research.sample.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const body = (o: Record<string, unknown>) => o["package"] as Record<string, unknown> & { reports: Array<Record<string, unknown>> };

describe("research relay schemas", () => {
  it("all three routes have a verified (non pass-through) schema in the relay", () => { for (const id of ["research.package", "research.packageById", "research.agents"]) expect(hasVerifiedSchema(id), id).toBe(true); });
  it("accepts the real package for an equity and an option candidate, and by id; the body declares exactly the verified keys (optionsRisk is not declared)", () => {
    for (const k of ["packageIndependentEquity", "packageTelegramOption", "packageById"]) { const r = relaySchemaFor(k === "packageById" ? "research.packageById" : "research.package").safeParse(sample[k]); expect(r.success, `${k}: ${r.success ? "" : JSON.stringify(r.error.issues.slice(0, 2))}`).toBe(true); }
    expect(Object.keys(ResearchBody.shape).sort()).toEqual([...RESEARCH_PACKAGE_BODY_KEYS, "asOf"].sort()); expect(Object.keys(ResearchBody.shape.reports.element.shape).sort()).toEqual([...AGENT_REPORT_KEYS, "supplementsRoles"].sort());
  });
  it("the option package's optionsRisk context never reaches the browser (unverified structure); everything verified is preserved", () => {
    expect("optionsRisk" in body(sample["packageTelegramOption"]!)).toBe(true); const out = ResearchPackageRelay.parse(sample["packageTelegramOption"]) as { package: Record<string, unknown> };
    expect("optionsRisk" in out.package).toBe(false); expect(JSON.stringify(out)).not.toMatch(/options-risk-mapping|MAPPED_UNVERIFIED|GREEKS_NOT_SUPPLIED/);
    const raw = body(sample["packageTelegramOption"]!); expect(out.package["reports"]).toEqual(raw.reports); expect(out.package["packageSha256"]).toBe(raw["packageSha256"]); expect(out.package["evidenceIndex"]).toEqual(raw["evidenceIndex"]);
  });
  it("grantsApproval must be the literal false: a package that grants approval is refused outright", () => {
    const bad = clone(sample["packageIndependentEquity"]!); body(bad)["grantsApproval"] = true; expect(ResearchPackageRelay.safeParse(bad).success).toBe(false);
  });
  it("undeclared fields are stripped at every level (envelope, package, report)", () => {
    const x = clone(sample["packageIndependentEquity"]!); (x as Record<string, unknown>)["leak"] = 1; body(x)["secret"] = "s"; body(x).reports[0]!["rawPrompt"] = "p"; const out = JSON.stringify(ResearchPackageRelay.parse(x)); expect(out).not.toMatch(/leak|secret|rawPrompt/);
  });
  it("a verdict outside the verified vocabulary, a numeric-string confidence or a missing report field is refused, not repaired", () => {
    for (const mut of [(b: ReturnType<typeof body>) => { b.reports[0]!["verdict"] = "APPROVED"; }, (b: ReturnType<typeof body>) => { b.reports[0]!["confidence"] = "70"; }, (b: ReturnType<typeof body>) => { delete b.reports[0]!["errorCode"]; }, (b: ReturnType<typeof body>) => { b["packageSha256"] = "not-a-hash"; }]) {
      const x = clone(sample["packageIndependentEquity"]!); mut(body(x)); expect(ResearchPackageRelay.safeParse(x).success).toBe(false);
    }
  });
  it("a package whose asOf is absent (old packages) is accepted and stays absent, never invented", () => {
    const x = clone(sample["packageIndependentEquity"]!); delete body(x)["asOf"]; const out = ResearchPackageRelay.parse(x) as { package: Record<string, unknown> }; expect("asOf" in out.package).toBe(false);
  });
  it("the no-package answer is accepted with its note and null package", () => {
    const a = { candidateId: "00000000-0000-4000-8000-000000000007", status: "PENDING", researchAttempts: 0, package: null, note: "No research package has been stored for this candidate; nothing is inferred." };
    expect(ResearchPackageAbsent.safeParse(a).success).toBe(true); expect(ResearchPackageRelay.parse(a)).toEqual(a); expect(ResearchPackageRelay.safeParse({ ...a, package: {} }).success).toBe(false);
  });
  it("the agent registry parses (13 agents, 12 roles), keeps the metadata exactly, and refuses a malformed row", () => {
    const r = AgentRegistryRelay.parse(sample["agents"]); expect(r.agents).toHaveLength(13); expect(r.roles).toHaveLength(12); expect(r.agents).toEqual((sample["agents"] as unknown as { agents: unknown[] }).agents); expect(r.extraSpecialists).toEqual(["options-risk-v1"]);
    const bad = clone(sample["agents"]!) as { agents: Array<Record<string, unknown>> }; bad.agents[0]!["weight"] = "50"; expect(AgentRegistryRelay.safeParse(bad).success).toBe(false);
    const extra = clone(sample["agents"]!) as { agents: Array<Record<string, unknown>> }; extra.agents[0]!["apiKey"] = "k"; expect(JSON.stringify(AgentRegistryRelay.parse(extra))).not.toMatch(/apiKey/);
  });
});
