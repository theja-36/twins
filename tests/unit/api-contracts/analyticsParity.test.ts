/** Analytics contracts: constants and the response composition `{ ...envelope, snapshot, freshness, state }` equal the backend's. */
import { describe, expect, it } from "vitest";
import { ANALYTICS_CONTRACT_VERSION as B_VERSION, PAPER_NOTICE } from "../../../packages/outcomes/src/index";
import { ANALYTICS_CONTRACT_VERSION, ANALYTICS_NOTICE, ANALYTICS_ROUTES, ANALYTICS_RESPONSE_STATES, FRESHNESS, LIVE_STATUS_UNAVAILABLE, PAPER_MODE, type SnapshotMetaView } from "../../../packages/api-contracts/src/index";
import { build } from "../../support/contractHarness";

const ENVELOPE_KEYS = ["contractVersion", "data", "dataset", "generatedAt", "liveStatus", "mode", "notice"];
const META_KEYS = ["freshness", "snapshot", "state"];
const SNAPSHOT_KEYS: Array<keyof SnapshotMetaView> = ["id", "asOf", "createdAt", "verifiedAt", "evidenceHash", "inputHash", "configHash", "algorithmVersions", "createdBy", "freshness", "staleReason", "complete", "maxAgeSeconds"];

describe("analytics response envelope", () => {
  it("version and notice constants equal the outcomes package", () => { expect(ANALYTICS_CONTRACT_VERSION).toBe(B_VERSION); expect(ANALYTICS_NOTICE).toBe(PAPER_NOTICE); });
  it("every one of the 11 endpoints returns the envelope keys PLUS snapshot, freshness and state at the top level", async () => {
    const h = await build(), t = await h.trader();
    for (const e of ANALYTICS_ROUTES) {
      const res = await h.call("GET", e.path, t.token); expect(res.statusCode, e.path).toBe(200);
      const b = res.json() as Record<string, unknown>;
      expect(Object.keys(b).sort(), e.path).toEqual([...ENVELOPE_KEYS, ...META_KEYS].sort());
      expect(b["contractVersion"]).toBe(ANALYTICS_CONTRACT_VERSION); expect(b["dataset"]).toBe(PAPER_MODE); expect(b["mode"]).toBe(PAPER_MODE); expect(b["liveStatus"]).toBe(LIVE_STATUS_UNAVAILABLE); expect(b["notice"]).toBe(ANALYTICS_NOTICE);
      expect(Object.keys(b["snapshot"] as object).sort(), e.path).toEqual([...SNAPSHOT_KEYS].sort());
      expect(b["freshness"]).toBe((b["snapshot"] as SnapshotMetaView).freshness);
    }
  });
  it("freshness is CURRENT or STALE, and a stale snapshot is served as STALE with its reason, never as current", async () => {
    const h = await build({ stale: true }), t = await h.trader(), b = (await h.call("GET", "/analytics/overview", t.token)).json() as { freshness: string; snapshot: SnapshotMetaView };
    expect(FRESHNESS).toContain(b.freshness); expect(b.freshness).toBe("STALE"); expect(b.snapshot.staleReason).toEqual(expect.any(String));
    const c = await build(), t2 = await c.trader(), b2 = (await c.call("GET", "/analytics/overview", t2.token)).json() as { freshness: string; snapshot: SnapshotMetaView }; expect(b2.freshness).toBe("CURRENT"); expect(b2.snapshot.staleReason).toBeNull();
  });
  it("state is EMPTY with no records, PARTIAL when some are partial, otherwise OK", async () => {
    for (const [o, want] of [[{ records: 0 }, "EMPTY"], [{ records: 3, partial: 1 }, "PARTIAL"], [{ records: 3, partial: 0 }, "OK"]] as const) {
      const h = await build(o), t = await h.trader(), b = (await h.call("GET", "/analytics/overview", t.token)).json() as { state: string };
      expect(ANALYTICS_RESPONSE_STATES).toContain(b.state); expect(b.state).toBe(want);
    }
  });
  it("no analytics response ever reports a LIVE source: liveStatus is UNAVAILABLE and mode is PAPER on all 11", async () => {
    const h = await build(), t = await h.trader();
    for (const e of ANALYTICS_ROUTES) { const b = (await h.call("GET", e.path, t.token)).json() as Record<string, unknown>; expect(b["liveStatus"], e.path).toBe("UNAVAILABLE"); expect(JSON.stringify(b)).not.toMatch(/"liveStatus":"(LIVE|AVAILABLE)"/); }
  });
});
