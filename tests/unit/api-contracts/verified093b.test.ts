/** Stage 09.3B.1 (unit level, no database): the mirrored vocabularies equal the backend's, key lists are duplicate-free, and the review-only recommendation is the single value the backend allows. The shapes themselves are proven against real engines in tests/integration/api-contracts/realOutputShapes.test.ts. */
import { describe, expect, it } from "vitest";
import { SPEC_VERDICTS as BACKEND_VERDICTS } from "../../../packages/types/src/index";
import * as C from "../../../packages/api-contracts/src/index";

const LISTS: Record<string, readonly string[]> = {
  AGENT_REPORT_KEYS: C.AGENT_REPORT_KEYS, RESEARCH_PACKAGE_BODY_KEYS: C.RESEARCH_PACKAGE_BODY_KEYS, DECISION_VIEW_KEYS: C.DECISION_VIEW_KEYS, DECISION_EXPLANATION_KEYS: C.DECISION_EXPLANATION_KEYS, EXPLANATION_PROVENANCE_KEYS: C.EXPLANATION_PROVENANCE_KEYS,
  PERFORMANCE_METRICS_KEYS: C.PERFORMANCE_METRICS_KEYS, STRATEGY_DATA_KEYS: C.STRATEGY_DATA_KEYS, SNAPSHOT_META_KEYS: C.SNAPSHOT_META_KEYS, OUTCOME_ROW_KEYS: C.OUTCOME_ROW_KEYS, INSIGHT_ROW_KEYS: C.INSIGHT_ROW_KEYS,
};
describe("Stage 09.3B.1 contracts", () => {
  it("the research verdict vocabulary equals the backend's", () => { expect([...C.SPEC_VERDICTS].sort()).toEqual([...BACKEND_VERDICTS].sort()); });
  it("every key list is duplicate-free", () => { for (const [n, l] of Object.entries(LISTS)) expect(new Set(l).size, n).toBe(l.length); });
  it("an insight can only recommend a human REVIEW", () => { expect(C.INSIGHT_RECOMMENDATION_REVIEW).toBe("REVIEW"); });
  it("the decision OUTCOME vocabulary is deliberately not mirrored (it stays an opaque string)", () => { expect(Object.keys(C).filter((k) => /OUTCOMES?$/.test(k) && /DECISION/.test(k))).toEqual([]); });
});
