# P04 - Instruments and market data

- **State:** NOT_STARTED
- **Depends on:** P00
- **Primary requirements:** MD-01, MD-02, MD-03, MD-04, MD-05, MD-06, EV-02, EV-03, XC-06
- **Also checked here (cross-phase dependencies/acceptance):** EV-01, RA-01, RA-03, RA-04, RA-05, XC-07
- **Findings (primary owner):** F-005
- **Authorization:** only the user may advance this phase. Planning files do not make it complete. Statements marked "proposed" are designs, not implementations.

Requirement statements, evidence and acceptance tests are canonical in [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md); this file does not repeat them.

## 1. Objective and scope
Give every claim a precise, point-in-time instrument and give analysis licensed, timestamped data with explicit coverage and gaps.

Scope:
- Instrument model: underlying link, expiry, strike, option type, lot size, tick size, effective-from/to.
- Versioned instrument-master ingestion (reuse the Dhan snapshot importer).
- Exchange calendar/sessions/holidays.
- Data-vendor decision backed by recorded capability probes (expired options, bid/ask, intrabar, OI) — nothing assumed.
- Historical adapter(s), later live-quote adapter with freshness states and reconnect behavior.
- Coverage matrix per signal and explicit gap rows.

## 2. Explicit non-goals
- No trading decisions; no strategy logic.
- No broker order capability (read-only data only).

## 3. Required inputs and entry gates
- D-004: vendor/entitlement decision and budget.
- Owner enters credentials in their own session.
- Approval for any new egress rule for the market-data worker.

## 4. Existing reusable components and evidence
- `adapters/market/src/yahoo.ts` - daily underlying bars (unofficial)
- `packages/signals/src/options/dhanImport.ts, providerSnapshot.ts, referenceMaster.ts` - master snapshot import
- `packages/dataquality/src/rules/market.ts` - quality dimensions
- `packages/signals/src/context/market.ts` - as-of selection

## 5. Subphases (independently testable)
- **4A** Instrument model and point-in-time master
- **4B** Calendar and sessions
- **4C** Vendor probes and adapter
- **4D** Coverage matrix and gap policy
- **4E** Live-quote freshness (paper-ready)

## 6. Detailed tasks and likely affected files (canonical task text)
| ID | Task | Likely files | Depends |
|---|---|---|---|
| T04.1 | Schema for option attributes and effective dating; resolver `resolveAsOf(contract, date)`. | packages/database/src/schema/instruments.ts, packages/signals/src/options/ | - |
| T04.2 | Calendar tables + loader; session-state function. | packages/market (new package) | - |
| T04.3 | Capability probe script per vendor writing a dated capability record (no assumptions). | scripts/, docs/twins/audit/04_DATA_AND_INTEGRATIONS_AUDIT.md | - |
| T04.4 | Vendor adapter with golden-file tests and quality rules for bid/ask/OI. | adapters/market/src/ | T04.3 |
| T04.5 | Coverage matrix job and report; gap rows explicit. | packages/ingestion/src, scripts/ | T04.1, T04.4 |
| T04.6 | Freshness policy record (executable freshness) and feed-outage state machine. | packages/market, packages/dataquality | T04.4 |
| T04.7 | Define news/evidence availability semantics (published vs knowable) and enforce as-of in context building. | packages/signals/src/context, packages/database/src/schema/news.ts | - |
| T04.8 | Effective-dated index constituents/weights and event-calendar sources (source and licence decisions first). | packages/entities, adapters/ | T04.3 |

Status tracking: [TASKS.md](TASKS.md).

## 7. Data contracts and state transitions
Instrument row: (underlying_id, expiry, strike, right, lot_size, tick_size, valid_from, valid_to, master_version). Observation: (instrument_id, as_of, received_at, source, fields, quality). Feed state: live|stale|down with transitions and timestamps.

## 8. External dependencies and permissions
- Paid vendor account(s) and data licensing terms (P00 register).
- Owner-held keys.
- Network egress approval for the market worker.

## 9. Tests
- **Unit:** Golden-file adapter tests; resolver as-of tests; calendar fixtures.
- **Integration:** Coverage job on rehearsal DB; no synthetic rows in analysis.
- **End-to-end:** Fake feed -> observations -> freshness state.
- **Failure-path:** Vendor 429/5xx/timeouts typed errors, never empty data.; Feed gap marks state stale and blocks downstream proposals.

## 10. Measurable acceptance criteria (canonical criterion text)
- A-04.1 Every option claim resolves to one instrument or an explicit `unresolved` reason.
- A-04.2 As-of resolution returns historical lot/tick/expiry.
- A-04.3 Capability record exists per vendor probed with dated evidence.
- A-04.4 Coverage matrix reports % of signals with usable series per timeframe; gaps are rows.
- A-04.5 Simulated outage -> stale state; recovery -> live state, both logged.
- A-04.6 No evidence item has availability later than the decision as-of time (leakage test).
- A-04.7 Constituent weights and event entries are effective-dated with source and availability time.

Result tracking: [ACCEPTANCE.md](ACCEPTANCE.md).

## 11. Required evidence
- Probe outputs (no credentials), coverage report, test logs.

## 12. Rollback / recovery approach
Additive tables and adapters; disable scheduler/worker market jobs; vendor adapter removable by registry entry.

## 13. Exit gate and handoff
User accepts coverage matrix and the vendor decision, authorizes next phase.

Handoff: [HANDOFF.md](HANDOFF.md). Test records: [TEST_EVIDENCE.md](TEST_EVIDENCE.md).
