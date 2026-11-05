import { desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@twins/database";

/**
 * The runtime paper-trading switch (migration 0031). Paper trading runs only when BOTH the host setting TWINS_PAPER_TRADING_ENABLED ("armed") and this audited database switch are on;
 * the switch is seeded OFF and can be changed only through the SECURITY DEFINER function, which validates the actor and reason and appends the audit event itself.
 */
export interface SwitchState { enabled: boolean; version: number; reason: string; changedBy: string; changedAt: string }
export type SwitchChange = "enabled" | "disabled" | "unchanged";

export async function getPaperSwitch(db: Db): Promise<SwitchState> {
  const [r] = await db.select().from(schema.paperSwitch).where(eq(schema.paperSwitch.id, 1));
  if (!r) throw new Error("paper switch row missing"); // fail closed: an unreadable switch means OFF
  return { enabled: r.enabled, version: r.version, reason: r.reason, changedBy: r.changedBy, changedAt: r.changedAt.toISOString() };
}

export async function setPaperSwitch(db: Db, input: { enabled: boolean; actor: string; reason: string }): Promise<SwitchChange> {
  const r = await db.execute(sql`select twins_paper_set_switch(${input.enabled}::boolean, ${input.actor}, ${input.reason}) as outcome`);
  const outcome = String((r.rows[0] as { outcome: string }).outcome);
  if (outcome !== "enabled" && outcome !== "disabled" && outcome !== "unchanged") throw new Error("unexpected switch outcome");
  return outcome;
}

export async function listPaperSwitchEvents(db: Db, limit = 20): Promise<Array<{ version: number; previousEnabled: boolean; enabled: boolean; reason: string; changedBy: string; changedAt: string }>> {
  const E = schema.paperSwitchEvents;
  const rows = await db.select().from(E).orderBy(desc(E.version)).limit(Math.min(limit, 200));
  return rows.map((r) => ({ version: r.version, previousEnabled: r.previousEnabled, enabled: r.enabled, reason: r.reason, changedBy: r.changedBy, changedAt: r.changedAt.toISOString() }));
}
