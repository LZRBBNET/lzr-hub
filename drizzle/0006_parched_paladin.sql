CREATE TABLE "collection_dispatches" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"step_id" text NOT NULL,
	"scheduled_for" text NOT NULL,
	"status" text NOT NULL,
	"channel" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "collection_dispatches_once" ON "collection_dispatches" USING btree ("invoice_id","step_id","scheduled_for");