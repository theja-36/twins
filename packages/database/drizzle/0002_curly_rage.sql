CREATE TYPE "public"."entity_type" AS ENUM('company', 'sector', 'market', 'country', 'macro');--> statement-breakpoint
CREATE TYPE "public"."match_method" AS ENUM('exact_canonical', 'exact_alias', 'ticker_exchange', 'structured_provider_id', 'deterministic_rule');--> statement-breakpoint
CREATE TYPE "public"."news_event_status" AS ENUM('reported', 'corrected', 'confirmed', 'developing');--> statement-breakpoint
CREATE TYPE "public"."news_event_type" AS ENUM('earnings', 'merger_acquisition', 'management_change', 'dividend', 'buyback', 'bankruptcy', 'regulatory_action', 'exchange_halt', 'index_rebalance', 'major_price_event', 'liquidity_event', 'interest_rate_decision', 'inflation_release', 'employment_report', 'gdp_release', 'central_bank_statement', 'sanctions', 'conflict_escalation', 'election', 'trade_restriction', 'tariff', 'oil_supply_disruption', 'commodity_move', 'currency_event');--> statement-breakpoint
CREATE TYPE "public"."relationship_strength" AS ENUM('direct', 'structural', 'potential');--> statement-breakpoint
CREATE TYPE "public"."relationship_type" AS ENUM('ISSUED_BY', 'BELONGS_TO', 'TRADED_ON', 'LOCATED_IN', 'AFFECTS', 'MENTIONS');--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"canonical_name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"alias_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_relationships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"relationship_type" "relationship_type" NOT NULL,
	"object_id" uuid NOT NULL,
	"strength" "relationship_strength" NOT NULL,
	"match_method" "match_method" NOT NULL,
	"matched_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "news_events" ADD COLUMN "event_type" "news_event_type";--> statement-breakpoint
ALTER TABLE "news_events" ADD COLUMN "status" "news_event_status" DEFAULT 'reported' NOT NULL;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_object_id_entities_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entities_type_canonical_name_unique" ON "entities" USING btree ("entity_type","canonical_name");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_aliases_entity_alias_unique" ON "entity_aliases" USING btree ("entity_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "entity_aliases_normalized_alias_idx" ON "entity_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_relationships_dedupe_unique" ON "entity_relationships" USING btree ("subject_type","subject_id","relationship_type","object_id");--> statement-breakpoint
CREATE INDEX "entity_relationships_subject_idx" ON "entity_relationships" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "entity_relationships_object_idx" ON "entity_relationships" USING btree ("object_id");