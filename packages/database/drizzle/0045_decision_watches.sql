CREATE TABLE "decision_watches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"idempotency_key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_watches_action_check" CHECK ("decision_watches"."action" in ('WATCH', 'UNWATCH')),
	CONSTRAINT "decision_watches_key_check" CHECK (length("decision_watches"."idempotency_key") between 8 and 128)
);
--> statement-breakpoint
ALTER TABLE "decision_watches" ADD CONSTRAINT "decision_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_watches" ADD CONSTRAINT "decision_watches_decision_fk" FOREIGN KEY ("decision_id","user_id") REFERENCES "public"."user_decisions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_watches_decision_idx" ON "decision_watches" USING btree ("decision_id","at");--> statement-breakpoint
CREATE INDEX "decision_watches_user_idx" ON "decision_watches" USING btree ("user_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_watches_user_key_unique" ON "decision_watches" USING btree ("user_id","idempotency_key");
--> statement-breakpoint
-- HAND-APPENDED (Master Build Stage 07, G-27). A watch is a private bookmark and evidence of the user's attention: append-only (the latest event decides), never edited or deleted.
--> statement-breakpoint
CREATE TRIGGER "decision_watches_no_update_delete" BEFORE UPDATE OR DELETE ON "decision_watches" FOR EACH ROW EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "decision_watches_no_truncate" BEFORE TRUNCATE ON "decision_watches" FOR EACH STATEMENT EXECUTE FUNCTION "twins_audit_forbid_change"();
--> statement-breakpoint
-- HAND-APPENDED. Owner-only row-level security, forced on the table owner too; with no user bound the policy matches nothing (fail closed).
--> statement-breakpoint
ALTER TABLE "decision_watches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "decision_watches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "decision_watches_owner_only" ON "decision_watches" USING (user_id = nullif(current_setting('twins.user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('twins.user_id', true), '')::uuid);
