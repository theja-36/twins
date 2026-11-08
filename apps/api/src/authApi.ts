import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PlatformError, ROLES, toErrorBody, type Principal, type Role } from "@twins/types";
import type { AuthService, Authenticated } from "@twins/auth";

/**
 * Account and session API (Stage 01). These routes use SESSION tokens (`Authorization: Bearer tws_...`), never the shared service API key; the service key cannot log in, cannot act as a user and is not accepted here.
 *  - Bodies are strict: an unknown field is a validation error. In particular a `role`, `isAdmin` or `isActive` field on registration, login, profile or password calls is REFUSED, not ignored (G-13).
 *  - Privileged actions (create a user, change a role, activate/deactivate) require an ADMIN session and are re-checked in the database doors (migration 0040).
 *  - Errors are fixed codes and fixed messages (no driver text, no value echo); a failed login is always the same answer.
 */
export function bearerSessionToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token, extra] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token && extra === undefined ? token : null;
}
/** The one way a route turns a request into a user principal. Throws UNAUTHENTICATED. Other user-scoped routes call this, then `ownerScope(principal)`. */
export async function requireSession(auth: AuthService, request: FastifyRequest): Promise<Authenticated> {
  return auth.authenticate(bearerSessionToken(request.headers.authorization));
}
export const requireAdmin = (a: Authenticated): Principal => {
  if (!a.principal || a.principal.kind !== "user" || !a.principal.roles.includes("ADMIN")) throw new PlatformError("FORBIDDEN", "not permitted");
  return a.principal;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function strict(body: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new PlatformError("VALIDATION", "a JSON object is required");
  const b = body as Record<string, unknown>, extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length) throw new PlatformError("VALIDATION", "unknown field", extra.map((k) => `not allowed: ${k.slice(0, 40)}`));
  for (const k of required) if (b[k] === undefined) throw new PlatformError("VALIDATION", "missing field", [`required: ${k}`]);
  return b;
}
const str = (v: unknown, name: string, max = 256): string => { if (typeof v !== "string" || v.length === 0 || v.length > max) throw new PlatformError("VALIDATION", "invalid field", [`invalid: ${name}`]); return v; };

export function registerAuthRoutes(app: FastifyInstance, deps: { auth: AuthService }): void {
  const { auth } = deps;
  const send = (reply: FastifyReply, e: unknown): FastifyReply => { const { status, body } = toErrorBody(e); return reply.code(status).send(body); };
  const route = <B = unknown, P = Record<string, string>>(method: "get" | "post", path: string, h: (req: FastifyRequest<{ Body: B; Params: P }>, reply: FastifyReply) => Promise<unknown>): void => {
    const wrapped = async (req: FastifyRequest<{ Body: B; Params: P }>, reply: FastifyReply): Promise<unknown> => { try { return await h(req, reply); } catch (e) { return send(reply, e); } };
    if (method === "get") app.get<{ Body: B; Params: P }>(path, wrapped); else app.post<{ Body: B; Params: P }>(path, wrapped);
  };

  route("post", "/auth/register", async (req, reply) => {
    const b = strict(req.body, ["email", "password", "displayName"], ["email", "password"]);
    const user = await auth.register({ email: str(b["email"], "email", 254), password: str(b["password"], "password"), displayName: typeof b["displayName"] === "string" ? b["displayName"] : null });
    return reply.code(201).send({ user });
  });
  route("post", "/auth/login", async (req) => {
    const b = strict(req.body, ["email", "password"], ["email", "password"]);
    const r = await auth.login({ email: str(b["email"], "email", 254), password: str(b["password"], "password") });
    return { token: r.token, expiresAt: r.expiresAt.toISOString(), user: r.user };
  });
  route("post", "/auth/logout", async (req, reply) => { await auth.logout(bearerSessionToken(req.headers.authorization)); return reply.code(204).send(); });
  route("get", "/auth/me", async (req) => { const a = await requireSession(auth, req); return { user: a.user }; });
  route("post", "/auth/change-password", async (req, reply) => {
    const a = await requireSession(auth, req), b = strict(req.body, ["currentPassword", "newPassword"], ["currentPassword", "newPassword"]);
    await auth.changePassword(a, { currentPassword: str(b["currentPassword"], "currentPassword"), newPassword: str(b["newPassword"], "newPassword") });
    return reply.code(204).send();
  });

  // ── administration: ADMIN session only ──────────────────────────────────────
  route("post", "/admin/users", async (req, reply) => {
    const a = await requireSession(auth, req), actor = requireAdmin(a), b = strict(req.body, ["email", "password", "displayName", "role"], ["email", "password"]);
    const role = b["role"] === undefined ? undefined : (str(b["role"], "role", 16) as Role);
    if (role !== undefined && !ROLES.includes(role)) throw new PlatformError("VALIDATION", "unknown role");
    const user = await auth.adminCreateUser(actor, { email: str(b["email"], "email", 254), password: str(b["password"], "password"), displayName: typeof b["displayName"] === "string" ? b["displayName"] : null, ...(role ? { role } : {}) });
    return reply.code(201).send({ user });
  });
  route<unknown, { id: string }>("post", "/admin/users/:id/role", async (req, reply) => {
    const a = await requireSession(auth, req), actor = requireAdmin(a), b = strict(req.body, ["role"], ["role"]);
    if (!UUID.test(req.params.id)) throw new PlatformError("VALIDATION", "invalid id");
    const role = str(b["role"], "role", 16) as Role;
    if (!ROLES.includes(role)) throw new PlatformError("VALIDATION", "unknown role");
    await auth.changeRole(actor, req.params.id as never, role);
    return reply.code(204).send();
  });
  route<unknown, { id: string }>("post", "/admin/users/:id/active", async (req, reply) => {
    const a = await requireSession(auth, req), actor = requireAdmin(a), b = strict(req.body, ["active"], ["active"]);
    if (!UUID.test(req.params.id)) throw new PlatformError("VALIDATION", "invalid id");
    if (typeof b["active"] !== "boolean") throw new PlatformError("VALIDATION", "invalid field", ["invalid: active"]);
    await auth.setActive(actor, req.params.id as never, b["active"]);
    return reply.code(204).send();
  });
}
