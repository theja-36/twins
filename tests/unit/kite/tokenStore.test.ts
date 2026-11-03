import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KiteError, KiteTokenStore, apiKeyFingerprint, loadKitePlan } from "../../../packages/kite/src/index";
import { ACCESS_TOKEN, API_KEY } from "./helpers";

const T0 = new Date("2026-11-03T04:00:00.000Z"); // 09:30 IST
const dir = () => mkdtempSync(join(tmpdir(), "twins-tok-"));

describe("KiteTokenStore", () => {
  it("saves atomically with mode 0600, leaves no temp file, and loads it back for the same api key only", () => {
    const d = dir();
    const store = new KiteTokenStore(join(d, "kite-token.json"), () => T0);
    store.save(ACCESS_TOKEN, API_KEY);
    expect(statSync(join(d, "kite-token.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(d)).toEqual(["kite-token.json"]);
    expect(store.load(API_KEY)).toMatchObject({ accessToken: ACCESS_TOKEN, issuedAt: T0.toISOString(), apiKeyFingerprint: apiKeyFingerprint(API_KEY) });
    expect(store.load("anotherkey123")).toBeNull(); // a token issued for another app is not served
    expect(apiKeyFingerprint(API_KEY)).toMatch(/^[0-9a-f]{12}$/);
    expect(apiKeyFingerprint(API_KEY)).not.toContain(API_KEY);
  });
  it("overwrites an older token atomically", () => {
    const d = dir(); const p = join(d, "t.json");
    new KiteTokenStore(p, () => T0).save(ACCESS_TOKEN, API_KEY);
    new KiteTokenStore(p, () => new Date(T0.getTime() + 86_400_000)).save("another_token_0123456789abcdef", API_KEY);
    expect(new KiteTokenStore(p).load(API_KEY)?.accessToken).toBe("another_token_0123456789abcdef");
    expect(readdirSync(d)).toEqual(["t.json"]);
  });
  it("status: present with advisory expiry (06:00 IST the next day), never containing the token", () => {
    const d = dir(); const p = join(d, "t.json");
    new KiteTokenStore(p, () => T0).save(ACCESS_TOKEN, API_KEY);
    const early = new KiteTokenStore(p, () => new Date("2026-11-03T20:00:00.000Z")).status(); // 01:30 IST next day
    expect(early).toMatchObject({ present: true, advisoryExpired: false, advisoryExpiresAt: "2026-11-04T00:30:00.000Z" });
    const late = new KiteTokenStore(p, () => new Date("2026-11-04T00:30:00.000Z")).status();
    expect(late).toMatchObject({ present: true, advisoryExpired: true });
    expect(JSON.stringify([early, late])).not.toContain(ACCESS_TOKEN);
  });
  it("refuses a file readable by group or others, a symlink, a missing file and garbage - reporting only a reason", () => {
    const d = dir(); const p = join(d, "t.json");
    const store = new KiteTokenStore(p, () => T0);
    expect(store.status()).toEqual({ present: false, reason: "missing" });
    store.save(ACCESS_TOKEN, API_KEY);
    chmodSync(p, 0o640);
    expect(store.status()).toEqual({ present: false, reason: "unsafe_permissions" });
    expect(store.load(API_KEY)).toBeNull();
    chmodSync(p, 0o600);
    writeFileSync(p, "not json", { mode: 0o600 });
    expect(store.status()).toEqual({ present: false, reason: "unreadable" });
    writeFileSync(join(d, "real.json"), "{}", { mode: 0o600 });
    const link = join(d, "link.json");
    symlinkSync(join(d, "real.json"), link);
    expect(new KiteTokenStore(link).status()).toEqual({ present: false, reason: "unsafe_permissions" });
  });
  it("rejects a malformed token and a relative path; clear removes the file", () => {
    const d = dir(); const p = join(d, "t.json");
    const store = new KiteTokenStore(p, () => T0);
    expect(() => store.save("short", API_KEY)).toThrow(KiteError);
    expect(() => store.save("has spaces and = signs 0123456789", API_KEY)).toThrow(KiteError);
    expect(existsSync(p)).toBe(false);
    expect(() => new KiteTokenStore("relative/path.json")).toThrow(KiteError);
    store.save(ACCESS_TOKEN, API_KEY);
    store.clear();
    expect(existsSync(p)).toBe(false);
    expect(readFileSync(new URL("../../../packages/kite/src/tokenStore.ts", import.meta.url), "utf8")).not.toMatch(/console\.|process\.stdout|log\(/); // the store never prints
  });
});

describe("loadKitePlan", () => {
  it("defaults to personal (fail closed), accepts personal / connect, and throws on anything else", () => {
    expect(loadKitePlan({})).toBe("personal");
    expect(loadKitePlan({ TWINS_KITE_PLAN: "" })).toBe("personal");
    expect(loadKitePlan({ TWINS_KITE_PLAN: "connect" })).toBe("connect");
    expect(loadKitePlan({ TWINS_KITE_PLAN: "personal" })).toBe("personal");
    for (const bad of ["Connect", "paid", "1", " connect"]) expect(() => loadKitePlan({ TWINS_KITE_PLAN: bad }), bad).toThrow(KiteError);
  });
});
