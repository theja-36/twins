import { PlatformError, ROLES, type Principal, type Role, type UserId } from "@twins/types";
import { hashPassword, needsRehash, passwordProblems, verifyPassword, DEFAULT_SCRYPT, type ScryptParams } from "./password";
import { failureKey, hashSessionToken, looksLikeSessionToken, newSessionToken } from "./tokens";

/**
 * The authentication and account service (Stage 01, ADR-003). It owns: registration, login, sessions (renewal, expiry, revocation), password change, and privileged role / active changes.
 * Rules that cannot be bypassed from any route:
 *  - a role is NEVER taken from a request by ordinary registration or profile calls; only an ADMIN, acting on someone else, can change a role or an active flag (G-13);
 *  - the last active ADMIN can never be demoted or deactivated;
 *  - failures are generic ("invalid credentials"): unknown user, wrong password and inactive user are indistinguishable, and cost the same time;
 *  - every security-relevant event is sent to the audit sink; no password, hash or token is ever placed in an event or error.
 */
export interface UserRecord { id: UserId; email: string; passwordHash: string; displayName: string | null; role: Role; isActive: boolean }
export interface PublicUser { id: UserId; email: string; displayName: string | null; role: Role; isActive: boolean }
export interface SessionRecord { id: string; userId: UserId; tokenHash: string; createdAt: Date; expiresAt: Date; revokedAt: Date | null; lastSeenAt: Date | null }
export interface AuthEvent { type: string; actorId: UserId | null; targetId: UserId | null; detail: Record<string, string | number | boolean | null> }

/** Persistence. The SQL implementation (packages/database authStore) performs role and active changes only through SECURITY DEFINER functions that re-check the rules in the database. */
export interface AuthStore {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: UserId): Promise<UserRecord | null>;
  /** Returns null when the email already exists (never throws for a duplicate). */
  createUser(u: { email: string; passwordHash: string; displayName: string | null; role: Role; actorId: UserId | null }): Promise<UserRecord | null>;
  countActiveAdmins(): Promise<number>;
  setPasswordHash(userId: UserId, passwordHash: string): Promise<void>;
  /** Privileged change: the store must enforce actor-is-active-ADMIN, actor != target and last-admin protection itself (the SQL door does); returns false when refused. */
  setRole(actorId: UserId, targetId: UserId, role: Role): Promise<boolean>;
  setActive(actorId: UserId, targetId: UserId, active: boolean): Promise<boolean>;
  createSession(s: { userId: UserId; tokenHash: string; createdAt: Date; expiresAt: Date }): Promise<SessionRecord>;
  findSessionByTokenHash(hash: string): Promise<SessionRecord | null>;
  touchSession(id: string, expiresAt: Date, seenAt: Date): Promise<void>;
  revokeSession(id: string, at: Date): Promise<void>;
  revokeUserSessions(userId: UserId, at: Date, exceptSessionId?: string): Promise<number>;
  recordLoginFailure(key: string, at: Date): Promise<void>;
  countLoginFailures(key: string, since: Date): Promise<number>;
  clearLoginFailures(key: string): Promise<void>;
}
export type AuditSink = (e: AuthEvent) => Promise<void>;

export interface AuthConfig {
  /** Ordinary self-registration. Default false: a private platform creates users through an ADMIN. */
  registrationOpen: boolean;
  sessionIdleSeconds: number; sessionMaxSeconds: number;
  maxLoginFailures: number; lockoutSeconds: number;
  scrypt: ScryptParams;
}
export const DEFAULT_AUTH_CONFIG: AuthConfig = { registrationOpen: false, sessionIdleSeconds: 60 * 60 * 8, sessionMaxSeconds: 60 * 60 * 24 * 7, maxLoginFailures: 5, lockoutSeconds: 15 * 60, scrypt: DEFAULT_SCRYPT };

export interface AuthDeps { store: AuthStore; audit: AuditSink; now?: () => Date; config?: Partial<AuthConfig> }
export interface Authenticated { principal: Principal; user: PublicUser; sessionId: string }
export interface LoginResult { token: string; expiresAt: Date; user: PublicUser }

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const publicUser = (u: UserRecord): PublicUser => ({ id: u.id, email: u.email, displayName: u.displayName, role: u.role, isActive: u.isActive });
export const normaliseEmail = (e: string): string => e.trim().toLowerCase();
const generic = (): PlatformError => new PlatformError("UNAUTHENTICATED", "invalid credentials");
const DUMMY_HASH_PW = "dummy-password-for-timing-equalisation";

