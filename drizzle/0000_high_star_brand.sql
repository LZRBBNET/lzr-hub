CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"role" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"before_masked" text,
	"after_masked" text,
	"reason" text NOT NULL,
	"correlation_id" text NOT NULL,
	"result" text NOT NULL,
	"origin" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_idempotency_keys" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"response_json" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"segment" text NOT NULL,
	"status" text NOT NULL,
	"audience" integer DEFAULT 0 NOT NULL,
	"recovered_cents" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_rule_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"offset_days" integer NOT NULL,
	"channel" text NOT NULL,
	"template_id" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"author_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"masked_document" text NOT NULL,
	"name" text NOT NULL,
	"city" text NOT NULL,
	"neighborhood" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "customers_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "integration_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"subject_id" text NOT NULL,
	"payload_masked" jsonb NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ixc_smoke_results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"operation" text NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"cache_state" text DEFAULT 'none' NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"valid_until" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"masked_phone" text NOT NULL,
	"city" text NOT NULL,
	"neighborhood" text NOT NULL,
	"source" text NOT NULL,
	"stage" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"owner_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"city" text NOT NULL,
	"neighborhood" text NOT NULL,
	"equipment" text,
	"affected_customers" integer DEFAULT 0 NOT NULL,
	"started_at" text NOT NULL,
	"ended_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pilot_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"module" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"description_sanitized" text NOT NULL,
	"steps_sanitized" text,
	"expected_sanitized" text,
	"actual_sanitized" text,
	"screenshot_ref" text,
	"participant_alias" text NOT NULL,
	"metric_name" text,
	"metric_value" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"owner_role" text,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_health_events" (
	"id" text PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"state" text NOT NULL,
	"latency_ms" integer,
	"correlation_id" text NOT NULL,
	"detail_code" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"subject_id" text NOT NULL,
	"cursor_masked" text,
	"last_success_at" text,
	"last_attempt_at" text NOT NULL,
	"status" text NOT NULL,
	"correlation_id" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 2 NOT NULL,
	"correlation_id" text NOT NULL,
	"error_code" text,
	"scheduled_at" text NOT NULL,
	"finished_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "channel_messages_conversation_idx" ON "channel_messages" USING btree ("channel","external_conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_cache_subject_idx" ON "integration_cache" USING btree ("provider","subject_id");--> statement-breakpoint
CREATE INDEX "integration_cache_expiry_idx" ON "integration_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ixc_smoke_run_idx" ON "ixc_smoke_results" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "ixc_smoke_status_idx" ON "ixc_smoke_results" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "pilot_events_type_idx" ON "pilot_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE INDEX "pilot_events_status_idx" ON "pilot_events" USING btree ("status","severity");--> statement-breakpoint
CREATE INDEX "service_health_created_idx" ON "service_health_events" USING btree ("service","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_checkpoints_provider_subject_idx" ON "sync_checkpoints" USING btree ("provider","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_jobs_dedupe_idx" ON "sync_jobs" USING btree ("job_type","subject_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "sync_jobs_status_idx" ON "sync_jobs" USING btree ("status","scheduled_at");