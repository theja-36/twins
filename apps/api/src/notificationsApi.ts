import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "@twins/database";
import { clampLimit, failRoute, guardWith, type Authorizer } from "./apiSupport.js";

/**
 * Notifications API: INTERNAL, bearer-protected, READ-ONLY. A merged, newest-first feed of notable things the SYSTEM recorded in its own audited tables: the latest change of each safety control,
 * circuit-breaker events, human approvals and rejections, paper-trade events, paper-switch changes and dead-lettered intake messages. It is NOT the Telegram alert history (delivered alerts are
 * not stored in the database). Fixed-form titles; the only free text is a bounded operator reason; approver identities are masked.
 *
 * The API runs as the RUNTIME database role, which by design cannot read `system_control_events`, `approval_bot_events` or `audit_chain_heads` (see app-role.sql, `none_for_runtime`); a unit test
 * keeps this file away from them. Each source is read independently: one that cannot be read is reported in `unavailableSources` and the others are still returned.
 */
export type Severity = "critical" | "warning" | "info";
export interface Notification { id: string; at: string; kind: string; severity: Severity; title: string; detail: string | null }
const mask = (actor: string): string => { const [t = "unknown", r = ""] = actor.split(":"); return `${t} ${r.length > 4 ? `***${r.slice(-4)}` : "***"}`; };
const cut = (s: string | null | undefined, n = 140): string | null => (s ? s.slice(0, n) : null);

export async function collectNotifications(db: Db, limit: number): Promise<{ notifications: Notification[]; unavailableSources: string[] }> {
  const rows = async (q: ReturnType<typeof sql>) => (await db.execute(q)).rows as Array<Record<string, unknown>>;
  const per = Math.min(limit, 100);
  const sources: Array<[string, () => Promise<Notification[]>]> = [
    ["safety_control", async () => (await rows(sql`select control_name, value, version, reason, changed_by, changed_at from system_controls order by changed_at desc`)).filter((r) => Number(r["version"]) > 1).map((r) => {
      const name = String(r["control_name"]), on = String(r["value"]) === "true" || String(r["value"]) === "t";
      return { id: `ctl:${name}:${r["version"]}`, at: new Date(String(r["changed_at"])).toISOString(), kind: "safety_control", severity: (name === "KILL_SWITCH_ACTIVE" && on ? "critical" : "warning") as Severity, title: `${name} is ${on ? "ON" : "OFF"} (last change: version ${r["version"]})`, detail: cut(String(r["reason"])) };
    })],
    ["circuit_breaker", async () => (await rows(sql`select id, scope, event_type, reason_code, created_at from circuit_breaker_events order by created_at desc limit ${per}`)).map((r) => ({ id: `brk:${r["id"]}`, at: new Date(String(r["created_at"])).toISOString(), kind: "circuit_breaker", severity: (/breach|trip/i.test(String(r["event_type"])) ? "critical" : "warning") as Severity, title: `${String(r["scope"])} breaker: ${String(r["event_type"]).toLowerCase()}`, detail: cut(String(r["reason_code"])) }))],
    ["approval", async () => (await rows(sql`select id, action, actor, risk_decision_id, created_at from risk_approvals order by created_at desc limit ${per}`)).map((r) => ({ id: `apr:${r["id"]}`, at: new Date(String(r["created_at"])).toISOString(), kind: "approval", severity: "info" as Severity, title: `Decision ${String(r["action"]) === "APPROVE" ? "approved" : "rejected"} by ${mask(String(r["actor"]))}`, detail: `decision ${String(r["risk_decision_id"]).slice(0, 8)}` }))],
    ["paper_trade", async () => (await rows(sql`select e.id, e.type, e.at, e.price, e.quantity, t.symbol from paper_trade_events e join paper_trades t on t.id = e.trade_id order by e.at desc limit ${per}`)).map((r) => { const t = String(r["type"]); return { id: `pap:${r["id"]}`, at: new Date(String(r["at"])).toISOString(), kind: "paper_trade", severity: (t === "STOPPED_OUT" ? "warning" : "info") as Severity, title: `${String(r["symbol"])}: ${t.replaceAll("_", " ").toLowerCase()}`, detail: r["price"] === null ? null : `price ${Number(r["price"])}${r["quantity"] === null ? "" : `, qty ${Number(r["quantity"])}`}` }; })],
    ["paper_switch", async () => (await rows(sql`select id, version, previous_enabled, enabled, reason, changed_by, changed_at from paper_switch_events where version > 1 order by version desc limit ${per}`)).map((r) => ({ id: `sw:${r["id"]}`, at: new Date(String(r["changed_at"])).toISOString(), kind: "paper_switch", severity: "warning" as Severity, title: `Paper trading switched ${r["enabled"] ? "ON" : "OFF"} by ${mask(String(r["changed_by"]))}`, detail: cut(String(r["reason"])) }))],
    ["intake", async () => (await rows(sql`select id, channel_id, updated_at from telegram_intake_outbox where status = 'DEAD_LETTER' order by updated_at desc limit ${per}`)).map((r) => ({ id: `dl:${r["id"]}`, at: new Date(String(r["updated_at"])).toISOString(), kind: "intake", severity: "warning" as Severity, title: "Intake message dead-lettered", detail: null }))],
  ];
  const settled = await Promise.allSettled(sources.map(([, f]) => f()));
  const out: Notification[] = [], unavailableSources: string[] = [];
  settled.forEach((r, i) => { if (r.status === "fulfilled") out.push(...r.value); else unavailableSources.push(sources[i]![0]); });
  return { notifications: out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit), unavailableSources };
}

export function registerNotificationsRoutes(app: FastifyInstance, deps: { db: Db; authorized: Authorizer }): void {
  const guard = guardWith(deps.authorized);
  app.get<{ Querystring: { limit?: string } }>("/notifications", async (request, reply) => {
    if (!guard(request, reply)) return reply;
    const limit = clampLimit(request.query.limit, 50, 200);
    if (limit === null) return reply.code(400).send({ error: "invalid_input" });
    try { const r = await collectNotifications(deps.db, limit); return { ...r, note: "System events from audited tables; not the Telegram alert history." }; } catch (error) { return failRoute(request, reply, error); }
  });
}
