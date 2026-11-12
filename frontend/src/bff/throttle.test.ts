import { describe, expect, it } from "vitest";
import { WindowCounter, clientKey } from "./throttle";

describe("WindowCounter", () => {
  it("allows up to max hits per window, then refuses; the window then resets", () => {
    let t = 0; const c = new WindowCounter({ max: 3, windowMs: 1000 }, 100, () => t);
    expect([c.hit("a"), c.hit("a"), c.hit("a"), c.hit("a")]).toEqual([true, true, true, false]); expect(c.blocked("a")).toBe(true);
    t = 1001; expect(c.blocked("a")).toBe(false); expect(c.hit("a")).toBe(true);
  });
  it("keys are independent and reset() clears one", () => { const c = new WindowCounter({ max: 1, windowMs: 1000 }); c.hit("a"); c.hit("a"); expect(c.blocked("a")).toBe(true); expect(c.hit("b")).toBe(true); c.reset("a"); expect(c.blocked("a")).toBe(false); });
  it("is bounded: the table never exceeds maxKeys (a flood of distinct keys cannot exhaust memory)", () => { const c = new WindowCounter({ max: 5, windowMs: 60_000 }, 50); for (let i = 0; i < 500; i++) c.hit(`k${i}`); expect(c.size()).toBeLessThanOrEqual(50); });
});
describe("clientKey (trusted proxy header only)", () => {
  const r = (h: Record<string, string>) => new Request("https://x.test/", { headers: h });
  it("uses the rightmost entry of the configured header", () => { expect(clientKey(r({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), "x-forwarded-for")).toBe("203.0.113.9"); });
  it("with no trusted header configured, or a missing/malformed value, everyone shares one bucket", () => { expect(clientKey(r({ "x-forwarded-for": "203.0.113.9" }), null)).toBe("shared"); expect(clientKey(r({}), "x-forwarded-for")).toBe("shared"); expect(clientKey(r({ "x-forwarded-for": "not an ip!!" }), "x-forwarded-for")).toBe("shared"); });
});
