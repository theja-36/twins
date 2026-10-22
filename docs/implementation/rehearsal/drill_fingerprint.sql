-- Deterministic READ-ONLY fingerprint of a database. Output contains no database name, so the
-- outputs for source and restore must be byte-identical. Run with a read-only session.
SET TimeZone = 'UTC';
\pset format unaligned
\pset tuples_only on
\echo '## settings'
SELECT 'encoding=' || pg_encoding_to_char(encoding) || ' collate=' || datcollate || ' ctype=' || datctype FROM pg_database WHERE datname = current_database();
\echo '## schemas / extensions / enum labels'
SELECT 'schema ' || nspname FROM pg_namespace WHERE nspname IN ('public','drizzle') ORDER BY 1;
SELECT 'extension ' || extname FROM pg_extension ORDER BY 1;
SELECT 'enum ' || t.typname || ' = ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname ORDER BY 1;
\echo '## columns (name, type, nullability, default)'
SELECT table_schema||'.'||table_name||'.'||column_name||' '||data_type||' null='||is_nullable||' default='||coalesce(column_default,'-')
FROM information_schema.columns WHERE table_schema IN ('public','drizzle') ORDER BY table_schema, table_name, ordinal_position;
\echo '## indexes'
SELECT schemaname||'.'||tablename||' '||indexname||' :: '||indexdef FROM pg_indexes WHERE schemaname IN ('public','drizzle') ORDER BY 1;
\echo '## constraints'
SELECT conrelid::regclass||' '||conname||' :: '||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace IN ('public'::regnamespace,'drizzle'::regnamespace) ORDER BY 1;
\echo '## ownership and privileges'
SELECT 'table-owner ' || schemaname||'.'||tablename||' '||tableowner FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY 1;
SELECT 'relations-with-acl ' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','drizzle') AND c.relacl IS NOT NULL;
\echo '## sequences (last_value, is_called)'
SELECT 'seq drizzle.__drizzle_migrations_id_seq ' || last_value || ' called=' || is_called FROM drizzle.__drizzle_migrations_id_seq;
\echo '## migration tracking (id, hash, created_at)'
SELECT id||' '||hash||' '||created_at FROM drizzle.__drizzle_migrations ORDER BY id;
\echo '## 0004 structures'
SELECT 'col '||table_name||'.'||column_name FROM information_schema.columns WHERE (table_name,column_name) IN (('signals','parser_version'),('signal_validations','idempotency_key'),('telegram_sources','chat_id'),('telegram_messages','origin_message_id'),('telegram_messages','edit_date')) ORDER BY 1;
SELECT 'index '||indexname FROM pg_indexes WHERE indexname IN ('signals_telegram_message_parser_unique','signal_validations_idempotency_key_unique','telegram_sources_chat_id_unique','telegram_messages_origin_idx') ORDER BY 1;
\echo '## business facts (legacy / revision / validation provenance)'
SELECT 'signals parser_version=' || parser_version || ' n=' || n FROM (SELECT parser_version, count(*) AS n FROM signals GROUP BY 1) g ORDER BY 1;
SELECT 'validations key_kind=' || k || ' n=' || n FROM (
  SELECT CASE WHEN idempotency_key IS NULL THEN 'keyless'
              WHEN idempotency_key LIKE 'telegram-ingest-recompute:%' THEN 'recompute'
              WHEN idempotency_key LIKE 'telegram-ingest:%' THEN 'ingest' ELSE 'other' END AS k, count(*) AS n
  FROM signal_validations GROUP BY 1) v ORDER BY 1;
SELECT 'messages kind=' || k || ' n=' || n FROM (
  SELECT CASE WHEN edit_date IS NOT NULL THEN 'revision' WHEN origin_message_id IS NOT NULL THEN 'original-with-origin'
              WHEN external_message_id LIKE '%\_edit' THEN 'legacy-edit' ELSE 'legacy-original' END AS k, count(*) AS n
  FROM telegram_messages GROUP BY 1) m ORDER BY 1;
SELECT 'sources with chat_id=' || count(*) FILTER (WHERE chat_id IS NOT NULL) || ' without=' || count(*) FILTER (WHERE chat_id IS NULL) FROM telegram_sources;
\echo '## per-table row count and content hash (md5 over rows ordered by their text form)'
SELECT string_agg(
  format($q$SELECT %L AS tbl, count(*) AS n, coalesce(md5(string_agg(t::text, E'\n' ORDER BY t::text)), '-') AS h FROM %I.%I t$q$, schemaname||'.'||tablename, schemaname, tablename),
  ' UNION ALL ' ORDER BY schemaname, tablename) AS q
FROM pg_tables WHERE schemaname IN ('public','drizzle')
\gset
:q ORDER BY 1;
