import { describe, expect, it } from "vitest";
import { UnrecoverableError } from "bullmq";
import { InvalidJobInputError, parseJobTimestamp } from "../../../services/worker/src/jobTimestamp";
import { processTelegramJob, processTelegramQueueJob } from "../../../services/worker/src/index";

describe("parseJobTimestamp (BullMQ JSON boundary)", () => {
  it("accepts a serialized ISO string and returns the same instant", () => {
    const d = new Date("2026-01-02T03:04:05.000Z");
    expect(parseJobTimestamp(JSON.parse(JSON.stringify({ t: d })).t).getTime()).toBe(d.getTime());
  });
  it("accepts a direct Date and returns a copy", () => {
    const d = new Date("2026-01-02T03:04:05.000Z");
    const out = parseJobTimestamp(d);
    expect(out.getTime()).toBe(d.getTime());
    expect(out).not.toBe(d);
  });
  it.each([["garbage"], ["2026-13-45T00:00:00Z"], [""], ["2026-01-02"], [12345]])(
    "rejects malformed value %j",
    (v) => {
      expect(() => parseJobTimestamp(v)).toThrow(/Invalid messageTimestamp/);
    },
  );
  it("rejects an invalid Date", () => {
    expect(() => parseJobTimestamp(new Date("nope"))).toThrow(/Invalid messageTimestamp/);
  });
  it.each([[null], [undefined]])("rejects missing value %s", (v) => {
    expect(() => parseJobTimestamp(v)).toThrow(/Invalid messageTimestamp/);
  });
  it("processTelegramJob fails explicitly on malformed timestamp, before touching the db", async () => {
    const job = {
      data: {
        telegram: {
          params: { channelIdentifier: "@x" },
          normalizedMessage: {
            channelIdentifier: "@x",
            externalMessageId: "1",
            rawText: "BUY X",
            rawPayload: {},
            messageTimestamp: "not-a-date",
          },
          exchange: "NSE",
          instrumentType: "equity",
        },
      },
    } as never;
    const db = new Proxy({}, { get: () => { throw new Error("db touched"); } }) as never;
    await expect(processTelegramJob(job, "t", db)).rejects.toThrow(/Invalid messageTimestamp/);
  });

  it("classifies malformed input as InvalidJobInputError (BullMQ-independent)", () => {
    expect(() => parseJobTimestamp("bad")).toThrow(InvalidJobInputError);
  });

  const badJob = (ts: unknown) =>
    ({
      id: "job-1",
      data: {
        telegram: {
          params: { channelIdentifier: "@x" },
          normalizedMessage: { channelIdentifier: "@x", externalMessageId: "42", rawText: "SECRET-TEXT", rawPayload: {}, messageTimestamp: ts },
          exchange: "NSE",
          instrumentType: "equity",
        },
      },
    }) as never;

  it("queue boundary maps permanent invalid input to UnrecoverableError with safe identifiers only", async () => {
    const err = await processTelegramQueueJob(badJob(null), "t", {} as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain("jobId=job-1");
    expect((err as Error).message).toContain("externalMessageId=42");
    expect((err as Error).message).not.toContain("SECRET-TEXT");
  });

  it("queue boundary does NOT mark other errors permanent", async () => {
    const db = new Proxy({}, { get: () => { throw new Error("transient db error"); } }) as never;
    const err = await processTelegramQueueJob(badJob("2026-01-02T03:04:05Z"), "t", db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });
});