export class AuthService {
  private readonly store: AuthStore; private readonly audit: AuditSink; private readonly now: () => Date; readonly config: AuthConfig;
  private dummy: Promise<string> | null = null;
  constructor(d: AuthDeps) { this.store = d.store; this.audit = d.audit; this.now = d.now ?? (() => new Date()); this.config = { ...DEFAULT_AUTH_CONFIG, ...d.config }; }
  private dummyHash(): Promise<string> { return (this.dummy ??= hashPassword(DUMMY_HASH_PW, this.config.scrypt)); }
  private principalOf(u: UserRecord): Principal { return { kind: "user", userId: u.id, roles: [u.role] }; }
  private requireAdmin(actor: Principal | null): UserId {
    if (actor === null) throw new PlatformError("UNAUTHENTICATED", "authentication required");
    if (actor.kind !== "user" || !actor.roles.includes("ADMIN")) throw new PlatformError("FORBIDDEN", "not permitted");
    return actor.userId;
  }
  private validateNew(email: string, password: string): string {
    const e = normaliseEmail(email);
    if (!EMAIL.test(e)) throw new PlatformError("VALIDATION", "a valid email is required");
    const problems = passwordProblems(password, e);
    if (problems.length) throw new PlatformError("VALIDATION", "password does not meet the policy", problems);
    return e;
  }
  private async create(email: string, password: string, displayName: string | null, role: Role, actorId: UserId | null, event: string): Promise<PublicUser> {
    const e = this.validateNew(email, password);
    const u = await this.store.createUser({ email: e, passwordHash: await hashPassword(password, this.config.scrypt), displayName: displayName?.trim().slice(0, 80) || null, role, actorId });
    if (!u) throw new PlatformError("CONFLICT", "that email is already registered");
    await this.audit({ type: event, actorId, targetId: u.id, detail: { role } });
    return publicUser(u);
  }

  /** Ordinary registration: always a TRADER, never a role from the caller, and only when registration is open. */
  async register(i: { email: string; password: string; displayName?: string | null }): Promise<PublicUser> {
    if (!this.config.registrationOpen) throw new PlatformError("FORBIDDEN", "registration is closed; ask an administrator to create your account");
    return this.create(i.email, i.password, i.displayName ?? null, "TRADER", null, "auth.user_registered");
  }
  /** First administrator, for the owner-run bootstrap command only: refused if any active ADMIN exists. */
  async bootstrapAdmin(i: { email: string; password: string; displayName?: string | null }): Promise<PublicUser> {
    if ((await this.store.countActiveAdmins()) > 0) throw new PlatformError("CONFLICT", "an administrator already exists");
    return this.create(i.email, i.password, i.displayName ?? null, "ADMIN", null, "auth.admin_bootstrapped");
  }
  async adminCreateUser(actor: Principal | null, i: { email: string; password: string; displayName?: string | null; role?: Role }): Promise<PublicUser> {
    const actorId = this.requireAdmin(actor), role = i.role ?? "TRADER";
    if (!ROLES.includes(role)) throw new PlatformError("VALIDATION", "unknown role");
    return this.create(i.email, i.password, i.displayName ?? null, role, actorId, "auth.user_created_by_admin");
  }

  async login(i: { email: string; password: string }): Promise<LoginResult> {
    const email = normaliseEmail(i.email), key = failureKey(email), now = this.now();
    const since = new Date(now.getTime() - this.config.lockoutSeconds * 1000);
    if ((await this.store.countLoginFailures(key, since)) >= this.config.maxLoginFailures) {
      await this.audit({ type: "auth.login_locked", actorId: null, targetId: null, detail: {} });
      throw new PlatformError("FORBIDDEN", "too many attempts, try again later");
    }
    const user = await this.store.findUserByEmail(email);
    const ok = await verifyPassword(i.password, user?.passwordHash ?? (await this.dummyHash()));
    if (!user || !ok || !user.isActive) {
      await this.store.recordLoginFailure(key, now);
      await this.audit({ type: "auth.login_failed", actorId: null, targetId: user?.id ?? null, detail: { inactive: !!user && ok && !user.isActive } });
      throw generic();
    }
    await this.store.clearLoginFailures(key);
    if (needsRehash(user.passwordHash, this.config.scrypt)) await this.store.setPasswordHash(user.id, await hashPassword(i.password, this.config.scrypt));
    const token = newSessionToken(), expiresAt = new Date(now.getTime() + this.config.sessionIdleSeconds * 1000);
    await this.store.createSession({ userId: user.id, tokenHash: hashSessionToken(token), createdAt: now, expiresAt });
    await this.audit({ type: "auth.login", actorId: user.id, targetId: user.id, detail: {} });
    return { token, expiresAt, user: publicUser(user) };
  }

