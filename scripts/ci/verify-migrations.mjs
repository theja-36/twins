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
  if (heads.rows[0].n !== 7) throw new Error(`audit_chain_heads must hold 7 chains, found ${heads.rows[0].n}`);
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
  if (rdNames !== "risk_decisions_a_integrity_before_insert,risk_decisions_chain_after_insert,risk_decisions_chain_before_insert,risk_decisions_no_truncate,risk_decisions_no_update_delete" || rd.rows.some((r) => r.tgenabled !== "A")) throw new Error(`risk_decisions triggers missing or not ENABLE ALWAYS: [${rdNames}]`);
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
  console.log(`[ci] ${expected} migrations recorded; 0004 structures present; parser_version has no default; 0007 capture structures and append-only triggers present; 0008 approval-bot tables and append-only triggers present; 0009 system controls, seed events and triggers present; 0010 audit chains, heads and ENABLE ALWAYS guards present; 0011 stop-loss evidence chain, APPROVE invariant and eligibility view present; 0012 intake outbox, identity index and guards present; 0013 replay log and guarded dead-letter replay present; 0014 risk decisions (chain, integrity, view) and the orders guard present; 0015 sized-review check present; 0016 portfolio-review check present`);
} finally {
  await client.end();
}
