/**
 * Capture exporter against REAL PostgreSQL: SYNTHETIC captured rows are read (never written), exported to a 0600 JSONL file, and the file passes the importer's own reader. The test asserts the
 * export changes no row anywhere and refuses to overwrite.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, type BoundedDbHandle } from "../../../packages/database/src/index";
import { inspectInput, profileArchive } from "../../../packages/historical/src/index";
import { runCli } from "../../../scripts/ops/capture-export";
import { MSG, tempDir } from "../../support/historicalFixtures";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
let handle: BoundedDbHandle;
beforeAll(() => { handle = createBoundedDb(DATABASE_URL, { max: 3, idleTimeoutMillis: 10_000 }); });
afterAll(async () => { await handle?.close(); await pool.end(); });
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Array<Record<string, ReturnType<typeof JSON.parse>>>;
const n = async (sql: string) => Number(must((await q(sql))[0])["n"]);

describe("capture export (read-only)", () => {
  it("exports captured messages with their edits, writes nothing to the database, and refuses to overwrite", async () => {
    const tag = randomUUID().slice(0, 8);
    const [src] = await q("insert into telegram_sources (channel_identifier, display_name) values ($1, $2) returning id", [`capex-${tag}`, `CapEx ${tag}`]);
    const sid = must(src)["id"];
    const ts = "2031-01-05T04:00:00Z";
    await q("insert into telegram_messages (telegram_source_id, external_message_id, message_timestamp, raw_text) values ($1, $2, $3, $4)", [sid, `m-${tag}`, ts, MSG.completeOption]);
    await q("insert into telegram_messages (telegram_source_id, external_message_id, message_timestamp, raw_text, origin_message_id, edit_date) values ($1, $2, $3, $4, $5, $6)", [sid, `m-${tag}_edit_1`, ts, MSG.completeOption.replace("SL 90", "SL 60"), `m-${tag}`, "2031-01-05T04:30:00Z"]);
    await q("insert into telegram_messages (telegram_source_id, external_message_id, message_timestamp, raw_text, first_seen_edited) values ($1, $2, $3, $4, true)", [sid, `fse-${tag}`, ts, MSG.equity]);

    const tables = ["telegram_messages", "telegram_sources", "options_claims", "signals", "risk_decisions", "historical_source_records", "historical_normalized_records"];
    const before = await Promise.all(tables.map((t) => n(`select count(*)::int as n from ${t}`)));
    const out = join(tempDir(), "cap.jsonl");
    const lines: string[] = [], errs: string[] = [];
    const deps = { env: { DATABASE_URL }, out: (l: string) => lines.push(l), err: (l: string) => errs.push(l) };
    expect(await runCli(["--out", out, "--since", "2031-01-01T00:00:00Z", "--until", "2031-02-01T00:00:00Z"], deps)).toBe(0);
    expect(await Promise.all(tables.map((t) => n(`select count(*)::int as n from ${t}`)))).toEqual(before); // nothing written
    expect(statSync(out).mode & 0o777).toBe(0o600);

    const recs = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { channel: string; message_id: string; edits?: unknown[] });
    const mine = recs.filter((r) => r.channel === `CapEx ${tag}`);
    expect(mine).toHaveLength(1); // the first-seen-edited message is excluded by default
    expect(mine[0]).toMatchObject({ message_id: `m-${tag}` });
    expect(mine[0]?.edits).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("BUY NIFTY");

    const p = await profileArchive(await inspectInput(out), { label: "cap", defaultMarket: "NSE" }, new Date("2031-06-01T00:00:00Z"));
    expect(p.totals.invalid).toBe(0);
    expect(await runCli(["--out", out], deps)).toBe(3); // never overwrites
    expect(errs).toContain("refused: output_exists");

    const withFse = join(tempDir(), "cap2.jsonl");
    expect(await runCli(["--out", withFse, "--since", "2031-01-01T00:00:00Z", "--until", "2031-02-01T00:00:00Z", "--include-first-seen-edited"], deps)).toBe(0);
    expect(readFileSync(withFse, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { channel: string }).filter((r) => r.channel === `CapEx ${tag}`)).toHaveLength(2);
  });
});
