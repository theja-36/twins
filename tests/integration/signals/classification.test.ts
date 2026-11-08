/**
 * Module 02 classification against REAL PostgreSQL: a stored claim is found as pending, classified and stored once (idempotent per claim and classifier version), the row holds codes and
 * structure only (no message text), it is append-only, and the claim is no longer pending afterwards. Rows are committed (protected tables) and keyed by unique ids.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { assessOptionsClaim, recordOptionsIntake } from "../../../packages/signals/src/index";
import { CLASSIFIER_VERSION, classifyBatch, loadPendingClaims, storeClassification } from "../../../packages/signals/src/classification/index";
import { analyzeOptionsText } from "../../../packages/signals/src/options/parse";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
let handle: BoundedDbHandle;
beforeAll(() => { handle = createBoundedDb(DATABASE_URL, { max: 3, idleTimeoutMillis: 10_000 }); });
afterAll(async () => { await handle?.close(); await pool.end(); });

async function intake(text: string): Promise<string> {
  const sfx = randomUUID().slice(0, 8);
  const [source] = await handle.db.insert(schema.telegramSources).values({ channelIdentifier: `tg_chat_-100${Date.now()}${sfx}` }).returning();
  const [msg] = await handle.db.insert(schema.telegramMessages).values({ telegramSourceId: must(source).id, externalMessageId: "1", messageTimestamp: new Date("2026-11-09T04:30:00Z"), rawText: text, rawPayload: {} }).returning();
  const a = analyzeOptionsText(text); if (a.kind !== "options_claim") throw new Error(a.kind);
  const assessment = await assessOptionsClaim(a.claim);
  const rec = await recordOptionsIntake(handle.db, { telegramMessageId: must(msg).id, parserVersion: `itest-cls-${sfx}`, intake: { kind: "claim", claim: a.claim }, assessment, master: null, premium: null });
  return rec.id;
}

describe("signal classification persistence", () => {
  it("finds a pending claim, stores one classification, and is idempotent", async () => {
    const text = "SECRETWORD INTRADAY BREAKOUT BUY NIFTY 24500 CE ABOVE 118 TARGET 140 165 SL 96 12 NOV";
    const claimId = await intake(text);
    const pending = await loadPendingClaims(handle.db, 5000);
    expect(pending.map((p) => p.claimId)).toContain(claimId);
    const mine = pending.filter((p) => p.claimId === claimId);
    const first = await classifyBatch(mine, (id, r) => storeClassification(handle.db, id, r));
    expect(first).toEqual({ considered: 1, stored: 1, alreadyDone: 0 });
    const again = await classifyBatch(mine, (id, r) => storeClassification(handle.db, id, r));
    expect(again).toEqual({ considered: 1, stored: 0, alreadyDone: 1 });
    expect((await loadPendingClaims(handle.db, 5000)).map((p) => p.claimId)).not.toContain(claimId);
    const rows = await handle.db.select().from(schema.signalClassifications).where(and(eq(schema.signalClassifications.claimId, claimId), eq(schema.signalClassifications.classifierVersion, CLASSIFIER_VERSION)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ signalType: "OPTIONS_BUY", horizon: "INTRADAY", setup: "BREAKOUT", structureValid: true });
    expect(JSON.stringify(rows[0])).not.toContain("SECRETWORD"); // codes and structure only
  });
  it("a stored classification is append-only", async () => {
    const claimId = await intake("BUY NIFTY 24500 CE ABOVE 118 TARGET 140 SL 96");
    const [p] = (await loadPendingClaims(handle.db, 5000)).filter((x) => x.claimId === claimId);
    await classifyBatch([must(p)], (id, r) => storeClassification(handle.db, id, r));
    await expect(pool.query("update signal_classifications set setup = 'GAP' where claim_id = $1", [claimId])).rejects.toThrow(/append-only/);
    await expect(pool.query("delete from signal_classifications where claim_id = $1", [claimId])).rejects.toThrow(/append-only/);
  });
});
