/**
 * Versioned playbooks against REAL PostgreSQL (migrations 0033 and 0034): the lifecycle service keeps playbook_versions and learning_versions in step, only the owner activates with a passing
 * out-of-sample evaluation, at most one version is ACTIVE, a rollback restores the earlier evaluated version, and every change leaves an append-only event.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoundedDb, schema, type BoundedDbHandle } from "../../../packages/database/src/index";
import { PlaybookError, buildChannelProfile, buildPlaybookContent, createPlaybook, proposeVersion, rollbackPlaybook, transitionVersion, type PlaybookEvaluation } from "../../../packages/historical/src/strategy/index";
import { requireTestDatabaseUrl } from "../targetConfig";
import { must } from "../runtime/harness";

const DATABASE_URL = requireTestDatabaseUrl();
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
let handle: BoundedDbHandle;
beforeAll(() => { handle = createBoundedDb(DATABASE_URL, { max: 4, idleTimeoutMillis: 10_000 }); });
afterAll(async () => { await handle?.close(); await pool.end(); });
const owner = { kind: "OWNER" as const, id: "owner" }, system = { kind: "SYSTEM" as const, id: "learning-job" };
const evaluation = (resolved = 40, extra: Partial<PlaybookEvaluation> = {}): PlaybookEvaluation => ({ outOfSample: true, resolved, driftFlag: false, evaluatedAt: new Date().toISOString(), metrics: { winRate: 0.5 }, ...extra });
const content = () => buildPlaybookContent(buildChannelProfile([]));
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "no error"; } catch (e) { return e instanceof PlaybookError ? `${e.code}:${e.reasons.join(",")}` : String(e); } };
const states = async (playbookId: string) => (await pool.query("select version, state from playbook_versions where playbook_id = $1 order by version", [playbookId])).rows.map((r) => `${r.version}:${r.state}`);

async function newPlaybook(): Promise<string> {
  const [src] = await handle.db.insert(schema.telegramSources).values({ channelIdentifier: `tg_chat_-100${Date.now()}${randomUUID().slice(0, 6)}` }).returning();
  return createPlaybook(handle.db, { sourceKind: "TELEGRAM_CHANNEL", telegramSourceId: must(src).id, name: `playbook-${randomUUID().slice(0, 8)}` });
}

describe("versioned playbook lifecycle", () => {
  it("a new version is a DRAFT and is mirrored by a PROPOSED learning version that does not influence live policy", async () => {
    const pb = await newPlaybook(); const v1 = await proposeVersion(handle.db, pb, content(), system);
    expect(v1.version).toBe(1); expect(await states(pb)).toEqual(["1:DRAFT"]);
    const lv = must((await pool.query("select state, influences_live from learning_versions where kind = 'PLAYBOOK' and subject_id = $1", [pb])).rows[0]);
    expect(lv).toMatchObject({ state: "PROPOSED", influences_live: false });
    expect((await proposeVersion(handle.db, pb, content(), system)).version).toBe(2);
  });
  it("activation is refused for the system, without evaluation, with a small or in-sample evaluation, or straight from DRAFT; nothing changes", async () => {
    const pb = await newPlaybook(); const v = await proposeVersion(handle.db, pb, content(), system);
    expect(await code(transitionVersion(handle.db, v.versionId, "ACTIVE", owner, "x", evaluation()))).toMatch(/illegal_transition/); // DRAFT -> ACTIVE
    await transitionVersion(handle.db, v.versionId, "EVALUATING", system, "evaluate");
    expect(await code(transitionVersion(handle.db, v.versionId, "ACTIVE", system, "x", evaluation()))).toBe("activation_refused:only_the_owner_can_activate");
    expect(await code(transitionVersion(handle.db, v.versionId, "ACTIVE", owner, "x", null))).toBe("activation_refused:not_evaluated");
    expect(await code(transitionVersion(handle.db, v.versionId, "ACTIVE", owner, "x", evaluation(5)))).toBe("activation_refused:evaluation_sample_too_small");
    expect(await code(transitionVersion(handle.db, v.versionId, "ACTIVE", owner, "x", evaluation(40, { outOfSample: false })))).toBe("activation_refused:evaluation_not_out_of_sample");
    expect(await states(pb)).toEqual(["1:EVALUATING"]);
  });
  it("the owner activates with a passing evaluation; a second activation retires the first; at most one is ACTIVE", async () => {
    const pb = await newPlaybook();
    const a = await proposeVersion(handle.db, pb, content(), system); await transitionVersion(handle.db, a.versionId, "EVALUATING", system, "e"); await transitionVersion(handle.db, a.versionId, "ACTIVE", owner, "ok", evaluation());
    const b = await proposeVersion(handle.db, pb, content(), system); await transitionVersion(handle.db, b.versionId, "EVALUATING", system, "e"); await transitionVersion(handle.db, b.versionId, "ACTIVE", owner, "better", evaluation(60));
    expect(await states(pb)).toEqual(["1:RETIRED", "2:ACTIVE"]);
    const live = (await pool.query("select version from learning_versions where kind = 'PLAYBOOK' and subject_id = $1 and influences_live", [pb])).rows;
    expect(live).toEqual([{ version: 2 }]);
    // the database itself refuses a second ACTIVE version, whatever the application does
    await expect(pool.query("update playbook_versions set state = 'ACTIVE', performance = '{}'::jsonb, sample_size = 40 where playbook_id = $1 and version = 1", [pb])).rejects.toThrow(/playbook_versions_one_active/);
  });
  it("a rollback restores the earlier evaluated version, and every change is an append-only event", async () => {
    const pb = await newPlaybook();
    const a = await proposeVersion(handle.db, pb, content(), system); await transitionVersion(handle.db, a.versionId, "EVALUATING", system, "e"); await transitionVersion(handle.db, a.versionId, "ACTIVE", owner, "ok", evaluation());
    const b = await proposeVersion(handle.db, pb, content(), system); await transitionVersion(handle.db, b.versionId, "EVALUATING", system, "e"); await transitionVersion(handle.db, b.versionId, "ACTIVE", owner, "better", evaluation(60));
    expect(await code(rollbackPlaybook(handle.db, pb, system, "auto"))).toBe("activation_refused:only_the_owner_can_activate");
    expect(await rollbackPlaybook(handle.db, pb, owner, "degraded")).toEqual({ rolledBack: 2, restored: 1 });
    expect(await states(pb)).toEqual(["1:ACTIVE", "2:ROLLED_BACK"]);
    const events = (await pool.query("select e.to_state, e.actor from learning_version_events e join learning_versions l on l.id = e.learning_version_id where l.subject_id = $1 order by e.at, e.id", [pb])).rows;
    expect(events.length).toBeGreaterThanOrEqual(8); expect(events.some((e) => e.to_state === "ROLLED_BACK")).toBe(true); expect(events.some((e) => String(e.actor).startsWith("SYSTEM:"))).toBe(true);
    await expect(pool.query("update learning_version_events set reason = 'x' where learning_version_id in (select id from learning_versions where subject_id = $1)", [pb])).rejects.toThrow(/append-only/);
  });
  it("a rollback with no earlier evaluated version leaves no active version and invents nothing", async () => {
    const pb = await newPlaybook();
    const a = await proposeVersion(handle.db, pb, content(), system); await transitionVersion(handle.db, a.versionId, "EVALUATING", system, "e"); await transitionVersion(handle.db, a.versionId, "ACTIVE", owner, "ok", evaluation());
    expect(await rollbackPlaybook(handle.db, pb, owner, "bad")).toEqual({ rolledBack: 1, restored: null }); expect(await states(pb)).toEqual(["1:ROLLED_BACK"]);
    expect(await code(rollbackPlaybook(handle.db, pb, owner, "again"))).toBe("no_active_version");
  });
});
