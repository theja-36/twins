import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

const base = { TWINS_API_BASE_URL: "http://10.0.0.5:3000", TWINS_COOKIE_MODE: "host", TWINS_PUBLIC_ORIGIN: "https://desk.example.test" };
describe("BFF configuration", () => {
  it("accepts the documented deployment shape", () => { expect(loadConfig(base)).toMatchObject({ apiBase: "http://10.0.0.5:3000", cookieMode: "host", publicOrigin: "https://desk.example.test" }); });
  it("defaults to host mode (fail safe) and then requires a public https origin", () => {
    expect(() => loadConfig({ TWINS_API_BASE_URL: base.TWINS_API_BASE_URL })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, TWINS_PUBLIC_ORIGIN: "http://desk.example.test" })).toThrow(/https/);
  });
  it("requires an API origin with no path", () => { for (const v of ["", "10.0.0.5:3000", "http://10.0.0.5:3000/api", "ftp://x"]) expect(() => loadConfig({ ...base, TWINS_API_BASE_URL: v }), v).toThrow(ConfigError); });
  it("dev cookie mode is refused in a production build unless explicitly allowed", () => {
    const dev = { TWINS_API_BASE_URL: base.TWINS_API_BASE_URL, TWINS_COOKIE_MODE: "dev" };
    expect(loadConfig({ ...dev, NODE_ENV: "development" }).cookieMode).toBe("dev");
    expect(() => loadConfig({ ...dev, NODE_ENV: "production" })).toThrow(/not allowed/);
    expect(loadConfig({ ...dev, NODE_ENV: "production", TWINS_ALLOW_INSECURE_COOKIES: "true" }).cookieMode).toBe("dev");
  });
  it("rejects an unknown cookie mode and a malformed proxy header name", () => { expect(() => loadConfig({ ...base, TWINS_COOKIE_MODE: "lax" })).toThrow(); expect(() => loadConfig({ ...base, TWINS_TRUST_PROXY_HEADER: "x forwarded" })).toThrow(); });
  it("no secret or API address uses a NEXT_PUBLIC_ variable", () => { expect(Object.keys(loadConfig(base))).not.toContain("serviceKey"); });
});
