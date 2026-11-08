#!/usr/bin/env python3
"""Appends the hand-written part of migration 0041 (Stage 02 domain integrity) to the drizzle-generated SQL.
Regenerate flow (not yet applied anywhere): remove the 0041 files + journal entry, `DATABASE_URL=postgresql://x:y@localhost:5432/z drizzle-kit generate --name domain_integrity` (inside packages/database), run this script.
The referenced unique index is moved ahead of the foreign key that uses it.
Rollback (forward-only policy: write a new migration, never edit 0041): drop views paper_position_fill_check and account_portfolio_facts; drop trigger user_decisions_links_guard + function; drop functions twins_list_active_accounts / twins_list_active_account_users; drop the legacy policies and disable RLS on orders, fills, positions, portfolio_snapshots; drop the accounts / broker_connections policies and disable RLS (re-point the two stores first); drop constraint accounts_broker_owner_fk, broker_connections_credential_ref_check, index broker_connections_id_user_unique, column broker_connections.credential_ref."""
import sys
p = "packages/database/drizzle/0041_domain_integrity.sql"; s = open(p).read().rstrip("\n")
if "HAND-APPENDED (Master Build Stage 02" in s: sys.exit("already appended")
CUR = "nullif(current_setting('twins.user_id', true), '')::uuid"
GEN = "--> statement-breakpoint\n"
stmts = s.split(GEN)
moved = [x for x in stmts if 'CREATE UNIQUE INDEX "broker_connections_id_user_unique"' in x]
rest = [x for x in stmts if x not in moved]
fk = next(i for i, x in enumerate(rest) if "accounts_broker_owner_fk" in x)
s = GEN.join(rest[:fk] + moved + rest[fk:]).rstrip("\n")
o = [s]
def owner_rls(t):
    o.append(f'ALTER TABLE "{t}" ENABLE ROW LEVEL SECURITY;'); o.append(f'ALTER TABLE "{t}" FORCE ROW LEVEL SECURITY;')
    o.append(f'CREATE POLICY "{t}_owner_only" ON "{t}" USING (user_id = {CUR}) WITH CHECK (user_id = {CUR});')
o.append("-- HAND-APPENDED (Master Build Stage 02). accounts and broker_connections are user-owned, so they get the same owner-only row-level security as every other user table. Anything that must see ACCOUNTS ACROSS USERS (the worker and scheduler cycles) now uses the two SECURITY DEFINER functions below, which return identifiers only (account id, user id), never names, brokers or capital.")
owner_rls("accounts"); owner_rls("broker_connections")
o.append('''CREATE FUNCTION "twins_list_active_accounts"() RETURNS TABLE (a_account_id uuid, a_user_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT id, user_id FROM accounts WHERE is_active ORDER BY created_at, id
$$;''')
o.append('''CREATE FUNCTION "twins_list_active_account_users"(p_limit integer) RETURNS TABLE (a_user_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT DISTINCT user_id FROM accounts WHERE is_active ORDER BY user_id LIMIT least(greatest(p_limit, 1), 1000)
$$;''')
o.append("-- HAND-APPENDED. The legacy account-owned tables (orders, fills, positions, portfolio_snapshots) carry an account but no user id: they get owner-only policies through the account, so no runtime path can read another user's legacy rows either. The runtime role is read-only on orders, fills and positions (app-role.sql).")
for t in ["orders", "positions", "portfolio_snapshots"]:
    o.append(f'ALTER TABLE "{t}" ENABLE ROW LEVEL SECURITY;'); o.append(f'ALTER TABLE "{t}" FORCE ROW LEVEL SECURITY;')
    o.append(f'CREATE POLICY "{t}_owner_only" ON "{t}" USING (EXISTS (SELECT 1 FROM accounts a WHERE a.id = "{t}".account_id AND a.user_id = {CUR})) WITH CHECK (EXISTS (SELECT 1 FROM accounts a WHERE a.id = "{t}".account_id AND a.user_id = {CUR}));')
