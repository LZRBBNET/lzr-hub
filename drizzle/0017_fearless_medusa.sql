CREATE TABLE "contract_audit_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"actor" text,
	"started_at" text NOT NULL,
	"finished_at" text,
	"new_checked" integer DEFAULT 0 NOT NULL,
	"rechecked" integer DEFAULT 0 NOT NULL,
	"resolved" integer DEFAULT 0 NOT NULL,
	"stopped_reason" text,
	"correlation_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_audits" (
	"contract_id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"customer_name" text,
	"plan" text,
	"contract_status" text,
	"contract_created_at" text,
	"seller_id" text,
	"status" text NOT NULL,
	"issues" jsonb NOT NULL,
	"first_issues" jsonb NOT NULL,
	"detail" text,
	"checks" integer DEFAULT 1 NOT NULL,
	"first_checked_at" text NOT NULL,
	"last_checked_at" text NOT NULL,
	"resolved_at" text
);
--> statement-breakpoint
CREATE INDEX "contract_audit_runs_started_idx" ON "contract_audit_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "contract_audits_status_idx" ON "contract_audits" USING btree ("status","last_checked_at");