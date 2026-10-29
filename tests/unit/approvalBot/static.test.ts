import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WRITE_TABLES } from "../../../services/approval-bot/src/db";

const SRC = join(__dirname, "../../../services/approval-bot/src");
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const text = (f: string) => readFileSync(join(SRC, f), "utf8");

describe("approval bot static guarantees", () => {
  it("writes only the four bot-owned tables", () => {
    expect([...WRITE_TABLES].sort()).toEqual(["approval_bot_events", "approval_bot_state", "claim_review_cards", "claim_reviews"]);
    const all = files.map((f) => text(f).split("\n").filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join("\n"));
    return checkWrites(all.join("\n"));
    function checkWrites(all: string) {
    const written = [...all.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?!of\b)([a-z_]+)/gi)].map((m) => m[1]!.toLowerCase());
    expect(written.length).toBeGreaterThan(0);
    for (const t of written) expect(WRITE_TABLES as readonly string[], t).toContain(t);
    expect(all).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:options_claims|telegram_messages|telegram_sources)/i);
    }
  });
  it("never references channel text columns", () => {
    // The only mention allowed is the startup self-check proving the role CANNOT read them.
    const allowed = /has_column_privilege\('telegram_messages','raw_(?:text|payload)'|can_read:raw_(?:text|payload)|\(raw_text and raw_payload are NOT/;
    for (const f of files) {
      const lines = text(f).split("\n").filter((l) => !allowed.test(l));
      expect(lines.join("\n"), f).not.toMatch(/raw_text|raw_payload|rawText|rawPayload/);
    }
  });
  it("has no broker, execution or live-trading code (the only allowed link is the shared refuse-to-start guard, in index.ts)", () => {
    for (const f of files) {
      const t = text(f);
      expect(t, f).not.toMatch(/LIVE_TRADING|@twins\/(?:execution|broker)|adapters\/(?:broker|dhan|zerodha)|placeOrder/i);
      expect(t, f).not.toMatch(/from\s+["']@twins\/(?:execution|broker)/);
      // The only @twins imports allowed: the refuse-to-start guard (config, index.ts only) and the runtime safety state reader/gate
      // (runtime-state, which can only READ the three control values through the bot's own role; no loadConfig, no database url, no broker).
      for (const m of t.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@twins\/([a-z-]+)["']/g)) {
        const names = m[1]!.split(",").map((x) => x.trim()).sort().join(",");
        if (m[2] === "config") {
          expect(names, f).toBe("enforceLiveTradingGuard");
          expect(f).toBe("index.ts");
        } else {
          // runtime-state (reader/gate only) and stop-loss (the pure shared validation rule, no I/O)
          expect(["runtime-state", "stop-loss"], f).toContain(m[2]);
          expect(["configureRuntimeState,pgStateSource", "evaluateSafety", "validateOptionsClaimStopLoss"], f).toContain(names);
        }
      }
    }
    expect(text("index.ts")).toMatch(/^enforceLiveTradingGuard\("approval-bot"\);$/m);
  });
  it("reads process.env only in config and the entry point", () => {
    for (const f of files) if (!["config.ts", "index.ts"].includes(f)) expect(text(f), f).not.toMatch(/process\.env/);
  });
  it("the only network client is the Bot API client (plus the egress canary)", () => {
    for (const f of files) if (!["telegramApi.ts", "egress.ts", "db.ts"].includes(f)) expect(text(f), f).not.toMatch(/\bfetch\(|node:net|node:http|node:https|createConnection/);
  });
});
