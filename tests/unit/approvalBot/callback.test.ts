import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCallbackData, parseCallbackData, verifyCallback } from "../../../services/approval-bot/src/callback";
import { b64ToUuid, uuidToB64 } from "../../../services/approval-bot/src/ids";

const KEY = Buffer.from("ab".repeat(32), "hex");
const NONCE = "0123456789abcdef0123456789abcdef";

describe("signed callback data", () => {
  it("round-trips a card id and action, fits Telegram's 64-byte limit, and verifies", () => {
    const id = randomUUID();
    const data = buildCallbackData(KEY, id, NONCE, "a");
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(data).toMatch(/^v1\.[A-Za-z0-9_-]{22}\.a\.[A-Za-z0-9_-]{16}$/);
    const parsed = parseCallbackData(data)!;
    expect(parsed).toMatchObject({ cardId: id, action: "a" });
    expect(verifyCallback(KEY, parsed, NONCE)).toBe(true);
    expect(parseCallbackData(buildCallbackData(KEY, id, NONCE, "r"))!.action).toBe("r");
  });
  it("is deterministic per (card, nonce, action) and different across actions, cards and nonces", () => {
    const id = randomUUID();
    expect(buildCallbackData(KEY, id, NONCE, "a")).toBe(buildCallbackData(KEY, id, NONCE, "a"));
    expect(buildCallbackData(KEY, id, NONCE, "a")).not.toBe(buildCallbackData(KEY, id, NONCE, "r"));
    expect(buildCallbackData(KEY, id, NONCE, "a")).not.toBe(buildCallbackData(KEY, randomUUID(), NONCE, "a"));
    expect(buildCallbackData(KEY, id, NONCE, "a")).not.toBe(buildCallbackData(KEY, id, "f".repeat(32), "a"));
  });
  it("rejects a tampered MAC, a swapped action, another card's MAC, another nonce and another key", () => {
    const id = randomUUID();
    const other = randomUUID();
    const data = buildCallbackData(KEY, id, NONCE, "a");
    const parsed = parseCallbackData(data)!;
    const flipped = data.slice(0, -1) + (data.endsWith("A") ? "B" : "A");
    expect(verifyCallback(KEY, parseCallbackData(flipped)!, NONCE)).toBe(false);
    expect(verifyCallback(KEY, { ...parsed, action: "r" }, NONCE)).toBe(false); // approve MAC replayed as reject
    expect(verifyCallback(KEY, { ...parsed, cardId: other }, NONCE)).toBe(false); // MAC from another card
    expect(verifyCallback(KEY, parsed, "f".repeat(32))).toBe(false);
    expect(verifyCallback(Buffer.from("cd".repeat(32), "hex"), parsed, NONCE)).toBe(false);
  });
  it("parses only the exact format", () => {
    const good = buildCallbackData(KEY, randomUUID(), NONCE, "a");
    for (const bad of [undefined, null, 5, "", "x", good.replace("v1.", "v2."), good + "x", good.slice(0, -1), good.replace(".a.", ".x."), good.toUpperCase(), "v1.." + good.slice(3), "a".repeat(65), `${good}\n`, " " + good]) {
      expect(parseCallbackData(bad)).toBeNull();
    }
  });
  it("uuid <-> base64url conversion", () => {
    const id = randomUUID();
    expect(b64ToUuid(uuidToB64(id))).toBe(id);
    expect(uuidToB64(id)).toHaveLength(22);
    expect(b64ToUuid("short")).toBeNull();
    expect(() => uuidToB64("nope")).toThrow();
  });
});
