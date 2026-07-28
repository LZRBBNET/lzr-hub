CREATE TABLE "conversation_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"intent" text NOT NULL,
	"final_status" text NOT NULL,
	"handoff" boolean DEFAULT false NOT NULL,
	"handoff_reason" text,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "csat_ratings" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"score" integer NOT NULL,
	"comment" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "conversation_outcomes_created_idx" ON "conversation_outcomes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "conversation_outcomes_conversation_idx" ON "conversation_outcomes" USING btree ("channel","external_conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "csat_ratings_conversation_idx" ON "csat_ratings" USING btree ("channel","external_conversation_id");--> statement-breakpoint
CREATE INDEX "csat_ratings_created_idx" ON "csat_ratings" USING btree ("created_at");