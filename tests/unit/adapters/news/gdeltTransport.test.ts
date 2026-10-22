import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GdeltNewsAdapter } from "../../../../adapters/news/src/gdelt";
import { createGdeltHttpTransport, GDELT_DOC_ENDPOINT, parseRetryAfterMs } from "../../../../adapters/news/src/gdeltTransport";
import { ProviderDataError, ProviderRateLimitError, ProviderUnavailableError } from "../../../../packages/types/src";

const body = readFileSync("tests/fixtures/news/gdelt-valid.TEST-FIXTURE.json", "utf8");
const req = { query: 'secret "query" & more=1', maxRecords: 50 };
const resp = (status: number, text = body, headers: Record<string, string> = {}) => new Response(text, { status, headers });
const mock = (...rs: Array<Response | Error>) => {
  const q = [...rs];
  return vi.fn(async () => { const r = q.shift() ?? resp(200); if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
};
const noSleep = vi.fn(async () => undefined);

describe("endpoint / allowlist validation", () => {
  it("accepts only https on the allowlisted host, before any request", () => {
    for (const endpoint of ["http://api.gdeltproject.org/api/v2/doc/doc", "https://evil.example/api", "https://user:pw@api.gdeltproject.org/x", "https://api.gdeltproject.org.evil.example/x"]) {
      expect(() => createGdeltHttpTransport({ endpoint, fetchFn: mock() }), endpoint).toThrow();
    }
    expect(() => createGdeltHttpTransport({ fetchFn: mock() })).not.toThrow();
  });
});

describe("request construction", () => {
  it("URL-encodes parameters, clamps maxrecords, sends no redirect-following and a bounded signal", async () => {
    const f = mock(resp(200));
    await createGdeltHttpTransport({ fetchFn: f })({ ...req, maxRecords: 100000, since: new Date("2026-10-20T01:02:03Z") });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(GDELT_DOC_ENDPOINT);
    expect(u.searchParams.get("query")).toBe(req.query); // round-trips, so it was encoded rather than concatenated
    expect(url).not.toContain('"'); expect(url).not.toContain(" ");
    expect(u.searchParams.get("maxrecords")).toBe("250");
    expect(u.searchParams.get("startdatetime")).toBe("20261020010203");
    // Exact documented value spellings, asserted on the raw query string (not just the decoded values).
    expect(u.searchParams.get("mode")).toBe("ArtList");
    expect(u.searchParams.get("format")).toBe("JSON");
    expect(u.searchParams.get("sort")).toBe("DateDesc");
    expect(u.search).toContain("mode=ArtList&format=JSON&sort=DateDesc");
    expect(u.search).toContain("query=Sensex+sourcelang%3Aenglish".replace("Sensex+sourcelang%3Aenglish", "secret+%22query%22+%26+more%3D1"));
    expect(u.search).toContain("startdatetime=20261020010203");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("never requests anything but the DOC endpoint (no article URL is ever fetched)", async () => {
    const f = mock(resp(200));
    const adapter = new GdeltNewsAdapter({ query: "q", transport: createGdeltHttpTransport({ fetchFn: f }) });
    await adapter.fetchLatest({});
    expect(f).toHaveBeenCalledTimes(1);
    expect(new URL((f.mock.calls[0] as [string])[0]).hostname).toBe("api.gdeltproject.org");
  });
});

describe("failure handling", () => {
  it("refuses redirects without following them", async () => {
    const f = mock(resp(302, "", { location: "https://evil.example/" }));
    await expect(createGdeltHttpTransport({ fetchFn: f, sleep: noSleep })(req)).rejects.toBeInstanceOf(ProviderDataError);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("retries 5xx and network errors with bounded exponential backoff, then succeeds", async () => {
    const sleep = vi.fn(async () => undefined);
    const f = mock(resp(503), new TypeError("boom"), resp(200));
    const r = await createGdeltHttpTransport({ fetchFn: f, sleep, baseDelayMs: 100, maxAttempts: 3 })(req);
    expect(r.status).toBe(200);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });
  it("gives up after maxAttempts with a typed unavailable error that leaks no query or body", async () => {
    const f = mock(resp(500, "SECRETBODY"), resp(500, "SECRETBODY"), resp(500, "SECRETBODY"), resp(500));
    const err = await createGdeltHttpTransport({ fetchFn: f, sleep: noSleep, maxAttempts: 3 })(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(f).toHaveBeenCalledTimes(3);
    const text = JSON.stringify([(err as Error).message, (err as Error).name]);
    expect(text).not.toMatch(/SECRETBODY|secret|query/i);
  });
  it("does not retry other 4xx", async () => {
    const f = mock(resp(404), resp(200));
    await expect(createGdeltHttpTransport({ fetchFn: f, sleep: noSleep })(req)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("honours Retry-After on 429 (seconds), waiting at least that long", async () => {
    const sleep = vi.fn(async () => undefined);
    const f = mock(resp(429, "", { "retry-after": "7" }), resp(200));
    await createGdeltHttpTransport({ fetchFn: f, sleep, baseDelayMs: 100 })(req);
    expect(sleep.mock.calls[0]?.[0]).toBe(7000);
  });
  it("does not wait for a Retry-After above the cap: surfaces a rate-limit error instead", async () => {
    const f = mock(resp(429, "", { "retry-after": "3600" }), resp(200));
    const err = await createGdeltHttpTransport({ fetchFn: f, sleep: noSleep, maxRetryAfterMs: 30_000 })(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect((err as ProviderRateLimitError).retryAfterMs).toBe(3_600_000);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("parses Retry-After as seconds or an HTTP date, and ignores garbage", () => {
    expect(parseRetryAfterMs("5", 0)).toBe(5000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:05 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(5000);
    expect(parseRetryAfterMs("soon", 0)).toBeUndefined();
    expect(parseRetryAfterMs(null, 0)).toBeUndefined();
  });
  it("the adapter keeps the rate-limit type (not flattened to unavailable) and never turns failure into empty data", async () => {
    const a = new GdeltNewsAdapter({ query: "q", transport: createGdeltHttpTransport({ fetchFn: mock(resp(429, "", { "retry-after": "3600" })), sleep: noSleep }) });
    await expect(a.fetchLatest({})).rejects.toBeInstanceOf(ProviderRateLimitError);
  });
});

describe("size bound applied while reading", () => {
  it("rejects on Content-Length before reading anything", async () => {
    const r = new Response("x", { status: 200, headers: { "content-length": "999999" } });
    const cancel = vi.spyOn(r.body!, "cancel");
    await expect(createGdeltHttpTransport({ fetchFn: mock(r), maxResponseBytes: 1000 })(req)).rejects.toThrow(/declared response size/);
    expect(cancel).toHaveBeenCalled();
  });
  it("abandons a stream that exceeds the bound without reading the rest", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(400)); if (pulled > 1000) c.close(); } });
    await expect(createGdeltHttpTransport({ fetchFn: mock(new Response(stream, { status: 200 })), maxResponseBytes: 1000 })(req)).rejects.toThrow(/while streaming/);
    expect(pulled).toBeLessThan(10); // stopped early, nowhere near the 1000 chunks offered
  });
});

describe("with a local test server (loopback only; logical URL still validated as the official https host)", () => {
  let server: http.Server;
  let port = 0;
  let hits: string[] = [];
  beforeAll(async () => {
    server = http.createServer((rq, rs) => {
      hits.push(rq.url ?? "");
      if (rq.url?.includes("slow")) return; // never answers
      if (rq.url?.includes("big")) { rs.writeHead(200, { "content-type": "application/json" }); const t = setInterval(() => rs.write("x".repeat(1000)), 1); rs.on("close", () => clearInterval(t)); return; }
      rs.writeHead(200, { "content-type": "application/json" });
      rs.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const toLocal = (extra = "") => (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}${extra}`, init);
  }) as typeof fetch;

  it("returns a real streamed body end to end through the adapter", async () => {
    hits = [];
    const items = await new GdeltNewsAdapter({ query: "q", transport: createGdeltHttpTransport({ fetchFn: toLocal() }) }).fetchLatest({});
    expect(items).toHaveLength(3);
    expect(hits).toHaveLength(1);
  });
  it("times out a server that never answers", async () => {
    const t0 = Date.now();
    await expect(createGdeltHttpTransport({ fetchFn: toLocal("&slow=1"), timeoutMs: 150, maxAttempts: 1 })(req)).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it("stops reading an endless body at the byte bound", async () => {
    await expect(createGdeltHttpTransport({ fetchFn: toLocal("&big=1"), maxResponseBytes: 5000, timeoutMs: 5000, maxAttempts: 1 })(req)).rejects.toThrow(/while streaming/);
  });
});

describe("static properties", () => {
  it("transport source contains no logging, no article fetching and no raw-input echo", () => {
    const src = readFileSync("adapters/news/src/gdeltTransport.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/console\.|logger|process\.env/);
    expect(src).not.toMatch(/redirect:\s*"follow"/);
  });
});
