import type { UserId } from "./ids";
import { PlatformError } from "./errors";

/**
 * Authorisation model (ADR-003). Pure functions, so the isolation rules are testable without a database; the same rules are repeated in row-level security.
 * ADMIN manages users and reads audit but has NO access to another user's private trading data.
 */
export const ROLES = ["ADMIN", "TRADER"] as const;
export type Role = (typeof ROLES)[number];
export type Principal = { kind: "user"; userId: UserId; roles: readonly Role[] } | { kind: "system"; service: string };

/** Permissions on shared platform intelligence. */
export const SHARED_PERMISSIONS = ["signals:read", "research:read", "market:read", "strategies:read", "opportunities:read", "channels:read"] as const;
/**
 * Permissions on private, user-owned data: only the owner ever holds these, on their own resources.
 * Reads and writes are separate permissions (capital, risk-policy, broker, orders). On decisions: `decisions:read` only reads; `decisions:watch` appends to the owner's private bookmark list and nothing else; `decisions:approve` is the only one that
 * can approve, reject or cancel. Holding one never implies another.
 */
export const PRIVATE_PERMISSIONS = ["capital:read", "capital:write", "risk-policy:read", "risk-policy:write", "broker:read", "broker:write", "orders:read", "orders:write", "positions:read", "decisions:approve", "trades:read", "analytics:read", "settings:write", "decisions:read", "decisions:watch", "risk:read"] as const;
export const ADMIN_PERMISSIONS = ["users:manage", "audit:read", "channels:manage", "system:read"] as const;
export type Permission = (typeof SHARED_PERMISSIONS)[number] | (typeof PRIVATE_PERMISSIONS)[number] | (typeof ADMIN_PERMISSIONS)[number];

const PRIVATE = new Set<string>(PRIVATE_PERMISSIONS);
export const isPrivatePermission = (p: Permission): boolean => PRIVATE.has(p);
const ROLE_PERMS: Record<Role, readonly Permission[]> = { TRADER: [...SHARED_PERMISSIONS, ...PRIVATE_PERMISSIONS], ADMIN: [...SHARED_PERMISSIONS, ...ADMIN_PERMISSIONS] };

/** Whether the principal holds the permission at all (ownership of a specific resource is checked separately). */
export function hasPermission(p: Principal, perm: Permission): boolean {
  if (p.kind === "system") return !isPrivatePermission(perm); // services never act as a user; they pass a userId explicitly
  return p.roles.some((r) => ROLE_PERMS[r].includes(perm));
}

/**
 * The one authorisation check for private resources: the principal must hold the permission AND be the owner. Anything else is NOT_FOUND (existence is not leaked).
 * Shared permissions need no owner.
 */
export function authorize(p: Principal | null, perm: Permission, resourceOwner?: UserId | null): void {
  if (p === null) throw new PlatformError("UNAUTHENTICATED", "authentication required");
  if (!hasPermission(p, perm)) throw new PlatformError(isPrivatePermission(perm) ? "NOT_FOUND" : "FORBIDDEN", isPrivatePermission(perm) ? "not found" : "not permitted");
  if (!isPrivatePermission(perm)) return;
  if (p.kind !== "user" || resourceOwner == null || p.userId !== resourceOwner) throw new PlatformError("NOT_FOUND", "not found");
}

/** Rows to scope a query to: a user sees only their own rows. Used by every repository function that returns private data. */
export function ownerScope(p: Principal | null): UserId {
  if (p === null) throw new PlatformError("UNAUTHENTICATED", "authentication required");
  if (p.kind !== "user") throw new PlatformError("FORBIDDEN", "a user principal is required for private data");
  return p.userId;
}
