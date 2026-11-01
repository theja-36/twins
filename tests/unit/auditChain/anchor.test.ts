import { describe, expect, it } from "vitest";
import { evaluateAnchor, GENESIS_HASH } from "../../../packages/audit-chain/src/index";

const H = (c: string) => c.repeat(64);
const at = (rows: Record<number, string>) => async (i: number) => rows[i] ?? null;
const entry = (index: number, hash: string) => ({ index, hash, verifiedAt: "2026-10-29T14:44:20.312Z" });

describe("evaluateAnchor: empty chains", () => {
  it("an empty-chain anchor (index 0, genesis hash) passes on every run while the chain stays empty - no row lookup is made", async () => {
    let lookups = 0;
    const hashAt = async () => { lookups += 1; return null; };
    for (let run = 0; run < 3; run += 1) expect(await evaluateAnchor("signal_validations", entry(0, GENESIS_HASH), 0, hashAt)).toBeNull();
    expect(lookups).toBe(0);
  });
  it("an empty-chain anchor still passes once the chain has grown (the chain has not moved backwards)", async () => {
    expect(await evaluateAnchor("signal_validations", entry(0, GENESIS_HASH), 7, at({ 1: H("a") }))).toBeNull();
  });
  it("an anchor that pairs index 0 with a real hash, or a real index with the genesis hash, is malformed and FAILS (never skipped)", async () => {
    expect(await evaluateAnchor("c", entry(0, H("a")), 0, at({}))).toMatchObject({ code: "anchor_mismatch", detail: expect.stringContaining("malformed") });
    expect(await evaluateAnchor("c", entry(5, GENESIS_HASH), 5, at({ 5: GENESIS_HASH }))).toMatchObject({ code: "anchor_mismatch", detail: expect.stringContaining("malformed") });
    expect(await evaluateAnchor("c", entry(-1, H("a")), 5, at({}))).toMatchObject({ code: "anchor_mismatch" });
    expect(await evaluateAnchor("c", entry(1.5, H("a")), 5, at({}))).toMatchObject({ code: "anchor_mismatch" });
  });
});

describe("evaluateAnchor: non-empty chains keep full tamper detection", () => {
  it("unchanged anchored row -> pass (also when the chain has grown)", async () => {
    expect(await evaluateAnchor("c", entry(49, H("b")), 49, at({ 49: H("b") }))).toBeNull();
    expect(await evaluateAnchor("c", entry(49, H("b")), 80, at({ 49: H("b") }))).toBeNull();
  });
  it("anchored row deleted -> FAIL (missing row)", async () => {
    expect(await evaluateAnchor("c", entry(49, H("b")), 60, at({}))).toMatchObject({ code: "anchor_mismatch", chain: "c", chainIndex: 49, detail: expect.stringContaining("no longer exists") });
  });
  it("tail removed so the chain is shorter than the anchor -> FAIL, without trusting any lookup", async () => {
    expect(await evaluateAnchor("c", entry(49, H("b")), 40, at({ 49: H("b") }))).toMatchObject({ code: "anchor_mismatch", detail: expect.stringContaining("rows were removed") });
  });
  it("anchored row rewritten -> FAIL (hash differs)", async () => {
    expect(await evaluateAnchor("c", entry(49, H("b")), 49, at({ 49: H("c") }))).toMatchObject({ code: "anchor_mismatch", detail: expect.stringContaining("history was rewritten") });
  });
});
