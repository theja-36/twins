/**
 * Operations CLI for the runtime safety controls (Stage 1 / Task 2). The ONLY supported way to change TRADING_ENABLED, INTAKE_ENABLED and
 * KILL_SWITCH_ACTIVE. There is deliberately no HTTP endpoint for this.
 *
 *   safety-control status
 *   safety-control events [--limit N]
 *   safety-control set --control <NAME> --value <true|false> --reason "<why, 8-500 chars>" --changed-by operator:<name> [--expected-version N]
 *
 * Authorization boundary: the caller must hold the owner database credential (DATABASE_URL), i.e. be able to run on the host or as the
 * one-shot compose job `safety-control` (profile `ops`) - the same boundary as running migrations. The restricted approval-bot role cannot
 * change a control. `--changed-by operator:<name>` is a SELF-DECLARED identity (convention enforced here and by a database CHECK); it is not authenticated. The audit event also records the source process, the OS user / host / pid declared by this CLI, and what the database observed (session user, client address).
 * Every change requires an explicit control, an explicit boolean target, a reason and a changed-by; there are no defaults and no shortcuts.
 * The CLI also runs the shared live-trading guard first, so it cannot run in a live configuration. Exit codes: 0 ok (or unchanged),
 * 1 failure, 2 usage error, 3 refused/invalid change. The connection string is never printed.
 */
import os from "node:os";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { observe } from "../../packages/alerting/src/index";
import type { StructuredLogger } from "../../packages/shared/src/index";
import {
  changeControl,
  ControlChangeInvalidError,
  ControlChangeRefusedError,
  CONTROL_NAMES,
  readControlEvents,
  readControlStatus,
  StaleControlVersionError,
  type ChangeControlInput,
  type OperatorContext,
  type PoolLike,
} from "../../packages/runtime-state/src/index";

export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Returns a pool plus a closer. Tests inject a pool against the test database. */
  openPool?: (databaseUrl: string) => { pool: PoolLike; close: () => Promise<void> };
  /** Declared operator context (tests inject a fixed one). Default: OS user, host name and pid of this process. */
  operatorContext?: () => OperatorContext;
  /** Logger for the change events (the real entry point passes one that also raises alerts); `flush` waits for alert delivery before the process exits. */
  logger?: StructuredLogger;
  flush?: () => Promise<void>;
}

function safeUser(): string {
  try {
    return os.userInfo().username.slice(0, 64);
  } catch {
    return "unknown";
  }
}

const USAGE = [
  "usage:",
  "  safety-control status",
  "  safety-control events [--limit N]",
  "  safety-control set --control <TRADING_ENABLED|INTAKE_ENABLED|KILL_SWITCH_ACTIVE> --value <true|false> --reason <text> --changed-by operator:<name> [--expected-version N]",
].join("\n");

function parseFlags(argv: string[], allowed: string[]): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    if (!flag.startsWith("--") || !allowed.includes(flag.slice(2))) return `unknown or malformed argument ${JSON.stringify(flag.slice(0, 30))}`;
    const value = argv[i + 1];
    if (value === undefined) return `${flag} needs a value`;
    if (flag.slice(2) in out) return `${flag} given twice`;
    out[flag.slice(2)] = value;
  }
  return out;
}

