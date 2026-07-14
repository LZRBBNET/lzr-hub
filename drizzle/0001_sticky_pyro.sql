CREATE TABLE `integration_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`subject_id` text NOT NULL,
	`payload_masked` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `integration_cache_subject_idx` ON `integration_cache` (`provider`,`subject_id`);--> statement-breakpoint
CREATE INDEX `integration_cache_expiry_idx` ON `integration_cache` (`expires_at`);--> statement-breakpoint
CREATE TABLE `service_health_events` (
	`id` text PRIMARY KEY NOT NULL,
	`service` text NOT NULL,
	`state` text NOT NULL,
	`latency_ms` integer,
	`correlation_id` text NOT NULL,
	`detail_code` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `service_health_created_idx` ON `service_health_events` (`service`,`created_at`);--> statement-breakpoint
CREATE TABLE `sync_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`subject_id` text NOT NULL,
	`cursor_masked` text,
	`last_success_at` text,
	`last_attempt_at` text NOT NULL,
	`status` text NOT NULL,
	`correlation_id` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_checkpoints_provider_subject_idx` ON `sync_checkpoints` (`provider`,`subject_id`);--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 2 NOT NULL,
	`correlation_id` text NOT NULL,
	`error_code` text,
	`scheduled_at` text NOT NULL,
	`finished_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_jobs_dedupe_idx` ON `sync_jobs` (`job_type`,`subject_id`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `sync_jobs_status_idx` ON `sync_jobs` (`status`,`scheduled_at`);