CREATE TABLE "mass_notice_dispatches" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mass_notice_dispatches_once" ON "mass_notice_dispatches" USING btree ("incident_id","customer_id","kind");