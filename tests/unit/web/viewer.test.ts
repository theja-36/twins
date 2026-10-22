import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createViewerServer, ViewerConfigError } from "../../../apps/web/src/server";
import { buildView, STORED_BANNER } from "../../../apps/web/src/view";
import { PAGE_HTML, PAGE_JS } from "../../../apps/web/src/page";

const ID = "11111111-2222-3333-4444-555555555555";
const TOKEN = "SECRET-TOKEN-xyz-98765";

const claim = {
  action: "buy", intent: "long_entry_presumed", underlying: "SENSEX", underlyingAliasUsed: false, strike: 72500, optionType: "CE", optionTypeConflict: false,
  compactCodeUnrecognized: false, expiry: { status: "day_month", day: 8, month: 10, raw: "08 OCTOBER" }, entry: { type: "above", price: 530 }, stopLoss: 400,
  targets: [580, 800], levelBasis: "unspecified", levelBasisConflict: false, impliedUnderlyingView: "bullish",
};
const reasons = [
  { code: "expiry.year_missing", severity: "insufficient", description: "day and month were stated without a year; the year is not inferred" },
  { code: "level_basis.unspecified", severity: "insufficient", description: "the message does not say whether the levels are option-premium or underlying levels" },
];
const prov = { contractMaster: { configured: false }, premiumProvider: { configured: false }, note: "Only the master/provider actually used are recorded." };
const claimRow = (over: Record<string, unknown> = {}) => ({
  id: "c1", parserVersion: "telegram-regex-v2", resultKind: "claim", claim, detail: null, assessmentOutcome: "INSUFFICIENT_EVIDENCE", reasons,
  verification: { status: "not_attempted", reason: "the claim does not yet name a complete contract" }, premium: { status: "not_attempted", reason: "no FOUND contract" },
  provenance: prov, approvalPossible: false, createdAt: "2026-10-20T10:49:16.222Z", ...over,
});
const apiBody = (claims: unknown[], extra: Record<string, unknown> = {}) => ({ messageId: ID, versionCount: claims.length, selectedParserVersion: null, notice: "Unverified options claim records: not signals, not approvals.", claims, ...extra });

const firstVersion = (body: unknown) => {
  const v = buildView(body).versions[0];
  if (!v) throw new Error("no version in view");
  return v;
};

