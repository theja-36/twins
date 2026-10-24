# P02 - Telegram intake completeness, classification and source health

- **State:** NOT_STARTED
- **Depends on:** P00
- **Primary requirements:** TG-01, TG-02, TG-04, TG-05, TG-06, TG-08, TG-09, TG-10, SRC-01, TG-13, TG-14, TG-15, CL-01, CL-03, CL-04
- **Also checked here (cross-phase dependencies/acceptance):** SC-01, TG-12
- **Findings (primary owner):** F-006
- **Authorization:** only the user may advance this phase. Planning files do not make it complete. Statements marked "proposed" are designs, not implementations.

Requirement statements, evidence and acceptance tests are canonical in [REQUIREMENTS_TRACEABILITY.md](../../REQUIREMENTS_TRACEABILITY.md); this file does not repeat them.

## 1. Objective and scope
Capture everything about a signal that the authorized read-only access can observe, and measure how well it is parsed.

Scope:
- Store replies, forwards and entities as structured, linked data.
- Classify and LINK follow-up messages (amendment, cancel, exit notice, result claim) to originals without applying them.
- Resumable, checkpointed, rate-limit-aware history backfill within bounds the owner approves.
- Timezone and session-date derivation rules (IST, holidays) as data, not code constants.
- Parser accuracy baseline on an owner-labelled sample and a manual-review queue for ambiguous/unsupported items.

## 2. Explicit non-goals
- No posting, editing, deleting or joining on any channel (read-only stays).
- No automatic acting on amendments/cancellations.
- No LLM parsing.

## 3. Required inputs and entry gates
- Owner confirms permission to process the channel's history (Q-003) and the backfill bounds.
- Capture start/stop remains an explicit owner action.
- Q-003 is explicitly DEFERRED (D-038): full-history backfill beyond the previously authorized pilot, archive import, coverage claims beyond verified captured material and closing the Telegram compliance row stay BLOCKED. Existing runtime permission is neither renewed, expanded nor revoked here. Q-006 is explicitly DEFERRED (D-039): parser/classification accuracy acceptance, ground-truth baseline completion and dependent review-queue acceptance stay BLOCKED; model-generated labels are never independent human ground truth.

## 4. Existing reusable components and evidence
- `services/telegram-capture/twins_capture/history.py` - windowed read, resumable state (extend bounds, keep read-only allowlist)
- `packages/ingestion/src/telegramRevisions.ts, captureEvents.ts` - revision identity and append-only events
- `packages/signals/src/options/parse.ts` - parser to measure

## 5. Subphases (independently testable)
- **2A** Replies/forwards/entities
- **2B** Seven-class classification and case-level linking
- **2C** Checkpointed history backfill and coverage records
- **2D** Time/session rules
- **2E** Parser accuracy baseline and review queue
- **2F** Source registry, source health and capture-gap detection

## 6. Detailed tasks and likely affected files (canonical task text)
| ID | Task | Likely files | Depends |
|---|---|---|---|
| T02.1 | Extend map_message/build_payload to carry reply_to, forward origin, entities; migration for provenance columns if raw_payload alone is insufficient. | services/telegram-capture/twins_capture/mapping.py, packages/database/src/schema/telegram.ts | - |
| T02.2 | Follow-up classifier (rule-based) emitting linked `message_relations` rows; unlinked/unknown remain explicit. | packages/signals/src, packages/database/src/schema/ | T02.1 |
| T02.3 | History backfill with checkpoint (last id/time), page bounds, flood-wait handling, dry-run counts and reconciliation report. | services/telegram-capture/twins_capture/history.py, state.py | - |
| T02.4 | Session-date derivation function with versioned calendar input; fixtures across IST midnight/holidays. | packages/ingestion/src, packages/signals/src | - |
| T02.5 | Labelled-sample harness (owner labels), precision/recall per field, review queue table/view. | tests/, scripts/, packages/signals/src/options | T02.2 |
| T02.6 | Message-class taxonomy (NEW_SIGNAL/REVISION/CANCEL/EXIT_UPDATE/TARGET_UPDATE/PERFORMANCE_CLAIM/COMMENTARY) + rule-based classifier with `unclassified`; classifications are append-only and versioned. | packages/signals/src, packages/database/src/schema/ | T02.1 |
| T02.7 | Source registry attributes and source-health view (lag, last-message age, gap count); gap/delay detector on source time vs observed time. | packages/database/src/schema/telegram.ts, packages/ingestion/src, scripts/ops/ | - |
| T02.8 | Persisted coverage records per source/range with method, bounds and blind spots (never implying recovery of unobserved deletions). | services/telegram-capture/twins_capture/history.py, packages/database/src/schema/ | T02.3 |

Status tracking: [TASKS.md](TASKS.md).

## 7. Data contracts and state transitions
message_relations(message_id, related_message_id, relation: reply|forward|amends|cancels|exit_notice|result_claim|unknown, rule_version, confidence, created_at) append-only. Parser result states unchanged (claim|ambiguous|unsupported). Review item states: open -> labelled|dismissed. Message class: append-only (message_id, class, rule_version, confidence, linked_case_hint). Source health: (source_id, observed_lag, last_message_at, gap_count, as_of).

## 8. External dependencies and permissions
- Owner-provided labels (sample size is an owner decision, Q-006).
- Channel-owner permission/ToS review result (P00 register).

## 9. Tests
- **Unit:** Mapping fixtures (reply, forward, entity, edit, delete); classifier fixtures; session-date fixtures.
- **Integration:** Backfill against the guarded rehearsal database: interrupted run resumes; second run adds 0 rows.
- **End-to-end:** Fake transport -> ingest endpoint -> relations stored (no real Telegram).
- **Failure-path:** Flood-wait mid-backfill persists blocked_until and exits 75.; Malformed payload quarantined, not dropped silently.; Unclassifiable message stays `unclassified`; gap detector does not invent messages.

## 10. Measurable acceptance criteria (canonical criterion text)
- A-02.1 Reply/forward fixtures round-trip with linkage intact.
- A-02.2 Every labelled follow-up fixture is classified correctly or reported in the confusion table; none is auto-applied.
- A-02.3 Backfill totals reconcile with the channel's reported range; rerun creates 0 new rows.
- A-02.4 Session-date fixtures all match expected dates.
- A-02.5 Accuracy table (per field) is produced from the owner-labelled sample and reproducible.
- A-02.6 Labelled fixtures per message class yield a confusion table; uncertain messages are `unclassified`.
- A-02.7 Gap and delay fixtures raise gap records and alerts; silence is never read as 'no messages'.
- A-02.8 Coverage records exist per source and range and state the blind spots.
- A-02.9 Ambiguous or low-confidence linking is stored as explicitly unresolved and triggers no action (D-028).

Result tracking: [ACCEPTANCE.md](ACCEPTANCE.md).

## 11. Required evidence
- Test logs, reconciliation report, accuracy table with sample size.

## 12. Rollback / recovery approach
Capture stays owner-controlled; relations are additive; backfill rows are immutable raw data (restore from backup rather than delete).

## 13. Exit gate and handoff
User accepts the accuracy baseline and coverage report and authorizes the next phase.

Handoff: [HANDOFF.md](HANDOFF.md). Test records: [TEST_EVIDENCE.md](TEST_EVIDENCE.md).