o.append('ALTER TABLE "fills" ENABLE ROW LEVEL SECURITY;'); o.append('ALTER TABLE "fills" FORCE ROW LEVEL SECURITY;')
o.append(f'CREATE POLICY "fills_owner_only" ON "fills" USING (EXISTS (SELECT 1 FROM orders o JOIN accounts a ON a.id = o.account_id WHERE o.id = "fills".order_id AND a.user_id = {CUR})) WITH CHECK (EXISTS (SELECT 1 FROM orders o JOIN accounts a ON a.id = o.account_id WHERE o.id = "fills".order_id AND a.user_id = {CUR}));')
o.append("-- HAND-APPENDED. A decision's linked risk assessment and simulation must belong to the SAME user, account AND candidate (the composite foreign keys of 0033 already pin the user; this adds account and candidate, for every outcome and not only QUALIFIED).")
o.append('''CREATE FUNCTION "twins_user_decision_links_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.risk_assessment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM risk_assessments r WHERE r.id = NEW.risk_assessment_id AND r.user_id = NEW.user_id AND r.account_id = NEW.account_id AND r.candidate_id = NEW.candidate_id) THEN
		RAISE EXCEPTION 'the risk assessment of a decision must belong to the same user, account and candidate' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.simulation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM simulations s WHERE s.id = NEW.simulation_id AND s.user_id = NEW.user_id AND s.account_id = NEW.account_id AND s.candidate_id = NEW.candidate_id) THEN
		RAISE EXCEPTION 'the simulation of a decision must belong to the same user, account and candidate' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;''')
o.append('CREATE TRIGGER "user_decisions_links_guard" BEFORE INSERT ON "user_decisions" FOR EACH ROW EXECUTE FUNCTION "twins_user_decision_links_guard"();')
o.append("-- HAND-APPENDED. Per-account portfolio facts, derived in exact decimals (SQL numeric) from the account's own open paper positions and effective capital profile. security_invoker: the CALLER's row-level security applies, so a user sees only their own accounts. allocated_notional is paper notional at entry price; margin is NOT modelled (G-25) and no live portfolio source exists (G-22), so nothing here claims a live balance.")
o.append('''CREATE VIEW "account_portfolio_facts" WITH (security_invoker = true) AS
SELECT a.id AS account_id, a.user_id,
	(SELECT count(*) FROM paper_positions p WHERE p.account_id = a.id AND p.user_id = a.user_id AND p.status = 'OPEN')::int AS open_positions,
	COALESCE((SELECT sum(p.quantity * p.avg_entry_price) FROM paper_positions p WHERE p.account_id = a.id AND p.user_id = a.user_id AND p.status = 'OPEN'), 0) AS allocated_notional,
	COALESCE((SELECT sum(p.realized_pnl) FROM paper_positions p WHERE p.account_id = a.id AND p.user_id = a.user_id), 0) AS realized_pnl,
	c.total_capital, c.available_capital, c.version AS capital_profile_version,
	CASE WHEN c.total_capital IS NULL THEN NULL ELSE c.total_capital - COALESCE((SELECT sum(p.quantity * p.avg_entry_price) FROM paper_positions p WHERE p.account_id = a.id AND p.user_id = a.user_id AND p.status = 'OPEN'), 0) END AS unallocated_capital
FROM accounts a
LEFT JOIN LATERAL (SELECT cp.total_capital, cp.available_capital, cp.version FROM user_capital_profiles cp WHERE cp.account_id = a.id AND cp.user_id = a.user_id AND cp.effective_from <= now() ORDER BY cp.effective_from DESC, cp.version DESC LIMIT 1) c ON true;''')
o.append("-- HAND-APPENDED. Position quantity is derived from fills: entry fills minus exit fills of the position's own orders. This view recomputes it so tests and operators can prove (and monitor) that the stored position agrees with the fill history.")
o.append('''CREATE VIEW "paper_position_fill_check" WITH (security_invoker = true) AS
SELECT d.position_id, d.user_id, d.position_quantity, d.entry_filled, d.exit_filled, d.entry_filled - d.exit_filled AS derived_quantity, (d.entry_filled - d.exit_filled) = d.position_quantity AS matches
FROM (
	SELECT p.id AS position_id, p.user_id, p.quantity AS position_quantity,
		COALESCE(sum(f.quantity) FILTER (WHERE o.purpose = 'ENTRY'), 0) AS entry_filled,
		COALESCE(sum(f.quantity) FILTER (WHERE o.purpose = 'EXIT'), 0) AS exit_filled
	FROM paper_positions p
	LEFT JOIN paper_orders o ON o.user_id = p.user_id AND ((o.purpose = 'EXIT' AND o.position_id = p.id) OR (o.purpose = 'ENTRY' AND o.decision_id = p.decision_id))
	LEFT JOIN paper_fills f ON f.order_id = o.id AND f.user_id = o.user_id
	GROUP BY p.id, p.user_id, p.quantity
) d;''')
open(p, "w").write("\n--> statement-breakpoint\n".join(o) + "\n")
