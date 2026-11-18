CREATE TABLE "outbound_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"phone" text NOT NULL,
	"template" text NOT NULL,
	"status" text NOT NULL,
	"external_message_id" text,
	"detail" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_opt_outs" (
	"phone" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "network_incidents" ADD COLUMN "kind" text DEFAULT 'outage' NOT NULL;--> statement-breakpoint
ALTER TABLE "network_incidents" ADD COLUMN "scheduled_start" text;--> statement-breakpoint
ALTER TABLE "network_incidents" ADD COLUMN "scheduled_end" text;--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_messages_once_idx" ON "outbound_messages" USING btree ("kind","ref_id","customer_id");--> statement-breakpoint
CREATE INDEX "outbound_messages_created_idx" ON "outbound_messages" USING btree ("created_at");