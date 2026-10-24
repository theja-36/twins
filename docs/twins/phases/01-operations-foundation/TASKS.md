# P01 task tracker

Task text is canonical in [PLAN.md](PLAN.md) section 6. Status values: `TODO` / `IN_PROGRESS` / `DONE` / `BLOCKED`. Phase state: NOT_STARTED.

| ID | Task (short) | Depends | Status |
|---|---|---|---|
| T01.1 | Add `org.opencontainers.image.revision` + manifest hash labels to every... | - | TODO |
| T01.2 | Persistent watcher service for container state, queue depth, failed job... | T01.1 | TODO |
| T01.3 | Worker liveness signal (health file or heartbeat key) since it has no H... | - | TODO |
| T01.4 | Off-host encrypted copy + escrowed key + failure alert; scripted restor... | - | TODO |
| T01.5 | Dead-letter handling | - | TODO |
| T01.6 | CI | - | TODO |
| T01.7 | Re-inspect host SSH/exposure posture read-only and produce owner action... | - | TODO |
| T01.8 | Durable intake per the transactional-outbox design direction (D-014a) | - | TODO |
