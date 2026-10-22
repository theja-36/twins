import { describe, expect, it } from "vitest";

const must = <T,>(v: T | undefined | null): T => { if (v === undefined || v === null) throw new Error("expected a value"); return v; };
import {
  acceptCorrelationId,
  createStructuredLogger,
  describeErrorSafely,
  newCorrelationId,
  newRequestId,
  parseCorrelationContext,
  type LogRecord,
} from "../../../packages/shared/src/index";

const capture = () => {
  const records: LogRecord[] = [];
  return { records, logger: createStructuredLogger((r) => records.push(r), { service: "test" }, () => new Date("2026-01-01T00:00:00Z")) };
};

describe("structured logger", () => {
  it("emits a record with ts/level/event, base fields and child context (no shared state between children)", () => {
    const { records, logger } = capture();
    const a = logger.child({ correlationId: "corr_a" });
    const b = logger.child({ correlationId: "corr_b" });
    a.info("x.done", { n: 1 });
    b.error("x.failed", { errorCode: "BOOM" });
    expect(records[0]).toMatchObject({ ts: "2026-01-01T00:00:00.000Z", level: "info", event: "x.done", service: "test", correlationId: "corr_a", n: 1 });
    expect(records[1]).toMatchObject({ level: "error", event: "x.failed", correlationId: "corr_b", errorCode: "BOOM" });
  });

  it("masks sensitive/content keys, truncates long strings and never serialises Error messages", () => {
    const { records, logger } = capture();
    logger.info("x", {
      authorization: "Bearer SECRET-CANARY",
      "x-telegram-bot-api-secret-token": "SECRET-CANARY",
      rawText: "BUY CANARY @ 1",
      payload: { text: "CANARY" },
      apiKey: "SECRET-CANARY",
      note: "a".repeat(500),
      err: new Error("password=SECRET-CANARY in row"),
    });
    const line = JSON.stringify(records[0]);
    expect(line).not.toContain("CANARY");
    expect(must(records[0])["authorization"]).toBe("[redacted]");
    expect((must(records[0])["note"] as string).length).toBeLessThan(260);
    expect(must(records[0])["err"]).toEqual({ errorName: "Error" });
  });

  it("does not let fields override ts/level/event", () => {
    const { records, logger } = capture();
    logger.info("real.event", { event: "spoofed", level: "error", ts: "never" });
    expect(records[0]).toMatchObject({ event: "real.event", level: "info", ts: "2026-01-01T00:00:00.000Z" });
  });
});

describe("correlation helpers", () => {
  it("generates distinct internal ids with distinct prefixes", () => {
    expect(newCorrelationId()).toMatch(/^corr_[0-9a-f-]{36}$/);
    expect(newRequestId()).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });
  it("accepts only short safe tokens from outside", () => {
    expect(acceptCorrelationId("abc-123_DEF.456")).toBe("abc-123_DEF.456");
    for (const bad of ["short", "a".repeat(65), "has space 12345", "line\nbreak123", "{json:true}12", ["array-value-1"], 12345678, undefined, null]) {
      expect(acceptCorrelationId(bad)).toBeUndefined();
    }
  });
  it("parses job correlation metadata and tolerates missing or malformed metadata", () => {
    expect(parseCorrelationContext({ correlationId: "corr_12345678", requestId: "req_1", receivedAt: "2026-01-01T00:00:00Z" })).toEqual({
      correlationId: "corr_12345678", requestId: "req_1", receivedAt: "2026-01-01T00:00:00Z",
    });
    expect(parseCorrelationContext(undefined)).toBeUndefined();
    expect(parseCorrelationContext("string")).toBeUndefined();
    expect(parseCorrelationContext({ correlationId: "bad id with spaces" })).toBeUndefined();
  });
  it("describes errors by code and class name only", () => {
    class InvalidJobInputError extends Error { readonly code = "INVALID_JOB_INPUT"; }
    expect(describeErrorSafely(new InvalidJobInputError("secret detail"))).toEqual({ errorCode: "INVALID_JOB_INPUT", errorName: "Error" });
    expect(describeErrorSafely(Object.assign(new Error("x"), { code: "23505" }))).toEqual({ errorCode: "UNEXPECTED_ERROR", errorName: "Error" });
    expect(describeErrorSafely("not an error")).toEqual({ errorCode: "UNEXPECTED_ERROR", errorName: "Error" });
  });
});
