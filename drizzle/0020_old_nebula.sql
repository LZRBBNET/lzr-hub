CREATE TABLE "support_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" serial NOT NULL,
	"protocol" text,
	"channel" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"status" text NOT NULL,
	"opened_at" text NOT NULL,
	"last_customer_at" text NOT NULL,
	"closed_at" text,
	"closed_reason" text,
	"identification" text NOT NULL,
	"ixc_customer_id" text,
	"intent" text,
	"intent_source" text,
	"intent_confidence" integer,
	"queue" text,
	"stage" text NOT NULL,
	"protocol_sent_at" text,
	"diagnosis" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_open_idx" ON "support_tickets" USING btree ("channel","external_conversation_id") WHERE "support_tickets"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_protocol_idx" ON "support_tickets" USING btree ("protocol");--> statement-breakpoint
CREATE INDEX "support_tickets_conversation_idx" ON "support_tickets" USING btree ("external_conversation_id");