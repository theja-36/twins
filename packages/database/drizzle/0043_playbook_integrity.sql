-- HAND-WRITTEN (Master Build Stage 03 closure). Playbook versions were protected only by the application service: a direct UPDATE could rewrite a version's content or jump its state. The database now enforces the same rules, whatever code runs:
--  * a version starts as a DRAFT; its identity, content and creation time never change (a change is a NEW version) and it is never deleted;
--  * only legal state moves: DRAFT -> EVALUATING | RETIRED; EVALUATING -> ACTIVE | DRAFT | RETIRED; ACTIVE -> RETIRED | ROLLED_BACK; RETIRED -> ACTIVE (rollback of an earlier evaluated version); ROLLED_BACK is final;
--  * ACTIVE needs recorded performance and at least 30 resolved cases (the owner / out-of-sample / no-drift rules stay in the service, which also keeps the audit events);
--  * once a version is ACTIVE, RETIRED or ROLLED_BACK its evidence (performance, sample size, confidence, limitations) is frozen.
-- Rollback (forward-only: write a new migration, never edit 0043): drop trigger playbook_versions_guard_write / playbook_versions_guard_delete and function twins_playbook_version_guard.
CREATE FUNCTION "twins_playbook_version_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'a playbook version is never deleted' USING ERRCODE = 'check_violation';
	END IF;
	IF TG_OP = 'INSERT' THEN
		IF NEW.state <> 'DRAFT' THEN RAISE EXCEPTION 'a playbook version starts as a DRAFT' USING ERRCODE = 'check_violation'; END IF;
		RETURN NEW;
	END IF;
	IF NEW.id <> OLD.id OR NEW.playbook_id <> OLD.playbook_id OR NEW.version <> OLD.version OR NEW.content IS DISTINCT FROM OLD.content OR NEW.created_at <> OLD.created_at THEN
		RAISE EXCEPTION 'the identity, content and creation time of a playbook version never change: propose a new version' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.state <> OLD.state THEN
		IF NOT ((OLD.state = 'DRAFT' AND NEW.state IN ('EVALUATING', 'RETIRED'))
		     OR (OLD.state = 'EVALUATING' AND NEW.state IN ('ACTIVE', 'DRAFT', 'RETIRED'))
		     OR (OLD.state = 'ACTIVE' AND NEW.state IN ('RETIRED', 'ROLLED_BACK'))
		     OR (OLD.state = 'RETIRED' AND NEW.state = 'ACTIVE')) THEN
			RAISE EXCEPTION 'illegal playbook version transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.state = 'ACTIVE' AND (NEW.performance IS NULL OR NEW.sample_size < 30) THEN
			RAISE EXCEPTION 'a playbook version needs recorded performance and at least 30 resolved cases to be ACTIVE' USING ERRCODE = 'check_violation';
		END IF;
	ELSIF OLD.state IN ('ACTIVE', 'RETIRED', 'ROLLED_BACK') AND (NEW.performance IS DISTINCT FROM OLD.performance OR NEW.sample_size <> OLD.sample_size OR NEW.confidence IS DISTINCT FROM OLD.confidence OR NEW.limitations <> OLD.limitations) THEN
		RAISE EXCEPTION 'the evidence of an activated or finished playbook version is frozen' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "playbook_versions_guard_write" BEFORE INSERT OR UPDATE ON "playbook_versions" FOR EACH ROW EXECUTE FUNCTION "twins_playbook_version_guard"();
--> statement-breakpoint
CREATE TRIGGER "playbook_versions_guard_delete" BEFORE DELETE ON "playbook_versions" FOR EACH ROW EXECUTE FUNCTION "twins_playbook_version_guard"();