  /** Resolves a bearer session token to a principal, sliding the idle expiry up to the absolute maximum. Every failure is the same UNAUTHENTICATED. */
  async authenticate(token: string | null | undefined): Promise<Authenticated> {
    if (!token || !looksLikeSessionToken(token)) throw new PlatformError("UNAUTHENTICATED", "authentication required");
    const s = await this.store.findSessionByTokenHash(hashSessionToken(token)), now = this.now();
    if (!s || s.revokedAt !== null || s.expiresAt.getTime() <= now.getTime() || now.getTime() >= s.createdAt.getTime() + this.config.sessionMaxSeconds * 1000) throw new PlatformError("UNAUTHENTICATED", "authentication required");
    const u = await this.store.findUserById(s.userId);
    if (!u || !u.isActive) throw new PlatformError("UNAUTHENTICATED", "authentication required");
    const slide = Math.min(now.getTime() + this.config.sessionIdleSeconds * 1000, s.createdAt.getTime() + this.config.sessionMaxSeconds * 1000);
    if (slide - s.expiresAt.getTime() > 60_000) await this.store.touchSession(s.id, new Date(slide), now); // at most one write a minute
    return { principal: this.principalOf(u), user: publicUser(u), sessionId: s.id };
  }
  async logout(token: string | null | undefined): Promise<void> {
    if (!token || !looksLikeSessionToken(token)) return;
    const s = await this.store.findSessionByTokenHash(hashSessionToken(token));
    if (s && s.revokedAt === null) { await this.store.revokeSession(s.id, this.now()); await this.audit({ type: "auth.logout", actorId: s.userId, targetId: s.userId, detail: {} }); }
  }
  async changePassword(a: Authenticated, i: { currentPassword: string; newPassword: string }): Promise<void> {
    const u = await this.store.findUserById(a.user.id);
    if (!u || !(await verifyPassword(i.currentPassword, u.passwordHash))) { await this.audit({ type: "auth.password_change_failed", actorId: a.user.id, targetId: a.user.id, detail: {} }); throw generic(); }
    const problems = passwordProblems(i.newPassword, u.email);
    if (problems.length) throw new PlatformError("VALIDATION", "password does not meet the policy", problems);
    await this.store.setPasswordHash(u.id, await hashPassword(i.newPassword, this.config.scrypt));
    const n = await this.store.revokeUserSessions(u.id, this.now(), a.sessionId); // every other device is signed out
    await this.audit({ type: "auth.password_changed", actorId: u.id, targetId: u.id, detail: { sessionsRevoked: n } });
  }

  /** G-13: the only way a role changes. An ADMIN acts on someone else; the SQL door repeats every rule. */
  async changeRole(actor: Principal | null, targetId: UserId, role: Role): Promise<void> {
    const actorId = this.requireAdmin(actor);
    if (!ROLES.includes(role)) throw new PlatformError("VALIDATION", "unknown role");
    if (actorId === targetId) throw new PlatformError("FORBIDDEN", "you cannot change your own role");
    const t = await this.store.findUserById(targetId);
    if (!t) throw new PlatformError("NOT_FOUND", "not found");
    if (t.role === "ADMIN" && role !== "ADMIN" && t.isActive && (await this.store.countActiveAdmins()) <= 1) throw new PlatformError("CONFLICT", "the last administrator cannot be demoted");
    if (!(await this.store.setRole(actorId, targetId, role))) throw new PlatformError("FORBIDDEN", "not permitted");
    await this.store.revokeUserSessions(targetId, this.now()); // a changed role never keeps an old session
    await this.audit({ type: "auth.role_changed", actorId, targetId, detail: { from: t.role, to: role } });
  }
  async setActive(actor: Principal | null, targetId: UserId, active: boolean): Promise<void> {
    const actorId = this.requireAdmin(actor);
    if (actorId === targetId) throw new PlatformError("FORBIDDEN", "you cannot change your own active state");
    const t = await this.store.findUserById(targetId);
    if (!t) throw new PlatformError("NOT_FOUND", "not found");
    if (!active && t.role === "ADMIN" && t.isActive && (await this.store.countActiveAdmins()) <= 1) throw new PlatformError("CONFLICT", "the last administrator cannot be deactivated");
    if (!(await this.store.setActive(actorId, targetId, active))) throw new PlatformError("FORBIDDEN", "not permitted");
    if (!active) await this.store.revokeUserSessions(targetId, this.now());
    await this.audit({ type: active ? "auth.user_activated" : "auth.user_deactivated", actorId, targetId, detail: {} });
  }
}
