import { describe, expect, it } from "vitest";
import { PlatformError } from "@twins/types";
import { AuthService, failureKey, hashPassword, hashSessionToken, memoryAuthStore, needsRehash, newSessionToken, passwordProblems, verifyPassword, type AuthEvent } from "@twins/auth";

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PW = "correct horse battery staple";
function setup(over: Record<string, unknown> = {}) {
  const store = memoryAuthStore(), events: AuthEvent[] = [];
  let t = new Date("2031-01-06T05:00:00Z");
  const svc = new AuthService({ store, audit: async (e) => { events.push(e); }, now: () => t, config: { scrypt: FAST, registrationOpen: true, ...over } });
  return { svc, store, events, advance: (s: number) => { t = new Date(t.getTime() + s * 1000); } };
}
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "no error"; } catch (e) { return e instanceof PlatformError ? e.code : "OTHER"; } };

describe("password hashing", () => {
  it("round-trips, salts every hash, and rejects the wrong password", async () => {
    const a = await hashPassword(PW, FAST), b = await hashPassword(PW, FAST);
    expect(a).not.toBe(b); expect(a).not.toContain(PW);
    expect(await verifyPassword(PW, a)).toBe(true); expect(await verifyPassword(PW + "x", a)).toBe(false);
  });
  it("malformed or hostile stored hashes verify false and never throw", async () => {
    for (const bad of ["", "plain", "scrypt$1$1$1$a$b", "scrypt$3$8$1$AAAAAAAAAAAAAAAA$AAAA", "md5$x$y", "scrypt$1048576000$8$1$AAAAAAAAAAAAAAAA$AAAA"]) expect(await verifyPassword(PW, bad)).toBe(false);
  });
  it("flags hashes with weaker parameters for re-hash", async () => { expect(needsRehash(await hashPassword(PW, FAST))).toBe(true); expect(needsRehash("junk")).toBe(true); });
  it("enforces the policy", () => {
    expect(passwordProblems(PW, "a@b.co")).toEqual([]);
    expect(passwordProblems("short", "a@b.co")).toContain("at least 12 characters");
    expect(passwordProblems("aaaaaaaaaaaaaa", "a@b.co")).toContain("not a single repeated character");
    expect(passwordProblems("Password1234", "a@b.co")).toContain("not a commonly used password");
    expect(passwordProblems("sara-trader-secret!", "sara.trader@example.com")).toEqual([]);
    expect(passwordProblems("my-sara-password-1", "sara@example.com")).toContain("must not contain your email name");
  });
});

describe("registration and administration", () => {
  it("registration is closed by default and creates only TRADERs when open", async () => {
    expect(await code(setup({ registrationOpen: false }).svc.register({ email: "a@example.com", password: PW }))).toBe("FORBIDDEN");
    const { svc } = setup();
    const u = await svc.register({ email: " A@Example.com ", password: PW, displayName: "A" });
    expect(u).toMatchObject({ email: "a@example.com", role: "TRADER", isActive: true });
    expect(JSON.stringify(u)).not.toMatch(/hash|scrypt/);
  });
  it("a role supplied by an ordinary caller is ignored (registration has no role input)", async () => {
    const { svc } = setup();
    const u = await svc.register({ email: "x@example.com", password: PW, role: "ADMIN" } as never);
    expect(u.role).toBe("TRADER");
  });
  it("rejects duplicates, bad emails and weak passwords", async () => {
    const { svc } = setup();
    await svc.register({ email: "a@example.com", password: PW });
    expect(await code(svc.register({ email: "A@example.com", password: PW }))).toBe("CONFLICT");
    expect(await code(svc.register({ email: "nope", password: PW }))).toBe("VALIDATION");
    expect(await code(svc.register({ email: "b@example.com", password: "short" }))).toBe("VALIDATION");
  });
  it("the first administrator can be bootstrapped exactly once", async () => {
    const { svc } = setup({ registrationOpen: false });
    expect((await svc.bootstrapAdmin({ email: "root@example.com", password: PW })).role).toBe("ADMIN");
    expect(await code(svc.bootstrapAdmin({ email: "root2@example.com", password: PW }))).toBe("CONFLICT");
  });
  it("only an ADMIN can create users; a TRADER and an anonymous caller cannot", async () => {
    const { svc } = setup({ registrationOpen: false });
    const admin = await svc.bootstrapAdmin({ email: "root@example.com", password: PW });
    const adminP = { kind: "user", userId: admin.id, roles: ["ADMIN"] } as const;
    const t = await svc.adminCreateUser(adminP, { email: "t@example.com", password: PW });
    expect(t.role).toBe("TRADER");
    const traderP = { kind: "user", userId: t.id, roles: ["TRADER"] } as const;
    expect(await code(svc.adminCreateUser(traderP, { email: "u@example.com", password: PW }))).toBe("FORBIDDEN");
    expect(await code(svc.adminCreateUser(null, { email: "u@example.com", password: PW }))).toBe("UNAUTHENTICATED");
  });
});

