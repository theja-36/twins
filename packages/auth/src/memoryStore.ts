import { randomUUID } from "node:crypto";
import type { Role, UserId } from "@twins/types";
import type { AuthStore, SessionRecord, UserRecord } from "./service";

/** In-memory AuthStore for tests and local rehearsal. Mirrors the SQL door's rules (actor must be an active ADMIN, no self-change, last-admin protection) so unit tests exercise the same behaviour. */
export function memoryAuthStore(): AuthStore & { users: Map<string, UserRecord>; sessions: Map<string, SessionRecord> } {
  const users = new Map<string, UserRecord>(), sessions = new Map<string, SessionRecord>(), failures = new Map<string, Date[]>();
  const activeAdmins = (): number => [...users.values()].filter((u) => u.role === "ADMIN" && u.isActive).length;
  const actorOk = (actorId: UserId, targetId: UserId): boolean => { const a = users.get(actorId); return !!a && a.isActive && a.role === "ADMIN" && actorId !== targetId; };
  return {
    users, sessions,
    async findUserByEmail(email) { const u = [...users.values()].find((x) => x.email === email); return u ? { ...u } : null; },
    async findUserById(id) { const u = users.get(id); return u ? { ...u } : null; },
    async createUser(u) { if ([...users.values()].some((x) => x.email === u.email)) return null; const r: UserRecord = { id: randomUUID() as UserId, email: u.email, passwordHash: u.passwordHash, displayName: u.displayName, role: u.role, isActive: true }; users.set(r.id, r); return r; },
    async countActiveAdmins() { return activeAdmins(); },
    async setPasswordHash(id, h) { const u = users.get(id); if (u) u.passwordHash = h; },
    async setRole(actorId: UserId, targetId: UserId, role: Role) { const t = users.get(targetId); if (!t || !actorOk(actorId, targetId)) return false; if (t.role === "ADMIN" && role !== "ADMIN" && t.isActive && activeAdmins() <= 1) return false; t.role = role; return true; },
    async setActive(actorId, targetId, active) { const t = users.get(targetId); if (!t || !actorOk(actorId, targetId)) return false; if (!active && t.role === "ADMIN" && t.isActive && activeAdmins() <= 1) return false; t.isActive = active; return true; },
    async createSession(s) { const r: SessionRecord = { id: randomUUID(), userId: s.userId, tokenHash: s.tokenHash, createdAt: s.createdAt, expiresAt: s.expiresAt, revokedAt: null, lastSeenAt: null }; sessions.set(r.id, r); return r; },
    async findSessionByTokenHash(h) { return [...sessions.values()].find((s) => s.tokenHash === h) ?? null; },
    async touchSession(id, expiresAt, seenAt) { const s = sessions.get(id); if (s) { s.expiresAt = expiresAt; s.lastSeenAt = seenAt; } },
    async revokeSession(id, at) { const s = sessions.get(id); if (s && !s.revokedAt) s.revokedAt = at; },
    async revokeUserSessions(userId, at, except) { let n = 0; for (const s of sessions.values()) if (s.userId === userId && s.id !== except && !s.revokedAt) { s.revokedAt = at; n++; } return n; },
    async recordLoginFailure(key, at) { failures.set(key, [...(failures.get(key) ?? []), at]); },
    async countLoginFailures(key, since) { return (failures.get(key) ?? []).filter((d) => d >= since).length; },
    async clearLoginFailures(key) { failures.delete(key); },
  };
}
