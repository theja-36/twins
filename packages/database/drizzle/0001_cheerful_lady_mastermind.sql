CREATE TYPE "public"."quality_overall_status" AS ENUM('trusted', 'flagged', 'rejected');--> statement-breakpoint
CREATE TABLE "quality_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"source" text NOT NULL,
	"overall_status" "quality_overall_status" NOT NULL,
	"quality_score" numeric NOT NULL,
	"dimensions" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "quality_assessments_entity_idx" ON "quality_assessments" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "quality_assessments_evaluated_at_idx" ON "quality_assessments" USING btree ("evaluated_at");