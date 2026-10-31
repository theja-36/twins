import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classify, KiteError, rateClassOf } from "../../../packages/kite/src/index";

const refused = (m: string, p: string): void => { expect(() => classify(m, p)).toThrow(KiteError); };

describe("request allowlist", () => {
  it("allows exactly the read-only market-data GETs", () => {
    for (const p of ["/instruments", "/instruments/NFO", "/instruments/historical/256265/day", "/instruments/historical/256265/15minute", "/quote", "/quote/ltp", "/quote/ohlc"]) expect(classify("GET", p)).toBe("read");
  });
  it("allows account READS as GET only, labelled \"account\"", () => {
    for (const p of ["/user/profile", "/user/margins", "/user/margins/equity", "/portfolio/holdings", "/portfolio/positions", "/orders", "/orders/123456", "/orders/123456/trades", "/trades", "/gtt/triggers", "/gtt/triggers/42"]) expect(classify("GET", p)).toBe("account");
  });
  it("allows POST only for the authentication exchange, and labels it so", () => {
    expect(classify("POST", "/session/token")).toBe("auth");
    for (const p of ["/orders/regular", "/quote", "/instruments", "/gtt/triggers", "/portfolio/positions", "/margins/orders", "/mf/orders"]) refused("POST", p);
  });
  it("refuses every WRITE verb on order, GTT, portfolio, position, holding, margin and trade paths, and every verb on order variants, mutual funds and logout", () => {
    for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const p of ["/orders", "/orders/123", "/orders/regular", "/orders/regular/123", "/trades", "/portfolio/holdings", "/portfolio/holdings/authorise", "/portfolio/positions", "/gtt/triggers", "/gtt/triggers/42", "/user/margins", "/user/margins/equity", "/margins/orders", "/mf/orders", "/mf/holdings", "/session/token/x"]) refused(m, p);
    }
    for (const p of ["/orders/regular", "/orders/regular/123", "/orders/iceberg", "/portfolio/holdings/authorise", "/margins", "/margins/equity", "/mf/orders", "/mf/holdings", "/user/margins/futures", "/gtt/triggers/abc"]) refused("GET", p);
    refused("DELETE", "/session/token");
    refused("PUT", "/session/token");
    refused("GET", "/session/token");
  });
  it("refuses path tricks: traversal, query/fragment/encoding smuggling, double slashes, relative paths, unknown exchanges and intervals", () => {
    for (const p of ["/instruments/../orders", "/quote?x=/orders", "/quote#/orders", "/quote%2Forders", "//orders", "quote", "/instruments//NFO", "/instruments/MCX", "/instruments/historical/abc/day", "/instruments/historical/1/week", "/instruments/historical/1/day/extra", "/quote/ltp/", ""]) refused("GET", p);
  });
  it("classifies rate classes", () => {
    expect([rateClassOf("/quote/ltp"), rateClassOf("/instruments/historical/1/day"), rateClassOf("/instruments")]).toEqual(["quote", "historical", "default"]);
  });
});

describe("no-order guard over the package source", () => {
  const dir = join(process.cwd(), "packages/kite/src");
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);
  it("contains no order/GTT/portfolio/margin endpoint strings outside the allowlist's own refusal", () => {
    for (const [file, text] of sources) {
      const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, file).not.toMatch(/["'`]\/(orders|trades|portfolio|gtt|margins|mf)\b/);
    }
  });
  it("keeps the dependency direction: kite depends on agents, never the reverse", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" || e.name === "dist" ? [] : walk(join(d, e.name))) : e.name.endsWith(".ts") ? [join(d, e.name)] : []));
    const offenders = walk(join(process.cwd(), "packages/agents")).filter((f) => /from "@twins\/kite|packages\/kite/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    expect(JSON.parse(readFileSync(join(process.cwd(), "packages/agents/package.json"), "utf8")).dependencies["@twins/kite"]).toBeUndefined();
  });
  it("uses exactly one non-GET method, in the authentication exchange", () => {
    const all = sources.map(([, t]) => t).join("\n");
    expect([...all.matchAll(/"(POST|PUT|DELETE|PATCH)"/g)].map((m) => m[1])).toEqual(["POST", "POST"]); // allowlist.ts + client.ts exchange
    expect(all).not.toMatch(/placeOrder|modifyOrder|cancelOrder|order_id|transaction_type/i);
  });
});
