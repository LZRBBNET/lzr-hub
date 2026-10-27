CREATE TABLE "recovery_case_events" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_id" text NOT NULL,
	"case_id" text NOT NULL,
	"type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" text NOT NULL,
	"correlation_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"evidence" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"owner_id" text,
	"next_action_on" text,
	"invoice_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"promise_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attendance_ticket_id" text,
	"opened_at" text NOT NULL,
	"closed_at" text,
	"closing_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "recovery_cases_scope_id" UNIQUE("scope_id","id"),
	CONSTRAINT "recovery_cases_status_check" CHECK ("recovery_cases"."status" in ('open','in_progress','waiting','closed')),
	CONSTRAINT "recovery_cases_reason_check" CHECK ("recovery_cases"."reason" in ('debt','cancellation','both')),
	CONSTRAINT "recovery_cases_version_check" CHECK ("recovery_cases"."version" > 0),
	CONSTRAINT "recovery_cases_closure_check" CHECK ((("recovery_cases"."status" = 'closed') and "recovery_cases"."closed_at" is not null and "recovery_cases"."closing_reason" is not null) or (("recovery_cases"."status" <> 'closed') and "recovery_cases"."closed_at" is null and "recovery_cases"."closing_reason" is null)),
	CONSTRAINT "recovery_cases_invoice_links_check" CHECK (jsonb_typeof("recovery_cases"."invoice_ids") = 'array' and jsonb_array_length("recovery_cases"."invoice_ids") <= 20),
	CONSTRAINT "recovery_cases_promise_links_check" CHECK (jsonb_typeof("recovery_cases"."promise_ids") = 'array' and jsonb_array_length("recovery_cases"."promise_ids") <= 20)
);
--> statement-breakpoint
ALTER TABLE "recovery_case_events" ADD CONSTRAINT "recovery_case_events_scope_case_fk" FOREIGN KEY ("scope_id","case_id") REFERENCES "public"."recovery_cases"("scope_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_case_events_idempotency" ON "recovery_case_events" USING btree ("scope_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "recovery_case_events_history" ON "recovery_case_events" USING btree ("scope_id","case_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_cases_one_active_customer" ON "recovery_cases" USING btree ("scope_id","customer_id") WHERE "recovery_cases"."status" <> 'closed';--> statement-breakpoint
CREATE INDEX "recovery_cases_due" ON "recovery_cases" USING btree ("scope_id","status","next_action_on");--> statement-breakpoint
CREATE INDEX "recovery_cases_owner" ON "recovery_cases" USING btree ("scope_id","owner_id","status");