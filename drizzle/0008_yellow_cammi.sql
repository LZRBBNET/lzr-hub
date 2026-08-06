CREATE TABLE "network_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"equipment" text NOT NULL,
	"description" text,
	"status" text NOT NULL,
	"external_event_id" text,
	"correlation_key" text NOT NULL,
	"started_at" text NOT NULL,
	"resolved_at" text,
	"raw_text" text NOT NULL,
	"parsed" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "network_alerts_correlation_idx" ON "network_alerts" USING btree ("correlation_key");