import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { BotConfigError, DEFAULT_API_BASE, loadBotConfig } from "../../../services/approval-bot/src/config";
import { CHANNEL, OTHER_CHANNEL, TOKEN, testEnv } from "../../support/approvalBotFakes";

const load = (over: Record<string, string> = {}, drop: string[] = []) => {
  const env: Record<string, string | undefined> = { ...testEnv(), ...over };
  for (const k of drop) delete env[k];
  return loadBotConfig(env);
};
const fails = (over: Record<string, string>, rule: RegExp, drop: string[] = []) => {
  let message = "";
  try {
    load(over, drop);
  } catch (e) {
    expect(e).toBeInstanceOf(BotConfigError);
    message = (e as Error).message;
  }
  expect(message).toMatch(rule);
  return message;
};

describe("bot configuration", () => {
  it("loads a valid environment with the documented defaults", () => {
    const c = load();
    expect(c.approverId).toBe(123456789);
    expect(c.sourceChannels).toEqual([CHANNEL]);
    expect([c.cardTtlSeconds, c.pollIntervalSeconds, c.maxPerHour, c.maxPerDay, c.maxPerCycle]).toEqual([14400, 30, 20, 100, 5]); // 4 h card expiry
    expect(c.apiBase).toBe(DEFAULT_API_BASE);
    expect(c.active).toBe(true);
    expect(c.channelLabel).toBe("signal channel");
  });
  it("is inactive unless TWINS_BOT_ACTIVE is exactly 'true' (second lock besides starting the container)", () => {
    for (const v of ["", "TRUE", "1", "yes", "false"]) expect(load({ TWINS_BOT_ACTIVE: v }).active).toBe(false);
    expect(load({}, ["TWINS_BOT_ACTIVE"]).active).toBe(false);
  });
  it("never reveals its secrets: JSON, inspect and string conversion are redacted", () => {
    const c = load();
    for (const text of [JSON.stringify(c), inspect(c), `${JSON.stringify({ c })}`]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("pw@");
      expect(text).not.toContain("abababab");
      expect(text).toContain("redacted");
    }
  });
  it("requires every secret, and the error names the variable but never the value", () => {
    for (const name of ["TWINS_BOT_TOKEN", "TWINS_BOT_APPROVER_ID", "TWINS_BOT_DATABASE_URL", "TWINS_BOT_HMAC_KEY", "TWINS_BOT_SOURCE_CHANNELS"]) {
      expect(fails({}, new RegExp(`${name} is not set`), [name])).not.toContain(TOKEN);
    }
    const msg = fails({ TWINS_BOT_TOKEN: "SECRETVALUE-not-a-token" }, /TWINS_BOT_TOKEN has an unexpected format/);
    expect(msg).not.toContain("SECRETVALUE");
  });
  it("validates the token, the approver id and the HMAC key formats", () => {
    for (const t of ["", "abc", "12345:short", "123456789:" + "x".repeat(29), "123456789:" + "x".repeat(61), "a23456789:" + "x".repeat(35), " " + TOKEN]) fails({ TWINS_BOT_TOKEN: t }, /TWINS_BOT_TOKEN/);
    for (const a of ["0", "-123456789", "abc", "1234", "12345678901234567", "1.5", "123456789 "]) fails({ TWINS_BOT_APPROVER_ID: a }, /TWINS_BOT_APPROVER_ID/);
    for (const k of ["zz".repeat(32), "ab".repeat(31), "AB".repeat(32), "ab".repeat(33)]) fails({ TWINS_BOT_HMAC_KEY: k }, /TWINS_BOT_HMAC_KEY/);
  });
  it("the database URL must be the restricted role twins_bot with a password on an internal host", () => {
    for (const url of ["postgresql://postgres:pw@twins-staging-postgres-1:5432/db", "postgresql://twins:pw@twins-staging-postgres-1:5432/db", "postgresql://twins_bot@twins-staging-postgres-1:5432/db", "mysql://twins_bot:pw@x/db", "not a url"]) {
      fails({ TWINS_BOT_DATABASE_URL: url }, /TWINS_BOT_DATABASE_URL/);
    }
    for (const host of ["db.example.com", "8.8.8.8", "169.254.1.1"]) fails({ TWINS_BOT_DATABASE_URL: `postgresql://twins_bot:pw@${host}:5432/db` }, /internal host/);
    for (const host of ["twins-staging-postgres-1", "localhost", "127.0.0.1", "10.0.21.5", "172.20.0.2", "192.168.1.9"]) expect(load({ TWINS_BOT_DATABASE_URL: `postgresql://twins_bot:pw@${host}:5432/db` }).databaseUrl).toContain(host);
  });
  it("source channels: 1-3 distinct tg_chat_-100... identifiers only", () => {
    expect(load({ TWINS_BOT_SOURCE_CHANNELS: `${CHANNEL}, ${OTHER_CHANNEL}` }).sourceChannels).toEqual([CHANNEL, OTHER_CHANNEL]);
    for (const v of ["", "mychannel", "tg_chat_123", `${CHANNEL},${CHANNEL}`, `${CHANNEL},${OTHER_CHANNEL},tg_chat_-1003000000003,tg_chat_-1004000000004`, "-1001000000001", "*"]) fails({ TWINS_BOT_SOURCE_CHANNELS: v }, /TWINS_BOT_SOURCE_CHANNELS/);
  });
  it("numeric settings are bounded", () => {
    fails({ TWINS_BOT_CARD_TTL_SECONDS: "10" }, /TWINS_BOT_CARD_TTL_SECONDS/);
    fails({ TWINS_BOT_CARD_TTL_SECONDS: "999999" }, /TWINS_BOT_CARD_TTL_SECONDS/);
    fails({ TWINS_BOT_CARD_TTL_SECONDS: "4h" }, /integer/);
    fails({ TWINS_BOT_MAX_PER_HOUR: "0" }, /TWINS_BOT_MAX_PER_HOUR/);
    fails({ TWINS_BOT_MAX_PER_DAY: "501" }, /TWINS_BOT_MAX_PER_DAY/);
    expect(load({ TWINS_BOT_CARD_TTL_SECONDS: "7200" }).cardTtlSeconds).toBe(7200);
    fails({ TWINS_BOT_CHANNEL_LABEL: "<b>x</b>" }, /TWINS_BOT_CHANNEL_LABEL/);
  });
  it("the API base can only be moved to a loopback http address (tests), never to another host", () => {
    expect(load({ TWINS_BOT_TEST_API_BASE: "http://127.0.0.1:8081" }).apiBase).toBe("http://127.0.0.1:8081");
    for (const v of ["https://evil.example.com", "http://evil.example.com", "https://127.0.0.1:1", "http://10.0.0.5:80", "ftp://127.0.0.1", "garbage"]) fails({ TWINS_BOT_TEST_API_BASE: v }, /TWINS_BOT_TEST_API_BASE/);
  });
});
