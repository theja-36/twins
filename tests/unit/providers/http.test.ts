import { describe, expect, it } from "vitest";
import { createFetcher, createRateGate, ProviderFetchError } from "../../../packages/providers/src/index";

const res = (status: number, body = "ok", headers: Record<string, string> = {}) => new Response(body, { status, headers });
const make = (responses: Array<Response | Error>, o: Partial<Parameters<typeof createFetcher>[0]> = {}) => {
  const calls: string[] = [], sleeps: number[] = []; let i = 0;
  const fetcher = createFetcher({ allowedHosts: ["api.example.org"], fetchFn: (async (u: string) => { calls.push(u); const r = responses[Math.min(i++, responses.length - 1)]!; if (r instanceof Error) throw r; return r; }) as never, sleep: async (ms) => { sleeps.push(ms); }, now: () => 1_000_000, baseDelayMs: 10, ...o });
  return { fetcher, calls, sleeps };
};
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ProviderFetchError ? (e.status ? `${e.code}:${e.status}` : e.code) : `other:${String(e)}`; } };

describe("the provider fetcher", () => {
  it("only talks https to an allow-listed host, no credentials, no custom port", async () => {
    const { fetcher, calls } = make([res(200)]);
    expect(await code(fetcher("http://api.example.org/x"))).toBe("not_https");
    expect(await code(fetcher("https://evil.example.com/x"))).toBe("host_not_allowed");
    expect(await code(fetcher("https://u:p@api.example.org/x"))).toBe("host_not_allowed");
    expect(await code(fetcher("https://api.example.org:8443/x"))).toBe("host_not_allowed");
    expect(await code(fetcher("not a url"))).toBe("bad_url");
    expect(calls).toEqual([]); // nothing was sent
    expect(await fetcher("https://api.example.org/x?a=1")).toBe("ok");
  });
  it("retries 5xx a bounded number of times, then reports the status", async () => {
    const a = make([res(503), res(200, "fine")]); expect(await a.fetcher("https://api.example.org/x")).toBe("fine"); expect(a.calls.length).toBe(2);
    const b = make([res(500)], { maxAttempts: 3 }); expect(await code(b.fetcher("https://api.example.org/x"))).toBe("http_error:500"); expect(b.calls.length).toBe(3);
  });
  it("does not retry other 4xx, and refuses redirects", async () => {
    const a = make([res(404)]); expect(await code(a.fetcher("https://api.example.org/x"))).toBe("http_error:404"); expect(a.calls.length).toBe(1);
    const b = make([res(302, "", { location: "https://evil.example.com" })]); expect(await code(b.fetcher("https://api.example.org/x"))).toBe("redirect:302"); expect(b.calls.length).toBe(1);
  });
  it("honours Retry-After on 429, gives up when it is too long, and never loops forever", async () => {
    const a = make([res(429, "", { "retry-after": "2" }), res(200, "later")]); expect(await a.fetcher("https://api.example.org/x")).toBe("later"); expect(a.sleeps).toContain(2000);
    const b = make([res(429, "", { "retry-after": "999" })], { maxRetryAfterMs: 5000 }); expect(await code(b.fetcher("https://api.example.org/x"))).toBe("rate_limited:429"); expect(b.calls.length).toBe(1);
    const c = make([res(429)], { maxAttempts: 2 }); expect(await code(c.fetcher("https://api.example.org/x"))).toBe("rate_limited:429"); expect(c.calls.length).toBe(2);
  });
  it("caps the response size (declared and streamed) and maps network and timeout failures", async () => {
    const big = "x".repeat(2000);
    expect(await code(make([res(200, big, { "content-length": "2000" })], { maxBytes: 1000 }).fetcher("https://api.example.org/x"))).toBe("too_large");
    expect(await code(make([res(200, big)], { maxBytes: 1000 }).fetcher("https://api.example.org/x"))).toBe("too_large");
    expect(await code(make([new TypeError("fetch failed")], { maxAttempts: 1 }).fetcher("https://api.example.org/x"))).toBe("network");
    expect(await code(make([Object.assign(new Error("t"), { name: "TimeoutError" })], { maxAttempts: 1 }).fetcher("https://api.example.org/x"))).toBe("timeout");
  });
  it("never puts the URL (which can carry an API key) into an error", async () => {
    const { fetcher } = make([res(500)], { maxAttempts: 1 });
    try { await fetcher("https://api.example.org/x?api_key=SECRETKEY1234567890"); } catch (e) { expect(String(e) + JSON.stringify(e)).not.toMatch(/SECRETKEY|api_key|example\.org/); }
  });
  it("spaces requests by the provider's published interval", async () => {
    let t = 0; const sleeps: number[] = []; const gate = createRateGate(5000, () => t, async (ms) => { sleeps.push(ms); t += ms; });
    await gate(); await gate(); await gate();
    expect(sleeps).toEqual([5000, 5000]);
  });
});
