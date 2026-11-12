/**
 * The analytics relay schemas against REAL backend output: e2e/fixtures/analytics.sample.json was produced by the real pipeline, execution, ingestion, snapshot and learning-cycle code on PostgreSQL (Stage 09.3B.1 harness).
 * Its figures are synthetic FIXTURE data and are used here only as a TEST-ONLY sample of the response shapes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANALYTICS_RELAY_SCHEMAS, type AnalyticsRouteId } from "./schemas.insights";
import { hasVerifiedSchema, relaySchemaFor } from "./schemas";

const sample = JSON.parse(readFileSync(new URL("../../e2e/fixtures/analytics.sample.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
const ROUTES: Array<[AnalyticsRouteId, string]> = [["analytics.overview", "overview"], ["analytics.strategies", "strategies"], ["analytics.channels", "channels"], ["analytics.independent", "independent"], ["analytics.agents", "agents"], ["analytics.decisions", "decisions"], ["analytics.drift", "drift"], ["analytics.data-quality", "data-quality"], ["analytics.calibration", "calibration"], ["analytics.outcomes", "outcomes"], ["analytics.insights", "insights"]];
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("analytics relay schemas accept real output and keep it exact", () => {
  for (const [id, key] of ROUTES) it(`${id}: parses the real response, wired into the relay, nothing declared is dropped`, () => {
    expect(hasVerifiedSchema(id)).toBe(true); const r = relaySchemaFor(id).safeParse(sample[key]);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues.slice(0, 3))).toBe(true);
    const out = (r as { data: Record<string, unknown> }).data; expect(out["liveStatus"]).toBe("UNAVAILABLE"); expect(out["mode"]).toBe("PAPER"); expect((out["snapshot"] as Record<string, unknown>)["freshness"]).toBeDefined();
  });
  it("decimal strings come out byte-identical, including trailing zeros (never converted to numbers)", () => {
    const o = ANALYTICS_RELAY_SCHEMAS["analytics.outcomes"].parse(sample["outcomes"]).data[0]!; const raw = (sample["outcomes"]!["data"] as Array<Record<string, unknown>>)[0]!;
    for (const k of ["grossPnl", "costs", "netPnl", "rMultiple"] as const) { expect(typeof o[k]).toBe("string"); expect(o[k]).toBe(raw[k]); }
    expect(o.rMultiple).toMatch(/0$/); // "0.66907100": the trailing zeros survive
    const ov = ANALYTICS_RELAY_SCHEMAS["analytics.overview"].parse(sample["overview"]).data.fixtureOnly!; expect(ov.netPnl).toBe((sample["overview"]!["data"] as Record<string, Record<string, unknown>>)["fixtureOnly"]!["netPnl"]);
  });
  it("undeclared fields are stripped at every level; position and decision ids on an outcome row never reach the browser", () => {
    const b = clone(sample["outcomes"]!) as { data: Array<Record<string, unknown>> }; b.data[0]!["secretNote"] = "x"; (b as Record<string, unknown>)["extraTop"] = 1;
    const out = JSON.stringify(ANALYTICS_RELAY_SCHEMAS["analytics.outcomes"].parse(b)); expect(out).not.toMatch(/secretNote|extraTop|paperPositionId|decisionId/);
  });
  it("invalid or incomplete responses are refused, not repaired: a missing snapshot, a numeric money field, a LIVE mode, a bad freshness", () => {
    const base = sample["overview"]!, bad = (f: (x: Record<string, unknown>) => void): boolean => { const x = clone(base) as Record<string, unknown>; f(x); return ANALYTICS_RELAY_SCHEMAS["analytics.overview"].safeParse(x).success; };
    expect(bad(() => undefined)).toBe(true); expect(bad((x) => { delete x["snapshot"]; })).toBe(false); expect(bad((x) => { x["mode"] = "LIVE"; })).toBe(false); expect(bad((x) => { x["liveStatus"] = "AVAILABLE"; })).toBe(false);
    expect(bad((x) => { (x["data"] as Record<string, Record<string, unknown>>)["all"]!["netPnl"] = 12.5; })).toBe(false); expect(bad((x) => { (x["snapshot"] as Record<string, unknown>)["freshness"] = "FRESH"; })).toBe(false);
  });
  it("unknown nested values stay unknown: channel rows and insight provenance pass through as data, a malformed known field is refused", () => {
    const ch = clone(sample["channels"]!) as { data: { channels: unknown[] } }; ch.data.channels = [{ whatever: { nested: true } }]; expect(ANALYTICS_RELAY_SCHEMAS["analytics.channels"].safeParse(ch).success).toBe(true);
    const ins = clone(sample["insights"]!) as { data: Array<Record<string, unknown>> }; ins.data[0]!["recommendation"] = "REDUCE_SIZE"; expect(ANALYTICS_RELAY_SCHEMAS["analytics.insights"].safeParse(ins).success).toBe(false);
  });
  it("narrowed responses (dataset / dimension) are accepted", () => {
    const o = clone(sample["overview"]!) as { data: Record<string, unknown> }; o.data = { fixtureOnly: o.data["fixtureOnly"] }; expect(ANALYTICS_RELAY_SCHEMAS["analytics.overview"].safeParse(o).success).toBe(true);
    const s = clone(sample["strategies"]!) as { data: Record<string, unknown> }; s.data = { byInstrument: s.data["byInstrument"] }; expect(ANALYTICS_RELAY_SCHEMAS["analytics.strategies"].safeParse(s).success).toBe(true);
  });
});
