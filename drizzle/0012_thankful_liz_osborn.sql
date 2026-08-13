CREATE TABLE "lead_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_stage" text,
	"to_stage" text,
	"detail" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "contact_key" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "closed_at" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "lost_reason" text;--> statement-breakpoint
CREATE INDEX "lead_activities_lead_idx" ON "lead_activities" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_contact_key_idx" ON "leads" USING btree ("contact_key");