import { describe, expect, it } from "vitest";
import { DATA_STATES } from "@twins/api-contracts";
import { ApiError, deriveState, type RegionInput } from "./dataState";

const base: RegionInput = { loading: false, error: null, hasData: true, empty: false };
describe("deriveState: one place decides the eight states", () => {
  it("READY, LOADING, EMPTY", () => { expect(deriveState(base)).toBe("READY"); expect(deriveState({ ...base, loading: true, hasData: false })).toBe("LOADING"); expect(deriveState({ ...base, empty: true })).toBe("EMPTY"); expect(deriveState({ ...base, hasData: false })).toBe("EMPTY"); });
  it("refetching while data is shown stays READY (no flash back to loading)", () => { expect(deriveState({ ...base, loading: true })).toBe("READY"); });
  it("STALE when the server says so, or a refetch failed while cached data exists", () => { expect(deriveState({ ...base, stale: true })).toBe("STALE"); expect(deriveState({ ...base, error: new ApiError(500, "INTERNAL", "x") })).toBe("STALE"); });
  it("ERROR for a failure with nothing to show", () => { expect(deriveState({ ...base, hasData: false, error: new ApiError(500, "INTERNAL", "x") })).toBe("ERROR"); });
  it("DENIED for 401/403, and for 404 on a PRIVATE route (the backend answers 404 when you lack the permission)", () => {
    expect(deriveState({ ...base, hasData: false, error: new ApiError(401, "UNAUTHENTICATED", "x") })).toBe("DENIED"); expect(deriveState({ ...base, hasData: false, error: new ApiError(403, "FORBIDDEN", "x") })).toBe("DENIED");
    expect(deriveState({ ...base, hasData: false, privateRoute: true, error: new ApiError(404, "NOT_FOUND", "x") })).toBe("DENIED"); expect(deriveState({ ...base, hasData: false, error: new ApiError(404, "NOT_FOUND", "x") })).toBe("ERROR");
  });
  it("UNAVAILABLE for a missing capability, 503 or EXECUTION_DISABLED", () => {
    expect(deriveState({ ...base, unavailable: true })).toBe("UNAVAILABLE"); expect(deriveState({ ...base, hasData: false, error: new ApiError(503, "DEPENDENCY_UNAVAILABLE", "x") })).toBe("UNAVAILABLE"); expect(deriveState({ ...base, hasData: false, error: new ApiError(403, "EXECUTION_DISABLED", "x") })).toBe("DENIED");
  });
  it("PARTIAL when some sections failed", () => { expect(deriveState({ ...base, partial: true })).toBe("PARTIAL"); });
  it("only the eight documented states can be produced", () => {
    const seen = new Set<string>(); for (const loading of [true, false]) for (const hasData of [true, false]) for (const empty of [true, false]) for (const stale of [true, false]) for (const partial of [true, false]) for (const unavailable of [true, false]) for (const error of [null, new ApiError(500, "INTERNAL", "x"), new ApiError(403, "FORBIDDEN", "x")]) seen.add(deriveState({ loading, hasData, empty, stale, partial, unavailable, error }));
    for (const s of seen) expect(DATA_STATES as readonly string[]).toContain(s);
  });
});
