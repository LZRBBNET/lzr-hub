CREATE TABLE `pilot_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`module` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`description_sanitized` text NOT NULL,
	`steps_sanitized` text,
	`expected_sanitized` text,
	`actual_sanitized` text,
	`screenshot_ref` text,
	`participant_alias` text NOT NULL,
	`metric_name` text,
	`metric_value` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`owner_role` text,
	`correlation_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pilot_events_type_idx` ON `pilot_events` (`event_type`,`created_at`);--> statement-breakpoint
CREATE INDEX `pilot_events_status_idx` ON `pilot_events` (`status`,`severity`);