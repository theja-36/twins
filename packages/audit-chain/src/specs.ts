/**
 * The hash-chain specification, TypeScript side. It MUST agree with migration 0010 (`twins_audit_payload_*` and the chain trigger);
 * tests/integration/auditChain/auditChain.test.ts proves that the independent computation here equals what the database stored.
 *
 *   payload       = JSON.stringify([<field 0>, <field 1>, ...])     each field is a string or null, rendered by the SQL expression below
 *   payload_hash  = sha256(payload)                                 hex
 *   event_hash    = sha256("TWINS-AUDIT-V1" LF chain LF chain_index LF previous_hash LF payload_hash)   hex
 *   genesis previous_hash = 64 zeros
 *
 * JSON.stringify of an array of strings/null and PostgreSQL's to_json(text[]) are byte-identical (same escapes: \" \\ \b \f \n \r \t and
 * \u00xx for the other control characters; everything else, including U+2028/2029 and non-BMP characters, is emitted raw).
 * Adding or changing a content column of a chained table changes its payload and REQUIRES a new payload version (new domain string, new
 * functions, a re-chaining migration plan); see docs/twins/IMMUTABLE_AUDIT.md.
 */
export const HASH_DOMAIN = "TWINS-AUDIT-V1";
export const GENESIS_HASH = "0".repeat(64);

/** UTC microsecond ISO-8601 rendering, inline SQL (identical to twins_audit_ts in the database). */
const ts = (col: string): string => `CASE WHEN ${col} IS NULL THEN NULL ELSE to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END`;
const txt = (col: string): string => `${col}::text`;
const plain = (col: string): string => col;

export interface ChainSpec {
  /** Chain name = table name. Part of every event hash. */
  readonly chain: string;
  readonly table: string;
  /** SQL expressions (over alias t) in payload order. */
  readonly fields: readonly string[];
  /** Triggers that must exist on the table and be ENABLE ALWAYS ('A'). */
  readonly triggers: readonly string[];
}

const guards = (t: string): string[] => [`${t}_chain_before_insert`, `${t}_chain_after_insert`, `${t}_no_update_delete`, `${t}_no_truncate`];

export const CHAIN_SPECS: readonly ChainSpec[] = [
  {
    chain: "audit_events",
    table: "audit_events",
    fields: [txt("t.id"), plain("t.event_type"), plain("t.entity_type"), txt("t.entity_id"), txt("t.actor_type"), plain("t.actor_id"), txt("t.before_state"), txt("t.after_state"), txt("t.metadata"), ts("t.created_at")],
    triggers: guards("audit_events"),
  },
  {
    chain: "system_control_events",
    table: "system_control_events",
    fields: [
      txt("t.id"), plain("t.control_name"), txt("t.previous_value"), txt("t.new_value"), plain("t.reason"), plain("t.changed_by"), ts("t.changed_at"), txt("t.version"), plain("t.event_type"),
      plain("t.change_mechanism"), plain("t.source_process"), txt("t.operator_context"), plain("t.db_session_user"), plain("t.db_client_addr"), plain("t.db_application_name"), ts("t.created_at"),
    ],
    triggers: guards("system_control_events"),
  },
  {
    chain: "signal_validations",
    table: "signal_validations",
    fields: [
      txt("t.id"), txt("t.signal_id"), txt("t.outcome"), txt("t.decision_confidence"), plain("t.confidence_label"), txt("t.bull_thesis"), txt("t.bear_thesis"), txt("t.counter_thesis"),
      txt("t.counter_thesis_severity"), txt("t.source_reliability"), plain("t.source_reliability_reason"), plain("t.rationale"), plain("t.idempotency_key"), ts("t.validated_at"), ts("t.created_at"),
    ],
    triggers: guards("signal_validations"),
  },
  {
    chain: "telegram_messages",
    table: "telegram_messages",
    fields: [
      txt("t.id"), txt("t.telegram_source_id"), plain("t.external_message_id"), ts("t.message_timestamp"), ts("t.received_at"), plain("t.origin_message_id"), ts("t.edit_date"), plain("t.raw_text"),
      txt("t.raw_payload"), plain("t.capture_method"), ts("t.observed_at"), ts("t.imported_at"), txt("t.first_seen_edited"), ts("t.created_at"),
    ],
    triggers: guards("telegram_messages"),
  },
  {
    chain: "stop_loss_validations",
    table: "stop_loss_validations",
    fields: [
      txt("t.id"), plain("t.subject_kind"), txt("t.signal_id"), txt("t.options_claim_id"), plain("t.idempotency_key"), plain("t.rule_version"), plain("t.result"), plain("t.reason_code"), plain("t.detail"),
      plain("t.instrument_type"), plain("t.instrument_kind"), plain("t.side"), plain("t.option_type"), plain("t.level_basis"), plain("t.original_stop_loss"), txt("t.normalized_stop_loss"), txt("t.entry_price"),
      txt("t.risk_distance"), txt("t.risk_pct"), txt("t.max_risk_pct"), plain("t.max_risk_source"), plain("t.expected_stop_side"), ts("t.created_at"),
    ],
    triggers: guards("stop_loss_validations"),
  },
  {
    chain: "options_claims",
    table: "options_claims",
    fields: [
      txt("t.id"), txt("t.telegram_message_id"), plain("t.parser_version"), plain("t.result_kind"), txt("t.claim"), txt("t.detail"), plain("t.assessment_outcome"), txt("t.reasons"),
      txt("t.verification"), txt("t.premium"), txt("t.provenance"), txt("t.approval_possible"), ts("t.created_at"),
    ],
    triggers: guards("options_claims"),
  },
];

/** Extra protection that is not a per-table chain trigger. */
export const HEADS_TABLE = "audit_chain_heads";
export const HEADS_TRIGGERS = ["audit_chain_heads_guard", "audit_chain_heads_no_truncate"] as const;
/** Invariant triggers that are not part of a chain but protect a rule (the mandatory stop-loss on approvals). */
export const INVARIANT_TRIGGERS: ReadonlyArray<readonly [table: string, trigger: string]> = [["signal_validations", "signal_validations_stop_loss_invariant"]];
export const SYSTEM_CONTROLS_TRIGGERS = ["system_controls_before_update", "system_controls_audit_insert", "system_controls_audit_update", "system_controls_no_delete", "system_controls_no_truncate"] as const;
export const DDL_WATCH = "twins_audit_ddl_watch";
export const PROTECTED_TABLES = CHAIN_SPECS.map((s) => s.table);