describe("login and sessions", () => {
  it("logs in, returns an opaque token, stores only its hash, and authenticates it", async () => {
    const { svc, store } = setup();
    const u = await svc.register({ email: "a@example.com", password: PW });
    const r = await svc.login({ email: "A@example.com", password: PW });
    expect(r.token).toMatch(/^tws_/); expect(r.user.id).toBe(u.id);
    const stored = [...store.sessions.values()][0]!;
    expect(stored.tokenHash).toBe(hashSessionToken(r.token)); expect(JSON.stringify([...store.sessions.values()])).not.toContain(r.token);
    const a = await svc.authenticate(r.token);
    expect(a.principal).toEqual({ kind: "user", userId: u.id, roles: ["TRADER"] });
  });
  it("wrong password, unknown user and inactive user are indistinguishable", async () => {
    const { svc, store } = setup(); const u = await svc.register({ email: "a@example.com", password: PW });
    const msgs = new Set<string>();
    for (const [email, pw] of [["a@example.com", "wrong-password-123"], ["nobody@example.com", PW]] as const) { try { await svc.login({ email, password: pw }); } catch (e) { msgs.add(`${(e as PlatformError).code}:${(e as Error).message}`); } }
    store.users.get(u.id)!.isActive = false;
    try { await svc.login({ email: "a@example.com", password: PW }); } catch (e) { msgs.add(`${(e as PlatformError).code}:${(e as Error).message}`); }
    expect([...msgs]).toEqual(["UNAUTHENTICATED:invalid credentials"]);
  });
  it("locks an email out after repeated failures, then recovers after the window; success clears the count", async () => {
    const { svc, advance } = setup({ maxLoginFailures: 3, lockoutSeconds: 600 });
    await svc.register({ email: "a@example.com", password: PW });
    for (let i = 0; i < 3; i++) expect(await code(svc.login({ email: "a@example.com", password: "bad-password-123" }))).toBe("UNAUTHENTICATED");
    expect(await code(svc.login({ email: "a@example.com", password: PW }))).toBe("FORBIDDEN"); // even the right password is refused while locked
    advance(601);
    expect(await code(svc.login({ email: "a@example.com", password: PW }))).toBe("no error");
  });
  it("sessions expire when idle, slide on use, and stop at the absolute maximum", async () => {
    const { svc, advance } = setup({ sessionIdleSeconds: 1000, sessionMaxSeconds: 2500 });
    await svc.register({ email: "a@example.com", password: PW });
    const { token } = await svc.login({ email: "a@example.com", password: PW });
    advance(900); await svc.authenticate(token);       // renewed to now+1000
    advance(900); await svc.authenticate(token);       // still valid because it slid
    advance(900); expect(await code(svc.authenticate(token))).toBe("UNAUTHENTICATED"); // 2700 s > absolute 2500 s
  });
  it("an idle session expires", async () => {
    const { svc, advance } = setup({ sessionIdleSeconds: 100 });
    await svc.register({ email: "a@example.com", password: PW }); const { token } = await svc.login({ email: "a@example.com", password: PW });
    advance(101); expect(await code(svc.authenticate(token))).toBe("UNAUTHENTICATED");
  });
  it("logout revokes the session; garbage and foreign-prefix tokens never authenticate", async () => {
    const { svc } = setup(); await svc.register({ email: "a@example.com", password: PW });
    const { token } = await svc.login({ email: "a@example.com", password: PW });
    await svc.logout(token); expect(await code(svc.authenticate(token))).toBe("UNAUTHENTICATED");
    for (const bad of [undefined, null, "", "Bearer x", "test-api-key-default", newSessionToken()]) expect(await code(svc.authenticate(bad as never))).toBe("UNAUTHENTICATED");
  });
  it("a deactivated user's existing session stops working", async () => {
    const { svc, store } = setup({ registrationOpen: true });
    const u = await svc.register({ email: "a@example.com", password: PW }); const { token } = await svc.login({ email: "a@example.com", password: PW });
    store.users.get(u.id)!.isActive = false; expect(await code(svc.authenticate(token))).toBe("UNAUTHENTICATED");
  });
  it("changing the password signs out every other session but keeps this one", async () => {
    const { svc } = setup(); await svc.register({ email: "a@example.com", password: PW });
    const one = await svc.login({ email: "a@example.com", password: PW }), two = await svc.login({ email: "a@example.com", password: PW });
    const auth = await svc.authenticate(one.token);
    expect(await code(svc.changePassword(auth, { currentPassword: "wrong-password-123", newPassword: "another long password 1" }))).toBe("UNAUTHENTICATED");
    await svc.changePassword(auth, { currentPassword: PW, newPassword: "another long password 1" });
    expect(await code(svc.authenticate(one.token))).toBe("no error"); expect(await code(svc.authenticate(two.token))).toBe("UNAUTHENTICATED");
    expect(await code(svc.login({ email: "a@example.com", password: PW }))).toBe("UNAUTHENTICATED");
    expect(await code(svc.login({ email: "a@example.com", password: "another long password 1" }))).toBe("no error");
  });
});

