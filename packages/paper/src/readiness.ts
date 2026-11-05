/**
 * The paper-trading ENABLE checklist, computed from facts the API can observe. `readyToEnable` means "nothing blocks you from saying GO"; it does NOT turn anything on. Turning paper trading on
 * is two separate owner actions (host arming and the audited switch) and stays the owner's explicit decision.
 */
export interface ReadinessInput {
  killSwitchActive: boolean | undefined; intakeEnabled: boolean | undefined; liveGuardPasses: boolean; tradingModePaper: boolean;
  paperTablesReadable: boolean; switchReadable: boolean; switchOn: boolean; armedByHost: boolean; adminConfigured: boolean;
  snapshotComplete: boolean | null; snapshotAgeSec: number | null; priceAgeSec: number | null; maxPriceAgeSec: number; marketOpen: boolean;
  approvedDecisions: number;
}
export type ReadinessStatus = "pass" | "fail" | "info" | "manual";
export interface ReadinessItem { id: string; title: string; status: ReadinessStatus; blocking: boolean; detail: string }
export interface Readiness { readyToEnable: boolean; enabledNow: boolean; blockers: string[]; items: ReadinessItem[] }

export function evaluateReadiness(i: ReadinessInput): Readiness {
  const it: ReadinessItem[] = [];
  const add = (id: string, title: string, status: ReadinessStatus, blocking: boolean, detail: string): void => { it.push({ id, title, status, blocking, detail }); };
  add("kill_switch", "Kill switch is clear", i.killSwitchActive === false ? "pass" : "fail", true, i.killSwitchActive === undefined ? "The state could not be read: treated as NOT clear." : i.killSwitchActive ? "The kill switch is ACTIVE; paper trading refuses to run." : "Clear.");
  add("live_guard", "Live-trading guard passes and mode is paper", i.liveGuardPasses && i.tradingModePaper ? "pass" : "fail", true, i.liveGuardPasses && i.tradingModePaper ? "Live trading is locked and the mode is paper." : "The guard or the mode is wrong; paper trading refuses to run.");
  add("db", "Paper tables and the switch row are readable", i.paperTablesReadable && i.switchReadable ? "pass" : "fail", true, i.paperTablesReadable && i.switchReadable ? "Migration 0030 / 0031 objects are present." : "A paper table or the switch row cannot be read.");
  add("admin", "The admin token is configured (needed to flip the audited switch)", i.adminConfigured ? "pass" : "fail", true, i.adminConfigured ? "The admin route exists." : "TWINS_ADMIN_API_KEY is not set, so the switch cannot be turned on. Generate a token of 32+ characters on the host (never in chat) and recreate the api.");
  add("snapshot", "The Kite snapshot generation is complete", i.snapshotComplete === true ? "pass" : "fail", true, i.snapshotComplete === null ? "The snapshot directory is not visible to the API." : i.snapshotComplete ? `Complete (${i.snapshotAgeSec === null ? "age unknown" : `${Math.round(i.snapshotAgeSec / 60)} min old`}).` : "No complete generation: run the feed (needs a fresh Kite login).");
  if (i.marketOpen) add("price", "A fresh index price is available", i.priceAgeSec !== null && i.priceAgeSec <= i.maxPriceAgeSec ? "pass" : "fail", true, i.priceAgeSec === null ? "No last price." : `Last price ${i.priceAgeSec}s old (limit ${i.maxPriceAgeSec}s).`);
  else add("price", "A fresh index price is available", "info", false, "The market is closed, so this is checked only while it is open (09:15-15:30 IST, weekdays). Until the feed runs, trades would simply wait: nothing is guessed.");
  add("approvals", "Human-approved decisions exist to simulate", "info", false, i.approvedDecisions > 0 ? `${i.approvedDecisions} approved decision(s) are on record; the first cycle would create paper trades for the ones that are still current.` : "None yet: with no approval nothing is simulated.");
  add("intake", "Telegram intake is on", i.intakeEnabled ? "pass" : "info", false, i.intakeEnabled ? "On." : "Off or unreadable: no new signals will arrive.");
  add("worker_mount", "The worker reads the snapshots (read-only mount) and the shadow agents run", "manual", false, "Confirm on the host: the worker has /var/lib/twins-snapshots mounted read-only (done in Deploy 8) and shadow mode is on.");
  add("review", "Independent review (F1) understood", "manual", false, "Paper trading is simulation only. An external human review is still recommended before enforcing mode or any live use (D-097).");
  add("armed", "Key 1: armed by the host (TWINS_PAPER_TRADING_ENABLED=true)", "info", false, i.armedByHost ? "ARMED." : "Not armed. To arm: set it in staging.env and recreate the worker.");
  add("switch", "Key 2: the audited switch", "info", false, i.switchOn ? "ON." : "OFF. To turn on: POST /admin/paper/switch with the admin token.");
  const blockers = it.filter((x) => x.blocking && x.status === "fail").map((x) => x.id);
  return { readyToEnable: blockers.length === 0, enabledNow: i.armedByHost && i.switchOn, blockers, items: it };
}