describe("view model (stored result only)", () => {
  it("claim: contract, entry condition, basis, SL, ORDERED targets, reasons, provenance, non-approval banner", () => {
    const v = firstVersion(apiBody([claimRow()]));
    const text = JSON.stringify(v);
    expect(v).toMatchObject({ parserVersion: "telegram-regex-v2", kind: "claim", kindLabel: "CLAIM (unverified)", banner: STORED_BANNER, approvalPossible: false });
    expect(STORED_BANNER).toBe("Stored assessment — not an order");
    for (const s of ["SENSEX", "72500", "CE", "day 8, month 10 - year NOT stated", "above 530 (a trigger condition, not a fill)", "UNSPECIFIED (values kept, not interpreted)", "580, 800", "400", "INSUFFICIENT_EVIDENCE", "approvalPossible"]) expect(text, s).toContain(s);
    expect(v.reasons).toEqual(reasons.map((r) => ({ ...r })));
    expect(text).toContain("none configured at the time");
  });

  it("ambiguous and unsupported records stay what they are: no claim table, no invented fields", () => {
    const amb = firstVersion(apiBody([claimRow({ resultKind: "ambiguous", claim: null, detail: { directives: [{ direction: "buy", symbol: "NIFTY 24500 CE" }, { direction: "sell", symbol: "BANKNIFTY 52000 PE" }] }, assessmentOutcome: null, verification: null, premium: null, reasons: [{ code: "directives.ambiguous", severity: "insufficient", description: "several distinct directives" }] })]));
    expect(amb.kind).toBe("ambiguous");
    expect(JSON.stringify(amb)).toContain("no complete claim was recorded");
    expect(JSON.stringify(amb)).toContain("BUY NIFTY 24500 CE");
    expect(JSON.stringify(amb)).not.toMatch(/Parsed claim|Strike|Targets/);
    expect(JSON.stringify(amb)).toContain("not assessed (no complete claim)");
    const uns = firstVersion(apiBody([claimRow({ resultKind: "unsupported", claim: null, detail: { symbol: "NIFTYBANK", form: "spaced_strike_type" }, assessmentOutcome: null, verification: null, premium: null, reasons: [] })]));
    expect(uns.kind).toBe("unsupported");
    expect(JSON.stringify(uns)).toContain("NIFTYBANK");
    expect(JSON.stringify(uns)).toContain("not mapped, corrected or guessed");
    expect(JSON.stringify(uns)).not.toMatch(/Parsed claim|Strike/);
  });

  it("every parser version is its own clearly separated entry (none merged or chosen)", () => {
    const view = buildView(apiBody([claimRow({ parserVersion: "telegram-regex-v1", resultKind: "unsupported", claim: null, detail: { symbol: "NIFTY", form: "legacy" }, assessmentOutcome: null, verification: null, premium: null }), claimRow()]));
    expect(view.versionCount).toBe(2);
    expect(view.versions.map((x) => x.parserVersion)).toEqual(["telegram-regex-v1", "telegram-regex-v2"]);
    expect(view.versions.map((x) => x.kind)).toEqual(["unsupported", "claim"]);
  });

  it("manual / synthetic provenance produces explicit warnings, and found contracts show lot size from the reference only", () => {
    const manual = claimRow({
      verification: { status: "verified", masterName: "m", testFixture: false, contract: { contractId: "MANUAL-001", expiryDate: "2026-10-26", lotSize: 65, verifiedAsOf: "2026-10-20", entrySource: "Dhan screenshot", notes: "transcribed; not exchange-verified" } },
      provenance: { contractMaster: { configured: true, name: "manual-reference:manual-reference-v1", isTestFixture: false, reference: { kind: "manual_verified", version: "manual-reference-v1", source: "MANUAL VERIFIED REFERENCE", synthetic: false, entryCount: 1 } }, premiumProvider: { configured: false } },
    });
    const m = firstVersion(apiBody([manual]));
    expect(m.warnings.join(" ")).toMatch(/Manual local reference: not live entitlement and it does not prove current tradability/);
    expect(JSON.stringify(m)).toContain("lot size 65 (lot size comes only from the reference)");
    expect(JSON.stringify(m)).toContain("FOUND");
    const synth = firstVersion(apiBody([claimRow({ provenance: { contractMaster: { configured: true, name: "local-reference:sample", isTestFixture: false, reference: { kind: "synthetic_sample", version: "sample-reference-v1", source: "SYNTHETIC SAMPLE", synthetic: true } }, premiumProvider: { configured: true, name: "sample-premium:v1", source: { synthetic: true } } } })]));
    expect(synth.warnings.join(" ")).toMatch(/SYNTHETIC SAMPLE reference/);
    expect(synth.warnings.join(" ")).toMatch(/SYNTHETIC SAMPLE premium data: not live market data/);
  });

  it("rejects an unexpected API shape instead of guessing", () => {
    expect(() => buildView({ nope: true })).toThrow();
    expect(() => buildView(null)).toThrow();
  });
});

describe("static page assets", () => {
  it("embed no token, use no browser storage, no innerHTML, and no URL-carried secret", () => {
    for (const asset of [PAGE_HTML, PAGE_JS]) {
      expect(asset).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/);
    }
    expect(PAGE_JS).toContain("Authorization");
    expect(PAGE_JS).not.toMatch(/\?token=|[?&]token/);
    expect(PAGE_HTML).toContain('type="password"');
    expect(PAGE_HTML).not.toMatch(/<script>[^<]/); // no inline script (CSP forbids it)
  });
});

