/**
 * Rehearsal guard. Skipped in normal runs; with TWINS_REHEARSAL=1 it fails loudly unless the
 * process (and therefore every vitest worker, which inherits process.env) points at a
 * scratch rehearsal database and the dedicated test Redis. Nothing connects to either.
 */
import { describe, expect, it } from "vitest";
import { APPROVED_REHEARSAL_DATABASES, isApprovedRehearsalDatabase } from "./rehearsalTargets";

const rehearsal = process.env.TWINS_REHEARSAL === "1";

describe.skipIf(!rehearsal)("rehearsal environment guard", () => {
  it("DATABASE_URL targets only the loopback test Postgres, as user `twins`, and an EXACT approved rehearsal database", () => {
    const url = new URL(process.env.DATABASE_URL ?? "postgresql://missing");
    expect(`${url.hostname}:${url.port}`).toBe("127.0.0.1:15432");
    expect(decodeURIComponent(url.username)).toBe("twins");
    expect(isApprovedRehearsalDatabase(url.pathname), `${url.pathname} is not one of ${APPROVED_REHEARSAL_DATABASES.join(", ")}`).toBe(true);
  });
  it("REDIS_URL targets only the dedicated test Redis (never a default endpoint)", () => {
    const url = new URL(process.env.REDIS_URL ?? "redis://missing");
    expect(`${url.hostname}:${url.port}`).toBe("127.0.0.1:16379");
  });
  it("LIVE_TRADING stays false", () => {
    expect(process.env.LIVE_TRADING).toBe("false");
  });
});
