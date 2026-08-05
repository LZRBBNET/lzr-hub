CREATE TABLE "password_reset_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"resolved_by" text,
	"resolved_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "password_reset_status_idx" ON "password_reset_requests" USING btree ("status","created_at");