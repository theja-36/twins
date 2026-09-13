CREATE TYPE "public"."counter_thesis_severity" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."signal_validation_outcome" AS ENUM('APPROVE', 'REJECT', 'INSUFFICIENT_EVIDENCE');--> statement-breakpoint
CREATE TYPE "public"."source_reliability" AS ENUM('UNKNOWN', 'LOW', 'MODERATE', 'HIGH');--> statement-breakpoint
CREATE TABLE "signal_validations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"signal_id" uuid NOT NULL,
	"outcome" "signal_validation_outcome" NOT NULL,
	"decision_confidence" numeric NOT NULL,
	"confidence_label" text NOT NULL,
	"bull_thesis" jsonb NOT NULL,
	"bear_thesis" jsonb NOT NULL,
	"counter_thesis" jsonb NOT NULL,
	"counter_thesis_severity" "counter_thesis_severity" NOT NULL,
	"source_reliability" "source_reliability" NOT NULL,
	"source_reliability_reason" text NOT NULL,
	"rationale" text NOT NULL,
	"validated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signal_validations" ADD CONSTRAINT "signal_validations_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_validations_signal_idx" ON "signal_validations" USING btree ("signal_id");