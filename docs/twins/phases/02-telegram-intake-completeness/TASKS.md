# P02 task tracker

Task text is canonical in [PLAN.md](PLAN.md) section 6. Status values: `TODO` / `IN_PROGRESS` / `DONE` / `BLOCKED`. Phase state: NOT_STARTED.

| ID | Task (short) | Depends | Status |
|---|---|---|---|
| T02.1 | Extend map_message/build_payload to carry reply_to, forward origin, ent... | - | TODO |
| T02.2 | Follow-up classifier (rule-based) emitting linked `message_relations` r... | T02.1 | TODO |
| T02.3 | History backfill with checkpoint (last id/time), page bounds, flood-wai... | - | TODO |
| T02.4 | Session-date derivation function with versioned calendar input; fixture... | - | TODO |
| T02.5 | Labelled-sample harness (owner labels), precision/recall per field, rev... | T02.2 | TODO |
| T02.6 | Message-class taxonomy (NEW_SIGNAL/REVISION/CANCEL/EXIT_UPDATE/TARGET_U... | T02.1 | TODO |
| T02.7 | Source registry attributes and source-health view (lag, last-message ag... | - | TODO |
| T02.8 | Persisted coverage records per source/range with method, bounds and bli... | T02.3 | TODO |
