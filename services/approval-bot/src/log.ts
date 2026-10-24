/**
 * The ONLY output channel: an event name plus whitelisted, content-free fields. Message text, claim contents, the token, the database URL
 * and the HMAC key cannot reach a log, however a caller is written: unknown fields and non-identifier strings are refused.
 */
const EVENT = /^[a-z][a-z0-9_.]{2,48}$/;
const SAFE_STR = /^[A-Za-z0-9_.:-]{0,64}$/;
const FIELDS: Record<string, "int" | "str" | "bool"> = {
  reason: "str", state: "str", kind: "str", action: "str", card: "str", bot: "str", status: "int", code: "int", count: "int",
  update_id: "int", delay_s: "int", sent: "int", expired: "int", suppressed: "int", paused: "bool", missing: "str",
};

export interface BotLogger {
  log(event: string, fields?: Record<string, number | string | boolean>, level?: "info" | "warn" | "error"): void;
  alert(reason: string, fields?: Record<string, number | string | boolean>): void;
}

export function createLogger(write: (line: string) => void = (line) => process.stdout.write(line), clock: () => number = Date.now): BotLogger {
  const log = (event: string, fields: Record<string, number | string | boolean> = {}, level: "info" | "warn" | "error" = "info"): void => {
    if (!EVENT.test(event)) throw new Error("bad event name");
    const record: Record<string, unknown> = { ts: Math.floor(clock() / 1000), level, event };
    for (const [name, value] of Object.entries(fields)) {
      const kind = FIELDS[name];
      if (kind === undefined) throw new Error(`log field not allowed: ${name}`);
      if (kind === "int" ? typeof value !== "number" || !Number.isSafeInteger(value) : kind === "bool" ? typeof value !== "boolean" : typeof value !== "string" || !SAFE_STR.test(value)) {
        throw new Error(`log field ${name} has the wrong type or shape`);
      }
      record[name] = value;
    }
    write(JSON.stringify(record) + "\n");
  };
  return { log, alert: (reason, fields = {}) => log("bot.alert", { reason, ...fields }, "error") };
}