describe("role changes (G-13)", () => {
  async function trio() {
    const s = setup({ registrationOpen: false });
    const admin = await s.svc.bootstrapAdmin({ email: "root@example.com", password: PW });
    const adminP = { kind: "user", userId: admin.id, roles: ["ADMIN"] } as const;
    const t = await s.svc.adminCreateUser(adminP, { email: "t@example.com", password: PW });
    const traderP = { kind: "user", userId: t.id, roles: ["TRADER"] } as const;
    return { ...s, admin, adminP, t, traderP };
  }
  it("a TRADER can never change any role, including their own", async () => {
    const { svc, t, admin, traderP } = await trio();
    expect(await code(svc.changeRole(traderP, t.id, "ADMIN"))).toBe("FORBIDDEN");
    expect(await code(svc.changeRole(traderP, admin.id, "TRADER"))).toBe("FORBIDDEN");
    expect(await code(svc.setActive(traderP, admin.id, false))).toBe("FORBIDDEN");
  });
  it("an anonymous caller cannot", async () => { const { svc, t } = await trio(); expect(await code(svc.changeRole(null, t.id, "ADMIN"))).toBe("UNAUTHENTICATED"); });
  it("an ADMIN cannot change their own role or active state", async () => {
    const { svc, admin, adminP } = await trio();
    expect(await code(svc.changeRole(adminP, admin.id, "TRADER"))).toBe("FORBIDDEN"); expect(await code(svc.setActive(adminP, admin.id, false))).toBe("FORBIDDEN");
  });
  it("an ADMIN can promote a TRADER; the target's sessions are revoked and the change is audited", async () => {
    const { svc, t, adminP, events, store } = await trio();
    await svc.adminCreateUser(adminP, { email: "x@example.com", password: PW });
    store.users.get(t.id)!; const login = await svc.login({ email: "t@example.com", password: PW });
    await svc.changeRole(adminP, t.id, "ADMIN");
    expect(store.users.get(t.id)!.role).toBe("ADMIN");
    expect(await code(svc.authenticate(login.token))).toBe("UNAUTHENTICATED");
    expect(events.find((e) => e.type === "auth.role_changed")).toMatchObject({ targetId: t.id, detail: { from: "TRADER", to: "ADMIN" } });
  });
  it("the last active ADMIN can never be demoted or deactivated, even by another (soon demoted) admin path", async () => {
    const { svc, admin, adminP, t } = await trio();
    await svc.changeRole(adminP, t.id, "ADMIN");
    const secondP = { kind: "user", userId: t.id, roles: ["ADMIN"] } as const;
    await svc.changeRole(secondP, admin.id, "TRADER");                       // allowed: two admins existed
    expect(await code(svc.changeRole(adminP, t.id, "TRADER"))).toBe("CONFLICT"); // even with a stale admin principal, the last administrator is protected
    expect(await code(svc.setActive({ kind: "user", userId: t.id, roles: ["ADMIN"] }, admin.id, false))).toBe("no error");
  });
  it("the store itself refuses privileged changes from a non-admin actor (defence in depth, mirrored by the SQL door)", async () => {
    const { store, t, admin } = await trio();
    expect(await store.setRole(t.id, admin.id, "TRADER")).toBe(false); expect(await store.setRole(admin.id, admin.id, "TRADER")).toBe(false);
  });
});

describe("audit safety", () => {
  it("no event or error ever contains a password, hash or token", async () => {
    const { svc, events } = setup(); await svc.register({ email: "a@example.com", password: PW });
    const r = await svc.login({ email: "a@example.com", password: PW }); try { await svc.login({ email: "a@example.com", password: "wrong-password-123" }); } catch { /* expected */ }
    const dump = JSON.stringify(events);
    for (const secret of [PW, "wrong-password-123", r.token, "scrypt$"]) expect(dump).not.toContain(secret);
    expect(failureKey("A@Example.com")).toBe(failureKey(" a@example.com ")); expect(failureKey("a@example.com")).not.toContain("example");
  });
});
