import { ApprovalBot, FatalBotError } from "./bot";
import { BotConfigError, loadBotConfig } from "./config";
import { PgBotDb } from "./db";
import { egressIsRestricted } from "./egress";
import { createLogger } from "./log";
import { BotApi } from "./telegramApi";

/**
 * Entry point of the approval bot (a separate service; places no orders).
 *   run              the service: sends cards for NEW parsed claims and records the approver's decisions.
 *                    Two independent locks: the container must be started AND TWINS_BOT_ACTIVE=true must be set.
 *   handshake        sends ONE labelled TEST card (no claim) and waits for the approver to tap it; activates nothing.
 *   check-config     validates the environment; no network.
 *   check-privileges connects to the database only (needs TWINS_BOT_DATABASE_URL only) and prints the privilege report.
 */
const FATAL_HOLD_SECONDS = 900;
const log = createLogger();
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stopping = true));

async function hold(seconds: number): Promise<void> {
  const end = Date.now() + seconds * 1000;
  while (!stopping && Date.now() < end) await new Promise((r) => setTimeout(r, 1000));
}

async function checkPrivileges(): Promise<number> {
  const url = process.env["TWINS_BOT_DATABASE_URL"];
  if (!url) {
    process.stderr.write("configuration error: TWINS_BOT_DATABASE_URL is not set\n");
    return 2;
  }
  const db = new PgBotDb(url);
  try {
    const problems = await db.checkPrivileges();
    log.log("bot.privileges_checked", { count: problems.length, ...(problems.length > 0 ? { missing: problems[0]!.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60) } : {}) });
    return problems.length === 0 ? 0 : 76;
  } finally {
    await db.close();
  }
}

async function main(command: string | undefined): Promise<number> {
  if (command === "check-privileges") return checkPrivileges();
  if (command !== "run" && command !== "handshake" && command !== "check-config") {
    process.stderr.write("usage: index.ts run|handshake|check-config|check-privileges\n");
    return 2;
  }
  let cfg;
  try {
    cfg = loadBotConfig(process.env);
  } catch (error) {
    process.stderr.write(`configuration error: ${error instanceof BotConfigError ? error.message : "invalid"}\n`);
    return 2;
  }
  if (command === "check-config") {
    log.log("bot.config_ok", { count: cfg.sourceChannels.length });
    return 0;
  }
  if (command === "run" && !cfg.active) {
    log.alert("not_active");
    await hold(FATAL_HOLD_SECONDS); // started without TWINS_BOT_ACTIVE=true: do nothing, and do not restart-loop
    return 3;
  }
  const db = new PgBotDb(cfg.databaseUrl);
  const bot = new ApprovalBot({ cfg, api: new BotApi(cfg.token, cfg.apiBase), db, log, now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  try {
    await bot.startup(() => egressIsRestricted(), command === "run");
    if (command === "handshake") {
      const result = await bot.handshake(600, () => stopping);
      log.log("bot.handshake_done", { state: result.kind, ...(result.kind === "decision" ? { action: result.action } : {}) });
      return result.kind === "decision" ? 0 : 4;
    }
    log.log("bot.started", { count: cfg.sourceChannels.length });
    await bot.run(() => stopping);
    log.log("bot.stopped");
    return 0;
  } catch (error) {
    if (error instanceof FatalBotError) {
      log.alert(error.reason);
      await hold(FATAL_HOLD_SECONDS);
      return error.exitCode;
    }
    log.alert("unexpected_error");
    await hold(FATAL_HOLD_SECONDS);
    return 1;
  } finally {
    await db.close().catch(() => undefined);
  }
}

main(process.argv[2]).then((code) => process.exit(code), () => process.exit(1));
