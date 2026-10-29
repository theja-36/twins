/** Narrowing helper for tests: fails with a clear message instead of a non-null assertion (`x!`). */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to be defined`);
  return value;
}
