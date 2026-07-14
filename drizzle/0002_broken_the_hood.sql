CREATE TABLE `ixc_smoke_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`operation` text NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`cache_state` text DEFAULT 'none' NOT NULL,
	`record_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`correlation_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ixc_smoke_run_idx` ON `ixc_smoke_results` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ixc_smoke_status_idx` ON `ixc_smoke_results` (`status`,`created_at`);