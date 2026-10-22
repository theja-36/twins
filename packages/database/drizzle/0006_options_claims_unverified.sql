CREATE TABLE "options_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"telegram_message_id" uuid NOT NULL,
	"parser_version" text NOT NULL,
	"result_kind" text NOT NULL,
	"claim" jsonb,
	"detail" jsonb,
	"assessment_outcome" text,
	"reasons" jsonb NOT NULL,
	"verification" jsonb,
	"premium" jsonb,
	"provenance" jsonb NOT NULL,
	"approval_possible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "options_claims_result_kind_check" CHECK ("options_claims"."result_kind" in ('claim', 'ambiguous', 'unsupported')),
	CONSTRAINT "options_claims_claim_shape_check" CHECK (("options_claims"."result_kind" = 'claim') = ("options_claims"."claim" is not null)),
	CONSTRAINT "options_claims_never_approvable_check" CHECK ("options_claims"."approval_possible" = false)
);
--> statement-breakpoint
ALTER TABLE "options_claims" ADD CONSTRAINT "options_claims_telegram_message_id_telegram_messages_id_fk" FOREIGN KEY ("telegram_message_id") REFERENCES "public"."telegram_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "options_claims_message_parser_unique" ON "options_claims" USING btree ("telegram_message_id","parser_version");--> statement-breakpoint
CREATE INDEX "options_claims_message_idx" ON "options_claims" USING btree ("telegram_message_id");