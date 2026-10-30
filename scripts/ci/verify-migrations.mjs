// CI: after `npm run db:migrate`, verify that every checked-in migration is recorded,
// and that the 0004 structures exist. Read-only. Uses DATABASE_URL (CI-only database).
import fs from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const journal = JSON.parse(fs.readFileSync("packages/database/drizzle/meta/_journal.json", "utf8"));
const expected = journal.entries.length;

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query("select count(*)::int as n from drizzle.__drizzle_migrations");
  if (rows[0].n !== expected) throw new Error(`migrations recorded ${rows[0].n}, expected ${expected}`);
  const cols = await client.query(
    `select table_name || '.' || column_name as c from information_schema.columns
     where (table_name, column_name) in (('signals','parser_version'),('signal_validations','idempotency_key'),
       ('telegram_sources','chat_id'),('telegram_messages','origin_message_id'),('telegram_messages','edit_date'))`,
  );
  if (cols.rowCount !== 5) throw new Error(`expected 5 new columns from 0004, found ${cols.rowCount}`);
  const def = await client.query(
    "select column_default from information_schema.columns where table_name='signals' and column_name='parser_version'",
  );
  if (def.rows[0].column_default !== null) throw new Error("signals.parser_version must have no default");
  // 0007: capture provenance columns, the append-only events table and its trigger (read-only catalog checks).
  const capCols = await client.query(
    `select column_name from information_schema.columns
     where table_name = 'telegram_messages' and column_name in ('capture_method','observed_at','imported_at','first_seen_edited')`,
  );
  if (capCols.rowCount !== 4) throw new Error(`expected 4 capture provenance columns from 0007, found ${capCols.rowCount}`);
  const events = await client.query("select to_regclass('public.telegram_message_events') is not null as ok");
  if (!events.rows[0].ok) throw new Error("telegram_message_events (0007) is missing");
  const triggers = await client.query(
    `select tgname from pg_trigger
     where tgrelid = 'public.telegram_message_events'::regclass and not tgisinternal order by tgname`,
  );
  const names = triggers.rows.map((r) => r.tgname).join(",");
  if (names !== "telegram_message_events_no_truncate,telegram_message_events_no_update_delete") {
    throw new Error(`append-only triggers missing or unexpected on telegram_message_events: [${names}]`);
  }
  // 0008: approval-bot tables; the review log and event log are append-only (read-only catalog checks).
  for (const t of ["claim_review_cards", "claim_reviews", "approval_bot_events", "approval_bot_state"]) {
    const r = await client.query("select to_regclass($1) is not null as ok", [`public.${t}`]);
    if (!r.rows[0].ok) throw new Error(`${t} (0008) is missing`);
  }
  for (const t of ["claim_reviews", "approval_bot_events"]) {
    const tr = await client.query(
      "select tgname from pg_trigger where tgrelid = $1::regclass and not tgisinternal order by tgname",
      [`public.${t}`],
    );
    const got = tr.rows.map((r) => r.tgname).join(",");
    if (got !== `${t}_no_truncate,${t}_no_update_delete`) throw new Error(`append-only triggers missing or unexpected on ${t}: [${got}]`);
  }
  // 0009: runtime safety controls: three seeded rows with the documented defaults, one seed event each, and the guard/audit/append-only triggers.
  const controls = await client.query("select control_name, value from system_controls order by control_name");
  const got = controls.rows.map((r) => `${r.control_name}=${r.value}`).join(",");
  if (controls.rowCount !== 3 || !/INTAKE_ENABLED=(true|false),KILL_SWITCH_ACTIVE=(true|false),TRADING_ENABLED=(true|false)/.test(got)) throw new Error(`system_controls (0009) must hold exactly the three controls, found [${got}]`);
  const seeds = await client.query("select count(*)::int as n from system_control_events where event_type = 'seed'");
  if (seeds.rows[0].n !== 3) throw new Error(`expected 3 seed events from 0009, found ${seeds.rows[0].n}`);
  for (const [table, want] of [
    ["system_controls", "system_controls_audit_insert,system_controls_audit_update,system_controls_before_update,system_controls_no_delete,system_controls_no_truncate"],
    ["system_control_events", "system_control_events_chain_after_insert,system_control_events_chain_before_insert,system_control_events_no_truncate,system_control_events_no_update_delete"], // (0009 created the two append-only guards; 0010 added the chain triggers)
  ]) {
    const tr = await client.query("select tgname from pg_trigger where tgrelid = $1::regclass and not tgisinternal order by tgname", [`public.${table}`]);
    const names9 = tr.rows.map((r) => r.tgname).join(",");
    if (names9 !== want) throw new Error(`triggers missing or unexpected on ${table}: [${names9}]`);
  }
  // 0010: append-only + hash chain on the five audit tables, the chain heads, and the guard triggers (all ENABLE ALWAYS). Read-only catalog checks;
  // the data itself is checked by the audit verifier (npm run audit:verify).
  for (const t of ["audit_events", "signal_validations", "telegram_messages", "options_claims", "system_control_events"]) {
    const cols = await client.query("select column_name from information_schema.columns where table_name = $1 and column_name in ('chain_index','previous_hash','payload_hash','event_hash')", [t]);
    if (cols.rowCount !== 4) throw new Error(`${t} must have the 4 chain columns from 0010, found ${cols.rowCount}`);
    const tg = await client.query("select tgname, tgenabled from pg_trigger where tgrelid = $1::regclass and not tgisinternal and tgname like any (array[$2, $3, $4, $5]) order by tgname", [`public.${t}`, `${t}_chain_before_insert`, `${t}_chain_after_insert`, `${t}_no_update_delete`, `${t}_no_truncate`]);
    if (tg.rowCount !== 4 || tg.rows.some((r) => r.tgenabled !== "A")) throw new Error(`guard/chain triggers on ${t} missing or not ENABLE ALWAYS: [${tg.rows.map((r) => `${r.tgname}:${r.tgenabled}`).join(",")}]`);
  }
  const heads = await client.query("select count(*)::int as n from audit_chain_heads");
  if (heads.rows[0].n !== 32) throw new Error(`audit_chain_heads must hold 32 chains, found ${heads.rows[0].n}`);
  const mech = await client.query("select count(*)::int as n from information_schema.columns where table_name = 'system_control_events' and column_name in ('change_mechanism','source_process','operator_context','db_session_user','db_client_addr','db_application_name')");
  if (mech.rows[0].n !== 6) throw new Error("system_control_events must have the 6 operator-context columns from 0010");
  // 0011: stop-loss evidence table (chained, append-only), the APPROVE invariant on signal_validations and the eligibility view.
  const slTriggers = await client.query("select tgname, tgenabled from pg_trigger where tgrelid = 'public.stop_loss_validations'::regclass and not tgisinternal order by tgname");
  const slNames = slTriggers.rows.map((r) => r.tgname).join(",");
  if (slNames !== "stop_loss_validations_chain_after_insert,stop_loss_validations_chain_before_insert,stop_loss_validations_no_truncate,stop_loss_validations_no_update_delete" || slTriggers.rows.some((r) => r.tgenabled !== "A")) throw new Error(`stop_loss_validations triggers missing or not ENABLE ALWAYS: [${slNames}]`);
  const inv = await client.query("select tgenabled from pg_trigger where tgrelid = 'public.signal_validations'::regclass and tgname = 'signal_validations_stop_loss_invariant'");
  if (inv.rowCount !== 1 || inv.rows[0].tgenabled !== "A") throw new Error("signal_validations_stop_loss_invariant (0011) is missing or not ENABLE ALWAYS");
  const view = await client.query("select to_regclass('public.signal_validation_eligibility') is not null as ok");
  if (!view.rows[0].ok) throw new Error("signal_validation_eligibility (0011) is missing");
  // 0012: durable Telegram intake outbox: the table, the identity unique index and the ENABLE ALWAYS guard triggers (read-only catalog checks).
  const outbox = await client.query("select to_regclass('public.telegram_intake_outbox') is not null as ok");
  if (!outbox.rows[0].ok) throw new Error("telegram_intake_outbox (0012) is missing");
  const idx = await client.query("select 1 from pg_indexes where tablename = 'telegram_intake_outbox' and indexname = 'telegram_intake_outbox_identity_unique' and indexdef like '%UNIQUE%'");
  if (idx.rowCount !== 1) throw new Error("telegram_intake_outbox_identity_unique (0012) is missing");
  const obTriggers = await client.query("select tgname, tgenabled from pg_trigger where tgrelid = 'public.telegram_intake_outbox'::regclass and not tgisinternal order by tgname");
  const obNames = obTriggers.rows.map((r) => r.tgname).join(",");
  if (obNames !== "telegram_intake_outbox_guard,telegram_intake_outbox_no_truncate" || obTriggers.rows.some((r) => r.tgenabled !== "A")) throw new Error(`telegram_intake_outbox triggers missing or not ENABLE ALWAYS: [${obNames}]`);
  // 0013: operator replay log (append-only, owner-only) and the amended outbox guard that allows ONLY an audited DEAD_LETTER -> PENDING replay.
  const replays = await client.query("select tgname, tgenabled from pg_trigger where tgrelid = 'public.telegram_intake_outbox_replays'::regclass and not tgisinternal order by tgname");
  const rn = replays.rows.map((r) => r.tgname).join(",");
  if (rn !== "telegram_intake_outbox_replays_no_truncate,telegram_intake_outbox_replays_no_update_delete" || replays.rows.some((r) => r.tgenabled !== "A")) throw new Error(`telegram_intake_outbox_replays triggers missing or not ENABLE ALWAYS: [${rn}]`);
  const guard = await client.query("select pg_get_functiondef('telegram_intake_outbox_guard'::regproc) as d");
  if (!/only an audited operator replay/.test(guard.rows[0].d)) throw new Error("telegram_intake_outbox_guard (0013 replay rule) is missing");
  // 0014: immutable risk decisions: chain + integrity triggers ENABLE ALWAYS, the derived view, the orders guard, and no legacy rows reinterpreted.
  const rd = await client.query("select tgname, tgenabled from pg_trigger where tgrelid = 'public.risk_decisions'::regclass and not tgisinternal order by tgname");
  const rdNames = rd.rows.map((r) => r.tgname).join(",");
  if (rdNames !== "risk_decisions_a_integrity_before_insert,risk_decisions_b_breaker_before_insert,risk_decisions_chain_after_insert,risk_decisions_chain_before_insert,risk_decisions_no_truncate,risk_decisions_no_update_delete" || rd.rows.some((r) => r.tgenabled !== "A")) throw new Error(`risk_decisions triggers missing or not ENABLE ALWAYS: [${rdNames}]`);
  const rdView = await client.query("select to_regclass('public.risk_decisions_effective') is not null as ok");
  if (!rdView.rows[0].ok) throw new Error("risk_decisions_effective (0014) is missing");
  const ordersGuard = await client.query("select tgenabled from pg_trigger where tgrelid = 'public.orders'::regclass and tgname = 'orders_require_risk_decision'");
  if (ordersGuard.rowCount !== 1 || ordersGuard.rows[0].tgenabled !== "A") throw new Error("orders_require_risk_decision (0014) is missing or not ENABLE ALWAYS");
  const rdCols = await client.query("select count(*)::int as n from information_schema.columns where table_name = 'risk_decisions' and column_name in ('stop_loss_validation_id','supersedes_id','decision_version','status','input_snapshot','evidence_references','event_hash','chain_index')");
  if (rdCols.rows[0].n !== 8) throw new Error("risk_decisions (0014) is missing required columns");
  // 0015: an APPROVED_FOR_REVIEW decision must carry a SIZED position size (enforced on every new row).
  const sizedCheck = await client.query("select 1 from pg_constraint where conrelid = 'public.risk_decisions'::regclass and conname = 'risk_decisions_sized_review_check'");
  if (sizedCheck.rowCount !== 1) throw new Error("risk_decisions_sized_review_check (0015) is missing");
  // 0016: an APPROVED_FOR_REVIEW decision must carry a passing portfolio evaluation (enforced on every new row).
  const portfolioCheck = await client.query("select 1 from pg_constraint where conrelid = 'public.risk_decisions'::regclass and conname = 'risk_decisions_portfolio_review_check'");
  if (portfolioCheck.rowCount !== 1) throw new Error("risk_decisions_portfolio_review_check (0016) is missing");
  // 0017: loss events and circuit-breaker events (chained, append-only), the breaker gate on approvals and orders.
  for (const [table, trigger] of [["loss_events", "loss_events_no_update_delete"], ["circuit_breaker_events", "circuit_breaker_events_no_update_delete"], ["circuit_breaker_events", "circuit_breaker_events_a_integrity_before_insert"], ["risk_decisions", "risk_decisions_b_breaker_before_insert"]]) {
    const t = await client.query("select tgenabled from pg_trigger where tgrelid = $1::regclass and tgname = $2", [`public.${table}`, trigger]);
    if (t.rowCount !== 1 || t.rows[0].tgenabled !== "A") throw new Error(`${trigger} (0017) is missing or not ENABLE ALWAYS`);
  }
  const breakerFn = await client.query("select 1 from pg_proc where proname = 'twins_circuit_breaker_open'");
  if (breakerFn.rowCount !== 1) throw new Error("twins_circuit_breaker_open (0017) is missing");
  // 0018: event blackout windows (chained, append-only) and the market-risk review check on approvals.
  for (const trigger of ["event_blackout_windows_no_update_delete", "event_blackout_windows_a_integrity_before_insert", "event_blackout_windows_chain_before_insert"]) {
    const t = await client.query("select tgenabled from pg_trigger where tgrelid = 'public.event_blackout_windows'::regclass and tgname = $1", [trigger]);
    if (t.rowCount !== 1 || t.rows[0].tgenabled !== "A") throw new Error(`${trigger} (0018) is missing or not ENABLE ALWAYS`);
  }
  const marketCheck = await client.query("select 1 from pg_constraint where conrelid = 'public.risk_decisions'::regclass and conname = 'risk_decisions_market_review_check'");
  if (marketCheck.rowCount !== 1) throw new Error("risk_decisions_market_review_check (0018) is missing");
  // 0019: risk approvals (chained, append-only), the card guard and the SECURITY DEFINER doors (not executable by PUBLIC).
  for (const [table, trigger] of [["risk_approvals", "risk_approvals_no_update_delete"], ["risk_approvals", "risk_approvals_a_integrity_before_insert"], ["risk_approval_cards", "risk_approval_cards_guard"], ["risk_approval_cards", "risk_approval_cards_no_delete"]]) {
    const t = await client.query("select tgenabled from pg_trigger where tgrelid = $1::regclass and tgname = $2", [`public.${table}`, trigger]);
    if (t.rowCount !== 1 || t.rows[0].tgenabled !== "A") throw new Error(`${trigger} (0019) is missing or not ENABLE ALWAYS`);
  }
  for (const fn of ["twins_record_risk_approval(uuid,uuid,text,text,jsonb,text,timestamptz)", "twins_risk_card_mark_sent(uuid,bigint,text)", "twins_risk_card_expire_due()"]) {
    const f = await client.query("select p.prosecdef as definer from pg_proc p where p.oid = $1::regprocedure", [fn]);
    if (f.rowCount !== 1 || f.rows[0].definer !== true) throw new Error(`${fn} (0019) must be SECURITY DEFINER`); // (the REVOKE from PUBLIC is a privilege, which restore drills deliberately do not restore: it is asserted by the integration tests)
  }
  // 0020: historical import evidence (chained, append-only) and its append-only companions.
  for (const [table, trigger] of [["historical_source_records", "historical_source_records_no_update_delete"], ["historical_source_records", "historical_source_records_a_integrity_before_insert"], ["historical_import_batches", "historical_import_batches_no_update_delete"], ["historical_normalized_records", "historical_normalized_records_no_update_delete"], ["historical_import_issues", "historical_import_issues_no_update_delete"], ["historical_import_checkpoints", "historical_import_checkpoints_no_truncate"]]) {
    const t = await client.query("select tgenabled from pg_trigger where tgrelid = $1::regclass and tgname = $2", [`public.${table}`, trigger]);
    if (t.rowCount !== 1 || t.rows[0].tgenabled !== "A") throw new Error(`${trigger} (0020) is missing or not ENABLE ALWAYS`);
  }
  // 0021: historical outcome evaluation (four chained, append-only tables; the label table also has its integrity guard).
  for (const [table, trigger] of [["historical_datasets", "historical_datasets_no_update_delete"], ["historical_datasets", "historical_datasets_chain_before_insert"], ["historical_evaluation_runs", "historical_evaluation_runs_no_update_delete"], ["historical_evaluation_runs", "historical_evaluation_runs_chain_before_insert"], ["historical_outcome_labels", "historical_outcome_labels_no_update_delete"], ["historical_outcome_labels", "historical_outcome_labels_a_integrity_before_insert"], ["historical_evaluation_events", "historical_evaluation_events_no_update_delete"], ["historical_evaluation_events", "historical_evaluation_events_no_truncate"]]) {
    const t = await client.query("select tgenabled from pg_trigger where tgrelid = $1::regclass and tgname = $2", [`public.${table}`, trigger]);
    if (t.rowCount !== 1 || t.rows[0].tgenabled !== "A") throw new Error(`${trigger} (0021) is missing or not ENABLE ALWAYS`);
  }
  // 0022: source scorecards and trust tiers (five chained, append-only tables).
  for (const table of ["historical_source_registry", "historical_scorecard_runs", "historical_scorecard_metrics", "historical_trust_tiers", "historical_scorecard_events"]) {
    for (const trigger of [`${table}_no_update_delete`, `${table}_chain_before_insert`, `${table}_no_truncate`]) {
      const t = await client.query("select tgenabled from pg_trigger where tgrelid = $1::regclass and tgname = $2", [`public.${table}`, trigger]);
      if (t.rowCount !== 1 || t.rows[0].tgenabled !== "A") throw new Error(`${trigger} (0022) is missing or not ENABLE ALWAYS`);
    }
  }
  // 0023: historical pattern library and confidence (five chained, append-only tables).
  for (const table of ["historical_pattern_definitions", "historical_pattern_runs", "historical_pattern_snapshots", "historical_confidence_runs", "historical_confidence_estimates"]) {
    for (const trigger of [`${table}_no_update_delete`, `${table}_chain_before_insert`, `${table}_no_truncate`]) {
      const t = await client.query("select tgenabled from pg_trigger where tgrelid = $1::regclass and tgname = $2", [`public.${table}`, trigger]);
      if (t.rowCount !== 1 || t.rows[0].tgenabled !== "A") throw new Error(`${trigger} (0023) is missing or not ENABLE ALWAYS`);
    }
  }
  // 0024: the SECURITY DEFINER approval function must refuse an approval without valid source intelligence.
  const fn = await client.query("select prosecdef, pg_get_functiondef(oid) as def from pg_proc where proname = 'twins_record_risk_approval'");
  if (fn.rowCount !== 1 || fn.rows[0].prosecdef !== true || !fn.rows[0].def.includes("source_intelligence_not_valid")) throw new Error("twins_record_risk_approval (0024) is missing, not SECURITY DEFINER, or does not require valid source intelligence");
  // 0025: agent engine (six chained, append-only tables; a synthesis can never grant approval).
  for (const table of ["agent_definitions", "agent_orchestrator_runs", "agent_runs", "agent_findings", "agent_evidence_references", "agent_orchestrator_syntheses"]) {
    for (const trigger of [`${table}_no_update_delete`, `${table}_chain_before_insert`, `${table}_no_truncate`]) {
      const t = await client.query("select tgenabled from pg_trigger where tgrelid = $1::regclass and tgname = $2", [`public.${table}`, trigger]);
      if (t.rowCount !== 1 || t.rows[0].tgenabled !== "A") throw new Error(`${trigger} (0025) is missing or not ENABLE ALWAYS`);
    }
  }
  const noApproval = await client.query("select 1 from pg_constraint where conname = 'agent_orchestrator_syntheses_no_approval_check'");
  if (noApproval.rowCount !== 1) throw new Error("agent_orchestrator_syntheses_no_approval_check (0025) is missing");
  // 0026: agent ids may contain hyphens (signal-integrity-v1, instrument-verification-v1); the two checks keep their other rules.
  for (const [table, name] of [["agent_definitions", "agent_definitions_value_check"], ["agent_runs", "agent_runs_value_check"]]) {
    const c = await client.query("select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1 and conrelid = $2::regclass", [name, `public.${table}`]);
    if (c.rowCount !== 1 || !c.rows[0].def.includes("[a-z0-9_-]{2,40}")) throw new Error(`${name} (0026) does not accept hyphenated agent ids`);
  }
  console.log(`[ci] ${expected} migrations recorded; 0004 structures present; parser_version has no default; 0007 capture structures and append-only triggers present; 0008 approval-bot tables and append-only triggers present; 0009 system controls, seed events and triggers present; 0010 audit chains, heads and ENABLE ALWAYS guards present; 0011 stop-loss evidence chain, APPROVE invariant and eligibility view present; 0012 intake outbox, identity index and guards present; 0013 replay log and guarded dead-letter replay present; 0014 risk decisions (chain, integrity, view) and the orders guard present; 0015 sized-review check present; 0016 portfolio-review check present; 0017 loss/breaker chains and the breaker gate present; 0018 blackout chain and the market-review check present; 0019 approval chain, card guard and SECURITY DEFINER doors present; 0020 historical import evidence chain and append-only tables present; 0021 historical outcome chains and append-only guards present; 0022 source scorecard chains and append-only guards present; 0023 pattern and confidence chains and append-only guards present; 0024 approval function requires valid source intelligence; 0025 agent engine chains and append-only guards present; 0026 hyphenated agent ids accepted`);
} finally {
  await client.end();
}
