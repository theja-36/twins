import type { FastifyReply, FastifyRequest } from "fastify";

/** Shared route helpers: one bearer guard and one failure path that logs the error CLASS only (never a message, which can embed row values) and answers with a fixed body. */
export type Authorizer = (header: string | undefined) => boolean;

export function guardWith(authorized: Authorizer) {
  return (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (authorized(request.headers.authorization)) return true;
    void reply.code(401).send({ error: "Unauthorized" });
    return false;
  };
}

export function failRoute(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  const errorName = error instanceof Error ? error.name.slice(0, 60) : "unknown";
  const code = (error as { code?: unknown } | null)?.code;
  request.log.error({ route: request.routeOptions?.url ?? "unknown", errorName, errorCode: typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : undefined }, "route failed");
  return reply.code(500).send({ error: "internal_error" });
}

export const clampLimit = (raw: string | undefined, def: number, max: number): number | null => {
  const n = raw === undefined ? def : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
};
