/**
 * OFFLINE TEST FIXTURE ONLY. This is not an instrument master: the contract ids, expiry dates and lot/tick sizes
 * below are arbitrary test values that exist only to exercise found / not-found / ambiguous handling.
 * It must never be imported from production code (a unit test enforces that).
 */
import type { ContractQuery, ContractVerification, OptionsContractMaster } from "../../../packages/signals/src/options/master";

interface Row { underlying: string; strike: number; optionType: "CE" | "PE"; year: number; month: number; day: number; contractId: string }

const ROWS: Row[] = [
  { underlying: "NIFTY", strike: 24500, optionType: "CE", year: 2026, month: 10, day: 29, contractId: "TEST-FIXTURE-A" },
  // two entries for the same query, to exercise the ambiguous path
  { underlying: "BANKNIFTY", strike: 52000, optionType: "PE", year: 2026, month: 10, day: 29, contractId: "TEST-FIXTURE-B1" },
  { underlying: "BANKNIFTY", strike: 52000, optionType: "PE", year: 2026, month: 10, day: 29, contractId: "TEST-FIXTURE-B2" },
];

export const testFixtureMaster: OptionsContractMaster = {
  name: "OFFLINE-TEST-FIXTURE",
  isTestFixture: true,
  async lookup(q: ContractQuery): Promise<ContractVerification> {
    const hits = ROWS.filter((r) => r.underlying === q.underlying && r.strike === q.strike && r.optionType === q.optionType && r.year === q.expiry.year && r.month === q.expiry.month && r.day === q.expiry.day);
    const [only] = hits;
    if (hits.length === 0 || !only) return { status: "not_found" };
    if (hits.length > 1) return { status: "ambiguous", candidates: hits.length };
    const iso = `${only.year}-${String(only.month).padStart(2, "0")}-${String(only.day).padStart(2, "0")}`;
    return { status: "verified", masterName: "OFFLINE-TEST-FIXTURE", testFixture: true, contract: { contractId: only.contractId, expiryDate: iso, lotSize: 1, tickSize: 1 } };
  },
};
