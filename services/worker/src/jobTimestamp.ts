/**
 * Strict timestamp rehydration for BullMQ job payloads.
 *
 * BullMQ serialises job data as JSON, so Date fields reach the worker as ISO
 * strings. Direct callers (tests, in-process use) may still pass a Date.
 * Anything else is malformed and rejected explicitly - never replaced with
 * the current time.
 */
import { InvalidJobInputError } from "./jobErrors.js";
export { InvalidJobInputError };

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseJobTimestamp(value: unknown, field = "messageTimestamp"): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new InvalidJobInputError(`Invalid ${field}: Date is not a valid time`);
    }
    return new Date(value.getTime());
  }
  if (typeof value === "string" && ISO_8601.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new InvalidJobInputError(
    `Invalid ${field}: expected ISO-8601 string or Date, got ${value === null ? "null" : typeof value}`,
  );
}
