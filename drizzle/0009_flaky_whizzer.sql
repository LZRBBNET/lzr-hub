CREATE TABLE "ixc_write_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"customer_id" text NOT NULL,
	"invoice_id" text,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"detail" text,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ixc_write_operations_idempotency" ON "ixc_write_operations" USING btree ("operation","idempotency_key");