const defaultOpenPool: NonNullable<CliDeps["openPool"]> = (url) => {
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10_000, application_name: "twins-safety-control" });
  pool.on("error", () => undefined);
  return { pool, close: () => pool.end() };
};

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "status" && command !== "events" && command !== "set") {
    deps.err(USAGE);
    return 2;
  }
  const flags = parseFlags(rest, command === "set" ? ["control", "value", "reason", "changed-by", "expected-version"] : command === "events" ? ["limit"] : []);
  if (typeof flags === "string") {
    deps.err(`usage error: ${flags}\n${USAGE}`);
    return 2;
  }
  let input: ChangeControlInput | undefined;
  if (command === "set") {
    const missing = ["control", "value", "reason", "changed-by"].filter((k) => flags[k] === undefined);
    if (missing.length > 0) {
      deps.err(`usage error: missing required ${missing.map((m) => `--${m}`).join(", ")} (a change needs an explicit control, target state, reason and changed-by)\n${USAGE}`);
      return 2;
    }
    const control = CONTROL_NAMES.find((n) => n === flags["control"]);
    if (!control) {
      deps.err(`usage error: --control must be one of ${CONTROL_NAMES.join(", ")}`);
      return 2;
    }
    if (flags["value"] !== "true" && flags["value"] !== "false") {
      deps.err("usage error: --value must be exactly true or false");
      return 2;
    }
    const expected = flags["expected-version"];
    if (expected !== undefined && !/^[1-9][0-9]{0,14}$/.test(expected)) {
      deps.err("usage error: --expected-version must be a positive integer");
      return 2;
    }
    input = {
      control,
      value: flags["value"] === "true",
      reason: flags["reason"] as string,
      changedBy: flags["changed-by"] as string,
      mechanism: "cli",
      sourceProcess: "safety-control",
      operatorContext: deps.operatorContext?.() ?? { os_user: safeUser(), host: os.hostname().slice(0, 64), pid: process.pid },
      ...(expected !== undefined ? { expectedVersion: Number(expected) } : {}),
    };
  }
  const url = deps.env["DATABASE_URL"];
  if (!url) {
    deps.err("configuration error: DATABASE_URL is not set");
    return 2;
  }
  const { pool, close } = (deps.openPool ?? defaultOpenPool)(url);
  try {
    if (command === "status") {
      for (const c of await readControlStatus(pool)) deps.out(`${c.control}=${c.value} version=${c.version} changed_by=${c.changedBy} changed_at=${c.changedAt.toISOString()} reason=${JSON.stringify(c.reason)}`);
      return 0;
    }
    if (command === "events") {
      const limit = flags["limit"] !== undefined && /^[0-9]{1,3}$/.test(flags["limit"]) ? Number(flags["limit"]) : 20;
      for (const e of await readControlEvents(pool, limit)) {
        deps.out(`${e.changedAt.toISOString()} ${e.controlName} ${e.previousValue === null ? "(seed)" : e.previousValue} -> ${e.newValue} v${e.version} by ${e.changedBy} via ${e.changeMechanism}/${e.sourceProcess} db_user=${e.dbSessionUser ?? "-"} chain#${e.chainIndex} ${JSON.stringify(e.reason)}`);
      }
      return 0;
    }
    const result = await changeControl(pool, input as NonNullable<typeof input>, {
      logger: deps.logger ?? { info: () => undefined, warn: (e, f) => deps.err(JSON.stringify({ event: e, ...f })), error: (e, f) => deps.err(JSON.stringify({ event: e, ...f })), child() { return this; } },
    });
    await deps.flush?.();
    deps.out(result.changed ? `changed ${result.control}: ${result.previousValue} -> ${result.newValue} (version ${result.version})` : `unchanged: ${result.control} is already ${result.newValue} (version ${result.version}); nothing recorded`);
    return 0;
  } catch (error) {
    if (error instanceof ControlChangeInvalidError || error instanceof ControlChangeRefusedError || error instanceof StaleControlVersionError) {
      deps.err(`refused: ${error.message}`);
      return 3;
    }
    // Never print driver messages: they can embed the host or user. Class name and SQLSTATE only.
    const code = (error as { code?: unknown } | null)?.code;
    deps.err(`failed: ${error instanceof Error ? error.name : "error"}${typeof code === "string" && /^[A-Za-z0-9_]{1,24}$/.test(code) ? ` (${code})` : ""}`);
    return 1;
  } finally {
    await close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  enforceLiveTradingGuard("safety-control");
  const observed = observe("safety-control", process.env, (r) => console.error(JSON.stringify(r)));
  void main(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l), logger: observed.logger, flush: () => observed.alerter.flush() }).then((code) => process.exit(code));
}
