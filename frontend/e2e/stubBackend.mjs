// A stub of the TWINS API for the Playwright run: synthetic users and data only, in memory, no network beyond localhost.
// It mirrors the VERIFIED backend behaviour the frontend depends on (docs/frontend/contracts-verification.md):
//  - login: 401 "invalid credentials"; after 5 failures per email: 403 "too many attempts" even for the right password
//  - /auth/me and /auth/logout need the Bearer session token; an ADMIN has no private permission, so every private route answers 404
//  - error body { error, message, reasons }
// It also records every request it receives (GET /__log) so tests can prove the BFF never forwards a cookie, the service key or a browser header.
import http from "node:http";
import { randomBytes } from "node:crypto";

const USERS = {
  "trader@example.test": { password: "trader-pass-123", user: { id: "11111111-1111-4111-8111-111111111111", email: "trader@example.test", displayName: "Alex Rao", role: "TRADER", isActive: true } },
  "admin@example.test": { password: "admin-pass-123", user: { id: "22222222-2222-4222-8222-222222222222", email: "admin@example.test", displayName: "Priya Nair", role: "ADMIN", isActive: true } },
};
const ACCOUNTS = [{ id: "33333333-3333-4333-8333-333333333333", name: "Paper account", tradingMode: "paper", baseCurrency: "INR", isActive: true }];
const sessions = new Map(); const failures = new Map(); const log = [];
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(status === 204 ? undefined : JSON.stringify(body)); };
const err = (res, status, error, message) => send(res, status, { error, message, reasons: [] });
const token = () => `tws_${randomBytes(32).toString("base64url")}`;
const PRIVATE = [/^\/accounts$/, /^\/approvals$/, /^\/decisions/, /^\/portfolio$/, /^\/capital\//, /^\/risk\//, /^\/execution\//, /^\/analytics\//];
const SHARED = [/^\/opportunities\//, /^\/research\//, /^\/intelligence\//];

http.createServer((req, res) => {
  const url = new URL(req.url, "http://stub"); let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    log.push({ method: req.method, path: url.pathname, headers: Object.keys(req.headers).sort(), hasCookie: "cookie" in req.headers, hasApiKey: "x-api-key" in req.headers });
    if (url.pathname === "/__log") return send(res, 200, { log });
    if (url.pathname === "/__reset") { log.length = 0; failures.clear(); return send(res, 200, {}); }
    if (url.pathname === "/__expire") { sessions.clear(); return send(res, 200, {}); }
    if (url.pathname === "/auth/login" && req.method === "POST") {
      let b; try { b = JSON.parse(raw); } catch { return err(res, 422, "VALIDATION", "a JSON object is required"); }
      const email = String(b.email ?? "").toLowerCase(), u = USERS[email], n = failures.get(email) ?? 0;
      if (n >= 5) return err(res, 403, "FORBIDDEN", "too many attempts, try again later");
      if (!u || u.password !== b.password) { failures.set(email, n + 1); return err(res, 401, "UNAUTHENTICATED", "invalid credentials"); }
      const t = token(); sessions.set(t, u.user); return send(res, 200, { token: t, expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(), user: u.user });
    }
    const bearer = /^Bearer (tws_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? ""), user = bearer ? sessions.get(bearer[1]) : undefined;
    if (url.pathname === "/auth/logout" && req.method === "POST") { if (bearer) sessions.delete(bearer[1]); return send(res, 204); }
    if (!user) return err(res, 401, "UNAUTHENTICATED", "authentication required");
    if (url.pathname === "/auth/me") return send(res, 200, { user });
    if (PRIVATE.some((p) => p.test(url.pathname))) {
      if (user.role !== "TRADER") return err(res, 404, "NOT_FOUND", "not found"); // an ADMIN holds no private permission
      if (url.pathname === "/accounts") return send(res, 200, { accounts: ACCOUNTS });
      if (url.pathname === "/approvals") return send(res, 200, { pending: [], history: [] });
      return send(res, 200, {});
    }
    if (SHARED.some((p) => p.test(url.pathname))) return send(res, 200, { items: [] });
    return err(res, 404, "NOT_FOUND", "not found");
  });
}).listen(Number(process.env.STUB_PORT ?? 4010), "127.0.0.1", () => console.log("stub backend listening"));
