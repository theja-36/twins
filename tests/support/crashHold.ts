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
