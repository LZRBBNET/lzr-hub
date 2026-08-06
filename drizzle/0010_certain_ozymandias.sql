CREATE TABLE "payment_promises" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"promised_for" text NOT NULL,
	"status" text NOT NULL,
	"registered_by" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
