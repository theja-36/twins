import type { FastifyInstance } from "fastify";
import { runWithSessionCredential } from "@twins/database";
import { bearerSessionToken } from "./authApi.js";

/**
 * F5 (migration 0049): carries the caller's OWN session token, and nothing else, to the database for the duration of this request, so `withUser` can have the database bind the transaction to the user who owns that
 * session. A request with no bearer token carries nothing: any `withUser` it triggers then asks for the system door, which the API database role does not hold, and fails closed.
 */
export function registerSessionCredentialHook(app: FastifyInstance): void {
  app.addHook("onRequest", (request, _reply, done) => {
    const token = bearerSessionToken(request.headers.authorization);
    if (token) runWithSessionCredential(token, done); else done();
  });
}
