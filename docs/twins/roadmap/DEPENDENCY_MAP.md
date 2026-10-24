# Dependency map

> Observed 2026-10-24T21:14:25Z (repository) / 2026-10-24T21:15:29Z (staging runtime, read-only) at HEAD `702d4a8`. Audit documents are point-in-time evidence; re-verify before relying on them.

## Hard dependencies (A -> B means A must be approved before B starts being deployed or relied upon)
```
P00 -> P01
P00 -> P02
P00 -> P03
P00 -> P04
P03 -> P05
P04 -> P05
P00 -> P06
P03 -> P07
P04 -> P07
P06 -> P07
P05 -> P08
P07 -> P08
P03 -> P09
P06 -> P09
P07 -> P09
P06 -> P10
P09 -> P10
P08 -> P11
P10 -> P11
P10 -> P12
P01 -> P12
P00 -> P12
# additional entry gates that are not phases:
P09B additionally needs P08 eligible strategy versions
P12 additionally needs F1 independent review closed, compliance conclusions (D-013), approved risk policy (D-007), broker choice (Q-010)
```

## Table
| Phase | Hard dependencies | May run in parallel with | Optional (never blocks) |
|---|---|---|---|
| P00 | - | - | - |
| P01 | P00 | P02, P04, P06 | - |
| P02 | P00 | P01, P04, P06 | - |
| P03 | P00 | P04, P06 | - |
| P04 | P00 | P01, P02, P06 | live-quote adapter (4E) until paper needs it |
| P05 | P03, P04 | P06 | - |
| P06 | P00 | P01-P05 | - |
| P07 | P03, P04, P06 | P05 (after P03/P04/P06) | 7C AI explanation |
| P08 | P05, P07 | P09A, P10 | - |
| P09 | P03, P06, P07 | P08 (for 9A) | - |
| P10 | P06, P09 | P08 | - |
| P11 | P08, P10 | - | - |
| P12 | P10, P01, P00 | - | - |

## Soft dependencies (real, but not blockers to start)
- P03 <- P02: message classes/relations feed the library; absence must be explicitly accepted by the owner.
- P07 <-> P08: P07 ships a regime-strategy compatibility hook that returns `no eligible strategy` until P08 provides strategies; Agent 8 (signal DNA) is implemented in P08.
- P09B (scanner) <- P08 eligible strategy versions; P09A does not need them.
- P06 <- P04: stress/liquidity inputs improve when real data exist; scaffolding uses fixtures.

## Cross-phase acceptance checks (requirement -> also checked in)
| Requirement | Primary | Also checked in |
|---|---|---|
| GV-01 | P00 | P03, P06, P09, P10, P11 |
| GV-02 | P07 | P05, P08, P10 |
| TG-06 | P02 | P03 |
| TG-08 | P02 | P09 |
| TG-12 | P01 | P02 |
| SRC-01 | P02 | P01 |
| TG-14 | P02 | P01 |
| TG-15 | P02 | P03 |
| CL-01 | P02 | P03 |
| CL-04 | P02 | P09, P10 |
| CS-01 | P03 | P07, P09 |
| CS-02 | P03 | P09 |
| CS-03 | P07 | P09 |
| MD-02 | P04 | P03 |
| EV-01 | P07 | P04, P11 |
| EV-02 | P04 | P07 |
| EV-03 | P04 | P07 |
| RA-01 | P07 | P04 |
| RA-03 | P07 | P04 |
| RA-04 | P07 | P04 |
| RA-05 | P07 | P04, P06 |
| RA-06 | P08 | P07 |
| RA-07 | P07 | P06 |
| MA-01 | P07 | P06, P09 |
| CR-01 | P05 | P03 |
| SV-02 | P08 | P05 |
| SV-06 | P08 | P09 |
| SV-07 | P08 | P05 |
| PB-01 | P08 | P07 |
| PB-03 | P07 | P08 |
| LC-01 | P03 | P09 |
| LC-04 | P09 | P07 |
| RE-04 | P07 | P06 |
| RE-05 | P08 | P11 |
| RE-08 | P07 | P09 |
| SY-02 | P08 | P07 |
| SY-03 | P07 | P09 |
| PL-01 | P03 | P07 |
| PL-02 | P07 | P06, P09, P10 |
| PL-03 | P07 | P10 |
| SZ-09 | P06 | P07 |
| SZ-10 | P06 | P07 |
| SZ-11 | P06 | P09, P12 |
| AP-04 | P09 | P10 |
| AP-05 | P09 | P10 |
| SC-01 | P09 | P02, P10 |
| EX-02 | P10 | P09 |
| EX-05 | P10 | P12 |
| EX-08 | P06 | P10, P12 |
| EX-09 | P10 | P09, P12 |
| EX-10 | P10 | P06 |
| EX-12 | P06 | P10 |
| OP-01 | P10 | P06, P09 |
| OL-06 | P11 | P08 |
| OL-07 | P11 | P05 |
| OL-08 | P11 | P08 |
| XC-07 | P00 | P04, P12 |
| XC-09 | P00 | P12 |
| XC-10 | P03 | P07, P11 |

## Critical safety prerequisites (must precede dependents)
- P06 (risk core, emergency modes) before any proposal (P09) or execution (P10/P12).
- P01 (durable intake, backups, monitoring) before accumulating more irreplaceable data at scale or exposing anything wider.
- P07 state rename (F-003) before any approval flow consumes engine output.
- F1 independent review closed + compliance conclusions before P12.

## Cross-phase data dependencies
- P03 library records feed P05 outcomes, P07 decisions, P09 proposals.
- P04 instruments/data feed P05, P07 (costs/liquidity), P09 pre-flight, P10 fills.
- P06 sizing feeds P09 proposals and P10 management bounds.
- P08 eligible strategy versions feed P09B scanner; P05 outcomes feed P08 and P11.
