/**
 * Test seam for the execution crash test: a pass-through wrapper around a database handle's `transaction`. While `isArmed()` is true, the FIRST transaction that starts is awaited to its COMMIT and then the caller is held forever
 * (after `onHeld`), so a parent process can SIGKILL the process at exactly that point: the transaction's effects are durable and nothing that would normally follow it has run.
 * Every other method, and every other transaction, passes straight through unchanged.
 */
export function holdAfterArmedTransaction<T extends object>(db: T, isArmed: () => boolean, onHeld: () => void, o: { keepAlive?: boolean } = {}): T {
  let held = false;
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop === "transaction" && typeof v === "function") {
        return async (...a: unknown[]) => {
          const isTheArmedTransaction = !held && isArmed();
          if (isTheArmedTransaction) held = true; // claimed before awaiting, so no other transaction can be mistaken for it
          const result = await (v as (...x: unknown[]) => Promise<unknown>).apply(target, a); // the transaction COMMITS here
          if (isTheArmedTransaction) { onHeld(); if (o.keepAlive !== false) setInterval(() => undefined, 1 << 30); await new Promise<never>(() => undefined); } // never returns
          return result;
        };
      }
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  }) as T;
}

/** The SQL text of a drizzle `sql` template (its literal parts only; parameters become `?`), enough to recognise which statement is being executed. */
export function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  return chunks.map((c) => (c && typeof c === "object" && (c as { constructor?: { name?: string } }).constructor?.name === "StringChunk" ? ((c as { value: string[] }).value).join("") : typeof c === "object" && c !== null && "queryChunks" in c ? sqlText(c) : "?")).join("");
}
/**
 * Holds the process at a chosen STATEMENT of a transaction, so a parent can SIGKILL it at exactly that point:
 *   before-commit  the matching statement has executed INSIDE its still-open transaction (its effects are uncommitted and will be rolled back by the database when the process dies);
 *   after-commit   the transaction that executed the matching statement has COMMITTED (its effects are durable) and nothing after it has run.
 * Everything else passes straight through unchanged. Only the first match is held.
 */
export function holdAtStatement<T extends object>(db: T, o: { match: RegExp; when: "before-commit" | "after-commit"; onHeld: () => void; keepAlive?: boolean }): T {
  let held = false;
  const hang = async (): Promise<never> => { held = true; o.onHeld(); if (o.keepAlive !== false) setInterval(() => undefined, 1 << 30); return new Promise<never>(() => undefined); };
  const wrapTx = (tx: object, arm: () => void): object => new Proxy(tx, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop === "execute" && typeof v === "function") {
        return async (q: unknown, ...rest: unknown[]) => {
          const r = await (v as (...x: unknown[]) => Promise<unknown>).call(target, q, ...rest);
          if (!held && o.match.test(sqlText(q))) { if (o.when === "before-commit") await hang(); else arm(); }
          return r;
        };
      }
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  });
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop === "transaction" && typeof v === "function") {
        return async (fn: (tx: object) => Promise<unknown>, ...rest: unknown[]) => {
          let armed = false;
          const result = await (v as (...x: unknown[]) => Promise<unknown>).call(target, (tx: object) => fn(wrapTx(tx, () => { armed = true; })), ...rest);
          if (armed && !held) await hang();
          return result;
        };
      }
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  }) as T;
}

/**
 * Deterministic interleaving seam: runs `action` (typically a rival worker finishing the same job on another connection) immediately BEFORE the `nth` statement matching `match` is executed inside a transaction, once.
 * It lets a test place a concurrent actor in the exact gap between two steps of the code under test, instead of hoping a race happens.
 */
export function beforeNthStatement<T extends object>(db: T, o: { match: RegExp; nth: number; action: () => Promise<void> }): T {
  let seen = 0, fired = false;
  const wrapTx = (tx: object): object => new Proxy(tx, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop === "execute" && typeof v === "function") return async (q: unknown, ...rest: unknown[]) => { if (!fired && o.match.test(sqlText(q)) && ++seen === o.nth) { fired = true; await o.action(); } return (v as (...x: unknown[]) => Promise<unknown>).call(target, q, ...rest); };
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  });
  return new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop === "transaction" && typeof v === "function") return (fn: (tx: object) => Promise<unknown>, ...rest: unknown[]) => (v as (...x: unknown[]) => Promise<unknown>).call(target, (tx: object) => fn(wrapTx(tx)), ...rest);
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
    },
  }) as T;
}
