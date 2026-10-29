import { describe, expect, it } from "vitest";
import { validateRawRecord } from "../../../packages/historical/src/index";
import { PATTERNS } from "../../../scripts/ci/secret-scan.mjs";
import { contentSha256, identityKey, messageKey, redactSecrets, SECRET_PATTERNS } from "../../../packages/historical/src/index";

describe("redaction", () => {
  it("uses exactly the repository secret scanner's high-confidence patterns", () => {
    expect(SECRET_PATTERNS.map(([k, r]) => [k, r.source, r.flags])).toEqual((PATTERNS as Array<[string, RegExp]>).map(([k, r]) => [k, r.source, r.flags]));
  });
  it.each([
    ["a Telegram bot token", `see ${"123456789:" + "A".repeat(35)} now`, "telegram_bot_token"],
    ["a GitHub token", `x ghp_${"a".repeat(36)} y`, "github_token"],
    ["an AWS key id", "id AKIAABCDEFGHIJKLMNOP end", "aws_access_key_id"],
    ["a private key block", "-----BEGIN RSA PRIVATE KEY----- abc", "private_key_block"],
    ["a URL with a password", "postgres://user:hunter2hunter2@db.internal/x", "url_with_password"],
    ["a quoted secret assignment", 'password = "abcdefgh12345678"', "quoted_secret_assignment"],
    ["an e-mail address", "write to someone.name+tag@mail.example.org please", "email_address"],
    ["an international phone number", "call +91 98765 43210 now", "phone_number"],
    ["a Telegram invite link", "join t.me/+AbCdEfGh123456 today", "telegram_invite_link"],
  ])("redacts %s", (_n, text, kind) => {
    const r = redactSecrets(text);
    expect(r.kinds).toContain(kind);
    expect(r.text).toContain(`[REDACTED:${kind}]`);
    expect(r.text).not.toMatch(/hunter2|98765|AbCdEfGh|AKIAABCDEF|someone\.name|AAAAAAAAAA|-----BEGIN/);
  });
  it("leaves trading text untouched: prices, strikes, dates, symbols, percentages", () => {
    const t = "BUY NIFTY 24500 CE 29 OCT 2031 ABOVE 120.5 SL 90 TGT 150 180 premium 85% confidence +2.5% move 100000";
    expect(redactSecrets(t)).toEqual({ text: t, kinds: [] });
  });
  it("is idempotent and deterministic", () => {
    const once = redactSecrets(`mail a@b.example.com token ${"123456789:" + "A".repeat(35)}`);
    expect(redactSecrets(once.text).text).toBe(once.text);
    expect(redactSecrets("mail a@b.example.com").text).toBe(redactSecrets("mail a@b.example.com").text);
  });
});

describe("identity", () => {
  const t = new Date("2024-03-04T04:00:00Z");
  const h = contentSha256("BUY X @ 1");
  it("is stable and depends on channel, message id, timestamp and content", () => {
    const base = identityKey("c", "1", t, h);
    expect(identityKey("c", "1", t, h)).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(identityKey("d", "1", t, h)).not.toBe(base);
    expect(identityKey("c", "2", t, h)).not.toBe(base);
    expect(identityKey("c", "1", new Date(t.getTime() + 1000), h)).not.toBe(base);
    expect(identityKey("c", "1", t, contentSha256("BUY X @ 2"))).not.toBe(base);
    expect(messageKey("c", "1")).toBe("c|1");
  });
  it("cannot be ambiguous across field boundaries: the separator is not allowed in a channel or a message id", () => {
    const base = { timestamp: "2024-03-04T04:00:00Z", text: "x" };
    expect(validateRawRecord({ ...base, channel: "a|b", message_id: "c" }, new Date("2026-10-30T00:00:00Z"))).toEqual({ ok: false, code: "invalid_channel" });
    expect(validateRawRecord({ ...base, channel: "a", message_id: "b|c" }, new Date("2026-10-30T00:00:00Z"))).toEqual({ ok: false, code: "invalid_message_id" });
  });
});
