# P06 task tracker

Task text is canonical in [PLAN.md](PLAN.md) section 6. Status values: `TODO` / `IN_PROGRESS` / `DONE` / `BLOCKED`. Phase state: NOT_STARTED.

| ID | Task (short) | Depends | Status |
|---|---|---|---|
| T06.1 | Policy schema + validation + versioning. | - | TODO |
| T06.2 | Sizing function | T06.1 | TODO |
| T06.3 | Reservation ledger with SERIALIZABLE/advisory lock + fencing token; con... | T06.1 | TODO |
| T06.4 | Daily/portfolio limit evaluation and reset-by-recorded-action. | T06.2 | TODO |
| T06.5 | Emergency-mode state machine and persisted control state. | - | TODO |
| T06.6 | Static dependency test | - | TODO |
| T06.7 | Fail-closed tests | T06.1, T06.2 | TODO |
| T06.8 | Property test | T06.2 | TODO |
| T06.9 | Static test | T06.1 | TODO |
