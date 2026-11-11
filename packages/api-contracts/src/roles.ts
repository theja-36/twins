/**
 * Roles and permissions, MIRRORED from `packages/types/src/platform/auth.ts` (`SHARED_PERMISSIONS`, `PRIVATE_PERMISSIONS`, `ADMIN_PERMISSIONS`, `ROLE_PERMS`).
 * Parity is enforced by tests/unit/api-contracts/rolesParity.test.ts, which compares this table with the backend's own `hasPermission` for every role and permission.
 *
 * USER-EXPERIENCE ONLY. The backend decides what is allowed; the browser uses this table only to decide what to RENDER. It is never an authorisation check.
 * Verified fact: an ADMIN holds NO private permission. A private route called without the permission answers 404 (existence is not leaked), never 403.
 */
export const ROLES = ["TRADER", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const SHARED_PERMISSIONS = ["signals:read", "research:read", "market:read", "strategies:read", "opportunities:read", "channels:read"] as const;
export const PRIVATE_PERMISSIONS = ["capital:read", "capital:write", "risk-policy:read", "risk-policy:write", "broker:read", "broker:write", "orders:read", "orders:write", "positions:read", "decisions:approve", "trades:read", "analytics:read", "settings:write", "decisions:read", "decisions:watch", "risk:read"] as const;
export const ADMIN_PERMISSIONS = ["users:manage", "audit:read", "channels:manage", "system:read"] as const;
export type SharedPermission = (typeof SHARED_PERMISSIONS)[number];
export type PrivatePermission = (typeof PRIVATE_PERMISSIONS)[number];
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];
export type Permission = SharedPermission | PrivatePermission | AdminPermission;
export const ALL_PERMISSIONS: readonly Permission[] = [...SHARED_PERMISSIONS, ...PRIVATE_PERMISSIONS, ...ADMIN_PERMISSIONS];

/** TRADER = shared + private. ADMIN = shared + admin (no private permission). */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  TRADER: [...SHARED_PERMISSIONS, ...PRIVATE_PERMISSIONS],
  ADMIN: [...SHARED_PERMISSIONS, ...ADMIN_PERMISSIONS],
};

const PRIVATE = new Set<string>(PRIVATE_PERMISSIONS);
export const isPrivatePermission = (p: Permission): boolean => PRIVATE.has(p);
/** Whether the role holds the permission at all (UX gating; the backend re-checks every request). */
export const roleHasPermission = (role: Role, p: Permission): boolean => ROLE_PERMISSIONS[role].includes(p);
