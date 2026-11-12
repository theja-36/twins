import { describe, expect, it } from "vitest";
import { CSRF, ORIGIN, TOKEN, cfgDev, cfgHost } from "@/test/helpers";
import { clearOptions, cookieNames, csrfCookieOptions, csrfOk, isCsrfToken, isSessionToken, newCsrfToken, parseCookies, readSession, safeEqual, sameOrigin, sessionCookieOptions } from "./security";

const req = (h: Record<string, string>, method = "POST") => new Request(`${ORIGIN}/api/auth/logout`, { method, headers: h });

describe("tokens", () => {
  it("session token: exactly tws_ + 43 base64url characters", () => {
    expect(isSessionToken(TOKEN)).toBe(true);
    for (const bad of ["", "tws_short", `tws_${"A".repeat(42)}`, `tws_${"A".repeat(44)}`, `xws_${"A".repeat(43)}`, `tws_${"A".repeat(42)}!`, `tws_${"A".repeat(43)}\n`, ` ${TOKEN}`, null, undefined, 5]) expect(isSessionToken(bad as never), String(bad)).toBe(false);
  });
  it("csrf tokens are 43 base64url characters, random per call", () => {
    const a = newCsrfToken(), b = newCsrfToken(); expect(isCsrfToken(a)).toBe(true); expect(a).not.toBe(b); expect(isCsrfToken("short")).toBe(false);
  });
  it("safeEqual compares exactly", () => { expect(safeEqual("abc", "abc")).toBe(true); expect(safeEqual("abc", "abd")).toBe(false); expect(safeEqual("abc", "abcd")).toBe(false); });
});
describe("cookies", () => {
  it("parses a cookie header, first value wins, oversized header ignored", () => {
    expect(parseCookies("a=1; b=2; a=3").get("a")).toBe("1"); expect(parseCookies(null).size).toBe(0); expect(parseCookies("x=" + "y".repeat(9000)).size).toBe(0);
  });
  it("host mode uses __Host- names; dev mode plain names", () => { expect(cookieNames("host")).toEqual({ session: "__Host-twins_session", csrf: "__Host-twins_csrf" }); expect(cookieNames("dev")).toEqual({ session: "twins_session", csrf: "twins_csrf" }); });
  it("the session cookie is HttpOnly, SameSite=Strict, Path=/, Secure in host mode, and has no Domain (what __Host- requires)", () => {
    const o = sessionCookieOptions(cfgHost(), new Date(0)); expect(o).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/" }); expect(o).not.toHaveProperty("domain");
    expect(sessionCookieOptions(cfgDev(), new Date(0)).secure).toBe(false);
  });
  it("the CSRF cookie is readable by the page (double submit) but otherwise equally strict", () => { expect(csrfCookieOptions(cfgHost(), new Date(0))).toMatchObject({ httpOnly: false, secure: true, sameSite: "strict", path: "/" }); });
  it("clearing expires immediately", () => { expect(clearOptions(cfgHost())).toMatchObject({ maxAge: 0, path: "/" }); });
  it("readSession returns only a well-formed token from the configured cookie name", () => {
    expect(readSession(req({ cookie: `__Host-twins_session=${TOKEN}` }), cfgHost())).toBe(TOKEN);
    expect(readSession(req({ cookie: `twins_session=${TOKEN}` }), cfgHost())).toBeNull(); // wrong mode's name
    expect(readSession(req({ cookie: "__Host-twins_session=garbage" }), cfgHost())).toBeNull();
    expect(readSession(req({}), cfgHost())).toBeNull();
  });
});
describe("same-origin check fails CLOSED", () => {
  it("accepts only an Origin equal to the public origin", () => { expect(sameOrigin(req({ origin: ORIGIN }), cfgHost())).toBe(true); });
  it("a missing Origin is a refusal, not a pass", () => { expect(sameOrigin(req({}), cfgHost())).toBe(false); expect(sameOrigin(req({ origin: "" }), cfgHost())).toBe(false); });
  it("refuses 'null', other origins, other schemes/ports and look-alike hosts", () => {
    for (const o of ["null", "https://evil.example", "http://desk.example.test", "https://desk.example.test:8443", "https://desk.example.test.evil.example", "https://desk.example.testx"]) expect(sameOrigin(req({ origin: o }), cfgHost()), o).toBe(false);
  });
  it("refuses Sec-Fetch-Site other than same-origin even with a matching Origin", () => {
    expect(sameOrigin(req({ origin: ORIGIN, "sec-fetch-site": "same-site" }), cfgHost())).toBe(false); expect(sameOrigin(req({ origin: ORIGIN, "sec-fetch-site": "cross-site" }), cfgHost())).toBe(false); expect(sameOrigin(req({ origin: ORIGIN, "sec-fetch-site": "same-origin" }), cfgHost())).toBe(true);
  });
  it("without a configured public origin (dev only) it compares to the origin the browser used (the Host header), falling back to the request URL", () => {
    expect(sameOrigin(req({ origin: ORIGIN }), cfgDev())).toBe(true); expect(sameOrigin(req({ origin: "https://other.test" }), cfgDev())).toBe(false);
    expect(sameOrigin(req({ origin: "https://127.0.0.1:3100", host: "127.0.0.1:3100" }), cfgDev())).toBe(true); // framework URL may say localhost; the browser said 127.0.0.1
    expect(sameOrigin(req({ origin: "https://evil.test", host: "127.0.0.1:3100" }), cfgDev())).toBe(false);
  });
});
describe("CSRF double submit", () => {
  const c = (cookie: string, header?: string) => req({ cookie, ...(header !== undefined ? { "x-csrf-token": header } : {}) });
  it("header must equal the cookie", () => { expect(csrfOk(c(`__Host-twins_csrf=${CSRF}`, CSRF), cfgHost())).toBe(true); expect(csrfOk(c(`__Host-twins_csrf=${CSRF}`, "C".repeat(43)), cfgHost())).toBe(false); });
  it("missing header, missing cookie, or malformed values fail", () => { expect(csrfOk(c(`__Host-twins_csrf=${CSRF}`), cfgHost())).toBe(false); expect(csrfOk(req({ "x-csrf-token": CSRF }), cfgHost())).toBe(false); expect(csrfOk(c("__Host-twins_csrf=bad", "bad"), cfgHost())).toBe(false); });
});