describe("viewer server", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()?.();
  });

  async function fakeApi(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const server = http.createServer((req, res) => {
      calls.push({ url: req.url ?? "", authorization: req.headers.authorization });
      handler(req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise((r) => server.close(() => r())));
    return { calls, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  }
  const okApi = () =>
    fakeApi((req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Unauthorized" })); }
      if (req.url?.startsWith("/options-claims/00000000")) { res.writeHead(404); return res.end("{}"); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(apiBody([claimRow()])));
    });
  async function start(apiBase: string) {
    const lines: string[] = [];
    const v = createViewerServer({ apiBase, port: 0, log: (l) => lines.push(l) });
    const bound = await v.listen();
    closers.push(() => new Promise((r) => v.server.close(() => r())));
    const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: bound.port, path, method, headers: { host: `127.0.0.1:${bound.port}`, ...headers } }, (res) => {
          let b = "";
          res.on("data", (c: Buffer) => (b += c.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
        });
        req.on("error", reject);
        req.end();
      });
    return { get, lines, bound };
  }

  it("binds to loopback only and refuses non-loopback host or API base", () => {
    expect(() => createViewerServer({ host: "0.0.0.0" })).toThrow(ViewerConfigError);
    expect(() => createViewerServer({ host: "192.168.1.5" })).toThrow(ViewerConfigError);
    expect(() => createViewerServer({ apiBase: "http://api.example.com:4010" })).toThrow(ViewerConfigError);
    expect(() => createViewerServer({ apiBase: "https://127.0.0.1:4010" })).toThrow(ViewerConfigError);
  });

  it("serves the page on 127.0.0.1 with hardening headers and NO CORS headers", async () => {
    const api = await okApi();
    const v = await start(api.base);
    expect(v.bound.host).toBe("127.0.0.1");
    for (const path of ["/", "/app.js", "/app.css"]) {
      const r = await v.get(path);
      expect(r.status, path).toBe(200);
      expect(r.headers["access-control-allow-origin"], path).toBeUndefined();
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(r.headers["content-security-policy"]).toContain("connect-src 'self'");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.body).not.toContain(TOKEN);
    }
    expect((await v.get("/", {}, "OPTIONS")).status).toBe(405);
    expect((await v.get("/", {}, "POST")).status).toBe(405);
    expect((await v.get("/nope")).status).toBe(404);
  });

  it("forwards the bearer token to the API, returns the stored view, and never echoes or logs the token", async () => {
    const api = await okApi();
    const v = await start(api.base);
    const r = await v.get(`/view/options-claims/${ID}`, { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { versionCount: number; versions: Array<{ banner: string; approvalPossible: boolean }> };
    expect(body.versions[0]).toMatchObject({ banner: "Stored assessment — not an order", approvalPossible: false });
    expect(api.calls).toEqual([{ url: `/options-claims/${ID}`, authorization: `Bearer ${TOKEN}` }]);
    expect(r.body).not.toContain(TOKEN);
    expect(JSON.stringify(r.headers)).not.toContain(TOKEN);
    expect(v.lines.join("\n")).not.toContain(TOKEN);
    expect(v.lines.join("\n")).not.toMatch(/authorization|bearer/i);
    expect(v.lines[0]).toBe(`GET /view/options-claims/${ID} -> 200`);
  });

  it("passes only a validated parserVersion filter; a token in the query string is ignored and never forwarded", async () => {
    const api = await okApi();
    const v = await start(api.base);
    await v.get(`/view/options-claims/${ID}?parserVersion=telegram-regex-v2&token=${TOKEN}`, { authorization: `Bearer ${TOKEN}` });
    expect(api.calls[0]?.url).toBe(`/options-claims/${ID}?parserVersion=telegram-regex-v2`);
    expect(api.calls[0]?.url).not.toContain(TOKEN);
    expect(v.lines.join("\n")).not.toContain(TOKEN);
    const bad = await v.get(`/view/options-claims/${ID}?parserVersion=${encodeURIComponent("<script>")}`, { authorization: `Bearer ${TOKEN}` });
    expect(bad.status).toBe(400);
    expect(api.calls).toHaveLength(1); // not forwarded
  });

  it("unauthorized (no token / wrong token), invalid id, not found, and API errors are clear and secret-free", async () => {
    const api = await okApi();
    const v = await start(api.base);
    const none = await v.get(`/view/options-claims/${ID}`);
    expect(none.status).toBe(401);
    expect(JSON.parse(none.body).error).toMatchObject({ kind: "unauthorized" });
    const wrong = await v.get(`/view/options-claims/${ID}`, { authorization: "Bearer wrong-token-value" });
    expect(wrong.status).toBe(401);
    expect(wrong.body).not.toContain("wrong-token-value");
    const calls = api.calls.length;
    const bad = await v.get("/view/options-claims/not-a-uuid", { authorization: `Bearer ${TOKEN}` });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error.kind).toBe("invalid_id");
    expect(api.calls.length).toBe(calls); // an invalid id never reaches the API
    const missing = await v.get("/view/options-claims/00000000-0000-0000-0000-000000000000", { authorization: `Bearer ${TOKEN}` });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).error.kind).toBe("not_found");
    const broken = await fakeApi((_req, res) => { res.writeHead(500); res.end("secret internal detail"); });
    const vb = await start(broken.base);
    const r500 = await vb.get(`/view/options-claims/${ID}`, { authorization: `Bearer ${TOKEN}` });
    expect(r500.status).toBe(502);
    expect(r500.body).not.toContain("secret internal detail");
    const garbage = await fakeApi((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"nope":1}'); });
    const vg = await start(garbage.base);
    expect((await vg.get(`/view/options-claims/${ID}`, { authorization: `Bearer ${TOKEN}` })).status).toBe(502);
  });

  it("API unavailable: a clear 502 api_unavailable, no secret", async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
    const port = (dead.address() as { port: number }).port;
    await new Promise<void>((r) => dead.close(() => r())); // now closed: connection refused
    const v = await start(`http://127.0.0.1:${port}`);
    const r = await v.get(`/view/options-claims/${ID}`, { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body).error.kind).toBe("api_unavailable");
    expect(r.body).not.toContain(TOKEN);
    expect(r.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });

  it("rejects a foreign Host header (DNS-rebinding defence)", async () => {
    const api = await okApi();
    const v = await start(api.base);
    const r = await v.get("/", { host: "evil.example" });
    expect(r.status).toBe(403);
    expect(api.calls).toHaveLength(0);
  });
});
