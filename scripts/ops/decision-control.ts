/**
 * Owner-run operations CLI for decisions, approvals and PAPER execution (Stage 07). There is no user-facing approval API yet: authentication sessions and per-route permissions (Stage 01) do not exist, so a network route
 * could not know WHO is approving. This CLI is run by the operator on the host and names the user explicitly; every action still goes through the same services, database doors and safety checks as the worker.
 *
 *   decision-control list      --user <uuid> [--state PENDING|APPROVED|...] [--limit N]
 *   decision-control show      --user <uuid> --decision <uuid>
 *   decision-control approve   --user <uuid> --decision <uuid> --key <idempotency key> [--reason <text>]
 *   decision-control reject    --user <uuid> --decision <uuid> --key <idempotency key> [--reason <text>]
 *   decision-control cancel    --user <uuid> --decision <uuid> --reason <text>
 *   decision-control execute   --user <uuid> --decision <uuid> --key <idempotency key>        (PAPER only; live modes are refused)
 *   decision-control positions --user <uuid> [--status OPEN|CLOSED]
 *
 * Exit codes: 0 ok, 1 failure, 2 usage error, 3 refused (a check failed). The connection string is never printed. The shared live-trading guard runs first.
 */
import { pathToFileURL } from "node:url";
import { createBoundedDb } from "../../packages/database/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { configureRuntimeState, createPooledStateSource } from "../../packages/runtime-state/src/index";
import { getDecision, listDecisions, listDecisionEvents, listPaperPositions } from "../../packages/database/src/index";
import { approveDecision, rejectDecision, cancelDecision, ApprovalError } from "../../packages/decision/src/index";
import { requestPaperExecution, loadExecutionConfig, priceProviderFrom } from "../../packages/execution/src/index";
import { fileSpecProvider, memorySpecProvider } from "../../packages/planning/src/index";
import { fileLastPriceProvider } from "../../packages/agents/src/index";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function flags(argv: string[]): Record<string, string> { const o: Record<string, string> = {}; for (let i = 0; i < argv.length; i += 2) { const k = argv[i]; if (!k?.startsWith("--") || argv[i + 1] === undefined) throw new Error("usage"); o[k.slice(2)] = argv[i + 1] as string; } return o; }

export async function main(argv: string[], env: Record<string, string | undefined> = process.env, out: (l: string) => void = console.log, err: (l: string) => void = console.error): Promise<number> {
  const [cmd, ...rest] = argv; let f: Record<string, string>;
  try { f = flags(rest); } catch { err("usage: decision-control list|show|approve|reject|cancel|execute|positions --user <uuid> ... (see the file header)"); return 2; }
  if (!cmd || !f["user"] || !UUID.test(f["user"])) { err("usage: --user <uuid> is required"); return 2; }
  const userId = f["user"];
  const url = env["DATABASE_URL"]; if (!url) { err("DATABASE_URL is not set"); return 1; }
  const pool = createPooledStateSource(url); configureRuntimeState({ source: pool.source });
  const h = createBoundedDb(url, { max: 3, idleTimeoutMillis: 5000 });
  try {
    const specs = env["TWINS_SPECS_FILE"] ? fileSpecProvider(env["TWINS_SPECS_FILE"]) : memorySpecProvider({ name: "no-specs", instruments: [], fees: [] });
    const evalDeps = { db: h.db, specs, regime: null, portfolio: null, quotes: null, strategy: null };
    switch (cmd) {
      case "list": { for (const d of await listDecisions(h.db, userId, { ...(f["state"] ? { states: [f["state"]] } : {}), limit: Number(f["limit"] ?? "20") })) out(`${d.id} ${d.workflowState} ${d.outcome} valid-until=${d.validUntil.toISOString()}${d.invalidated ? ` INVALIDATED(${d.invalidated.reasonCode})` : ""}`); return 0; }
      case "show": { const d = await getDecision(h.db, userId, f["decision"] ?? ""); if (!d) { err("no such decision"); return 1; } out(JSON.stringify({ ...d, events: await listDecisionEvents(h.db, userId, d.id) }, null, 2)); return 0; }
      case "approve": case "reject": {
        if (!f["decision"] || !f["key"]) { err("--decision and --key are required"); return 2; }
        try { out(JSON.stringify(cmd === "approve" ? await approveDecision(evalDeps, { userId, decisionId: f["decision"], idempotencyKey: f["key"], ...(f["reason"] ? { reason: f["reason"] } : {}) }) : await rejectDecision(evalDeps, { userId, decisionId: f["decision"], idempotencyKey: f["key"], ...(f["reason"] ? { reason: f["reason"] } : {}) }))); return 0; }
        catch (e) { if (e instanceof ApprovalError) { err(`refused: ${e.code}: ${e.message}`); return 3; } throw e; }
      }
      case "cancel": { if (!f["decision"] || !f["reason"]) { err("--decision and --reason are required"); return 2; } out(await cancelDecision(evalDeps, { userId, decisionId: f["decision"], reason: f["reason"], actor: `operator:${userId}` })); return 0; }
      case "execute": {
        if (!f["decision"] || !f["key"]) { err("--decision and --key are required"); return 2; }
        const lp = env["TWINS_AGENT_LAST_PRICE_FILE"] ? fileLastPriceProvider(env["TWINS_AGENT_LAST_PRICE_FILE"]) : null;
        const res = await requestPaperExecution({ eval: evalDeps, prices: lp ? priceProviderFrom(lp, "FIXTURE") : null, config: loadExecutionConfig(env) }, { userId, decisionId: f["decision"], mode: "PAPER", idempotencyKey: f["key"] });
        out(JSON.stringify(res)); return res.status === "REFUSED" ? 3 : 0;
      }
      case "positions": { for (const p of await listPaperPositions(h.db, userId, { ...(f["status"] === "OPEN" || f["status"] === "CLOSED" ? { status: f["status"] } : {}), limit: 50 })) out(`${p.id} PAPER ${p.status} ${p.side} ${p.instrument} qty=${p.quantity} avg=${p.avgEntryPrice} stop=${p.stopLoss} realized=${p.realizedPnl}`); return 0; }
      default: err("unknown command"); return 2;
    }
  } finally { await h.close().catch(() => undefined); await pool.close().catch(() => undefined); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { enforceLiveTradingGuard("decision-control"); main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`failed: ${e instanceof Error ? e.name : "Error"}`); process.exit(1); }); }
