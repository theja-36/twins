import type { ControlName, ControlRow, StateSource } from "./types";
import { CONTROL_DEFAULTS } from "./types";

/**
 * TEST-ONLY in-memory source (used by the vitest setup files and unit tests). Production entry points must never import it:
 * tests/unit/safety/runtimeStateCoverage.test.ts fails if one does.
 */
export interface InMemoryStateSource extends StateSource {
  set(values: Partial<Record<ControlName, boolean>>): void;
  remove(name: ControlName): void;
  failWith(error: Error | null): void;
  hang(on: boolean): void;
  setRaw(rows: ControlRow[] | null): void;
  reads: number;
}

export function inMemoryStateSource(initial: Partial<Record<ControlName, boolean>> = {}): InMemoryStateSource {
  const values: Record<ControlName, boolean | undefined> = { ...CONTROL_DEFAULTS, ...initial };
  const versions: Record<ControlName, number> = { TRADING_ENABLED: 1, INTAKE_ENABLED: 1, KILL_SWITCH_ACTIVE: 1 };
  let error: Error | null = null;
  let hanging = false;
  let raw: ControlRow[] | null = null;
  const self: InMemoryStateSource = {
    reads: 0,
    set(next) {
      for (const [k, v] of Object.entries(next) as Array<[ControlName, boolean]>) {
        values[k] = v;
        versions[k] += 1;
      }
    },
    remove(name) {
      values[name] = undefined;
    },
    failWith(e) {
      error = e;
    },
    hang(on) {
      hanging = on;
    },
    setRaw(rows) {
      raw = rows;
    },
    async read() {
      self.reads += 1;
      if (hanging) return new Promise<ControlRow[]>(() => undefined);
      if (error) throw error;
      if (raw) return raw;
      return (Object.keys(values) as ControlName[]).filter((k) => values[k] !== undefined).map((k) => ({ control_name: k, value: values[k], version: versions[k] }));
    },
  };
  return self;
}
