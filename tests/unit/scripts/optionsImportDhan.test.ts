import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadProviderSnapshotMaster, renderOptionsPreview } from "../../../scripts/options-preview";

const dir = mkdtempSync(join(tmpdir(), "dhan-import-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const CSV = "tests/fixtures/options/dhan-detailed.TEST-FIXTURE.csv";
const run = (args: string[]) => spawnSync("npx", ["tsx", "scripts/options-import-dhan.ts", ...args], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" } });

describe("options:import-dhan (local file only)", () => {
  it("imports a local CSV, records provenance and does not enable anything", () => {
    const out = join(dir, "snap.json");
    const r = run(["--csv", CSV, "--source-url", "https://example.invalid/fixture.csv", "--retrieved-at", "2026-10-20T10:00:00Z", "--out", out]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Imported 6 of 11 rows/);
    expect(r.stdout).toMatch(/Not enabled anywhere/);
    const snap = JSON.parse(readFileSync(out, "utf8"));
    expect(snap.source).toMatchObject({ sourceUrl: "https://example.invalid/fixture.csv", retrievedAt: "2026-10-20T10:00:00.000Z", retrievalTimeSource: "owner_supplied" });
    expect(snap.importerVersion).toBe("dhan-importer-v1");
  });
  it("marks a file-time retrieval as an estimate", () => {
    const out = join(dir, "snap2.json");
    expect(run(["--csv", CSV, "--source-url", "https://example.invalid/f.csv", "--out", out]).status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).source.retrievalTimeSource).toBe("file_mtime_estimate");
  });
  it("refuses URLs, missing args, unknown flags and non-https provenance (exit 2/1) without writing", () => {
    expect(run(["--csv", "https://images.dhan.co/x.csv", "--source-url", "https://x"]).status).toBe(2);
    expect(run(["--csv", CSV]).status).toBe(2);
    expect(run(["--bogus"]).status).toBe(2);
    expect(run(["--csv", CSV, "--source-url", "http://x", "--out", join(dir, "n.json")]).status).toBe(1);
  });
  it("preview with --provider-snapshot shows provenance, age and the provider-listed warning", async () => {
    const out = join(dir, "snap3.json");
    run(["--csv", CSV, "--source-url", "https://example.invalid/f.csv", "--retrieved-at", "2026-10-20T10:00:00Z", "--out", out]);
    const t = await renderOptionsPreview("BUY NIFTY 24500 CE 27 OCT 2026 ABOVE 120 SL 90 TGT 150 180", loadProviderSnapshotMaster(out));
    for (const s of ["PROVIDER SNAPSHOT", "PROVIDER-LISTED", "Snapshot age:", "no freshness threshold is defined", "Snapshot SHA-256:", "dhan-importer-v1", "security id 900001", "NOT exchange-independent verification", "approvalPossible:", "false"]) expect(t, s).toContain(s);
    const miss = await renderOptionsPreview("BUY NIFTY 24500 CE 28 OCT 2026 ABOVE 120 SL 90 TGT 150 180", loadProviderSnapshotMaster(out));
    expect(miss).toContain("NOT_FOUND");
  });
});
