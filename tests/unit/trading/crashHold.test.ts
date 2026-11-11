import { describe, expect, it } from "vitest";
import { holdAfterArmedTransaction } from "../../support/crashHold";

/** The seam the execution SIGKILL test relies on: it must hold the caller only AFTER the armed transaction has committed, and only that one. */
function fakeDb() {
  const log: string[] = [];
  const db = {
    label: "db",
    async transaction<T>(fn: (tx: { id: string }) => Promise<T>): Promise<T> { log.push("begin"); const r = await fn({ id: "tx" }); log.push("commit"); return r; },
    async execute(q: string): Promise<string> { log.push(`execute:${q}`); return q; },
  };
  return { db, log };
}
const settled = (p: Promise<unknown>): Promise<boolean> => Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 40))]);

describe("holdAfterArmedTransaction (crash-test seam)", () => {
  it("is a pure pass-through while not armed", async () => {
    const { db, log } = fakeDb(); let held = 0;
    const w = holdAfterArmedTransaction(db, () => false, () => { held++; });
    expect(await w.transaction(async (tx) => tx.id)).toBe("tx");
    expect(await w.execute("q")).toBe("q"); expect(w.label).toBe("db");
    expect(log).toEqual(["begin", "commit", "execute:q"]); expect(held).toBe(0);
  });
  it("when armed, lets the transaction COMMIT, then reports and never returns; later transactions pass through", async () => {
    const { db, log } = fakeDb(); let armed = false; const events: string[] = [];
    const w = holdAfterArmedTransaction(db, () => armed, () => { events.push(`held after ${log.join(">")}`); }, { keepAlive: false });
    await w.transaction(async () => "before-arming"); // not armed: returns
    armed = true;
    const stuck = w.transaction(async () => { log.push("body"); return "x"; });
    expect(await settled(stuck)).toBe(false); // never resolves ...
    expect(events).toEqual(["held after begin>commit>begin>body>commit"]); // ... but only after the body ran and the commit happened
    expect(await w.transaction(async () => "next")).toBe("next"); // another transaction is not mistaken for the armed one
  });
  it("only the first armed transaction is held, even when several start together", async () => {
    const { db } = fakeDb(); const w = holdAfterArmedTransaction(db, () => true, () => undefined, { keepAlive: false });
    const a = w.transaction(async () => "a"), b = w.transaction(async () => "b");
    expect(await settled(a)).toBe(false); expect(await settled(b)).toBe(true);
  });
});
