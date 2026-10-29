import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, EARLIEST_TIMESTAMP, MAX_TEXT_LENGTH, parseTimestamp, validateRawRecord } from "../../../packages/historical/src/index";

const NOW = new Date("2026-10-30T10:00:00Z");
const good = (over: Record<string, unknown> = {}) => ({ channel: "synthetic-channel", message_id: 7, timestamp: "2024-03-04T04:00:00Z", text: "BUY RELIANCE @ 2800 SL 2750 TGT 2900", ...over });

describe("input contract", () => {
  it("accepts a minimal record and normalises the types", () => {
    const r = validateRawRecord(good(), NOW);
    expect(r).toMatchObject({ ok: true, message: { channel: "synthetic-channel", messageId: "7", author: null, market: null, media: [], edits: [], editMarkerWithoutText: false }, warnings: [] });
    expect(CONTRACT_VERSION).toBe("historical-contract-v1");
  });
  // [description, record override, expected failure code]
  const invalid: Array<[string, Record<string, unknown>, string]> = [
    ["channel missing", { channel: undefined }, "invalid_channel"],
    ["channel with a path separator", { channel: "../etc" }, "invalid_channel"],
    ["channel too long", { channel: "x".repeat(81) }, "invalid_channel"],
    ["message id missing", { message_id: undefined }, "invalid_message_id"],
    ["message id negative", { message_id: -1 }, "invalid_message_id"],
    ["message id with a space", { message_id: "a b" }, "invalid_message_id"],
    ["timestamp without an offset", { timestamp: "2024-03-04T04:00:00" }, "invalid_timestamp"],
    ["timestamp not a date", { timestamp: "yesterday" }, "invalid_timestamp"],
    ["timestamp an object", { timestamp: {} }, "invalid_timestamp"],
    ["timestamp before Telegram existed", { timestamp: "2010-01-01T00:00:00Z" }, "timestamp_out_of_range"],
    ["timestamp far in the future", { timestamp: "2031-01-01T00:00:00Z" }, "timestamp_out_of_range"],
    ["unix seconds out of range", { timestamp: 5 }, "timestamp_out_of_range"],
    ["text missing", { text: undefined }, "invalid_text"],
    ["text a number", { text: 5 }, "invalid_text"],
    ["text with a NUL", { text: "a\u0000b" }, "invalid_text"],
    ["text too long", { text: "x".repeat(MAX_TEXT_LENGTH + 1) }, "text_too_long"],
    ["market lower case", { market: "nse" }, "invalid_market"],
    ["media not an array", { media: "photo" }, "invalid_media"],
    ["edits not an array", { edits: "x" }, "invalid_edits"],
    ["too many edits", { edits: Array.from({ length: 51 }, (_, i) => ({ edited_at: "2024-03-04T05:00:00Z", text: `e${i}` })) }, "too_many_edits"],
  ];
  it.each(invalid)("rejects: %s", (_d, over, code) => {
    expect(validateRawRecord(good(over), NOW)).toEqual({ ok: false, code });
  });
  it("rejects non-objects", () => {
    for (const v of [null, 5, "x", [1]]) expect(validateRawRecord(v, NOW)).toEqual({ ok: false, code: "record_not_an_object" });
  });
  it("accepts ISO with an offset, a space separator, and Unix seconds; the instant is exact", () => {
    expect((parseTimestamp("2024-03-04T09:30:00+05:30", NOW) as Date).toISOString()).toBe("2024-03-04T04:00:00.000Z");
    expect((parseTimestamp("2024-03-04 04:00:00Z", NOW) as Date).toISOString()).toBe("2024-03-04T04:00:00.000Z");
    expect((parseTimestamp(1709524800, NOW) as Date).toISOString()).toBe("2024-03-04T04:00:00.000Z");
    expect(parseTimestamp("2013-07-31T23:59:59Z", NOW)).toBe("out_of_range");
    expect(EARLIEST_TIMESTAMP).toBe(Date.parse("2013-08-01T00:00:00Z"));
  });
  it("accepts an empty text (a media-only message) and keeps author / market / media / edits", () => {
    const r = validateRawRecord(good({ text: "", author: "synthetic_author", market: "NSE", media: [{ type: "photo", ref: "files/photo_1.jpg" }], edits: [{ edited_at: "2024-03-04T05:00:00Z", text: "BUY TCS @ 3500 SL 3400 TGT 3600" }] }), NOW);
    expect(r).toMatchObject({ ok: true, message: { text: "", author: "synthetic_author", market: "NSE", media: [{ type: "photo", ref: "files/photo_1.jpg" }] } });
    expect(r.ok && r.message.edits).toHaveLength(1);
  });
  it("withholds (never stores) a malformed author, media reference or edit, and ignores unknown fields while counting them", () => {
    const r = validateRawRecord(good({ author: "<script>", media: [{ type: "photo", ref: "../../etc/passwd" }, { type: "Photo!", ref: "x" }], edits: [{ edited_at: "nope", text: "x" }], api_token: "secret", session: "x" }), NOW);
    expect(r.ok && r.message.author).toBeNull();
    expect(r.ok && r.message.media).toEqual([]);
    expect(r.ok && r.message.edits).toEqual([]);
    expect(r.ok && r.warnings).toEqual(expect.arrayContaining(["author_withheld", "media_ref_withheld", "edit_invalid", "unknown_fields_ignored"]));
    expect(JSON.stringify(r)).not.toMatch(/secret|passwd|script/);
  });
  it("sorts edits by time and flags an edit marker without the edited text", () => {
    const r = validateRawRecord(good({ edits: [{ edited_at: "2024-03-04T06:00:00Z", text: "b" }, { edited_at: "2024-03-04T05:00:00Z", text: "a" }] }), NOW);
    expect(r.ok && r.message.edits.map((e) => e.text)).toEqual(["a", "b"]);
    const m = validateRawRecord(good({ edited_at: "2024-03-04T05:00:00Z" }), NOW);
    expect(m).toMatchObject({ ok: true, message: { editMarkerWithoutText: true }, warnings: ["edit_marker_without_text"] });
  });
  it("warns about a timestamp in the near future (within the one-day tolerance)", () => {
    expect(validateRawRecord(good({ timestamp: "2026-10-30T20:00:00Z" }), NOW)).toMatchObject({ ok: true, warnings: ["future_timestamp"] });
  });
});
