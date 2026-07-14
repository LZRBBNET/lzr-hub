CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`role` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`before_masked` text,
	`after_masked` text,
	`reason` text NOT NULL,
	`correlation_id` text NOT NULL,
	`result` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collection_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`segment` text NOT NULL,
	`status` text NOT NULL,
	`audience` integer DEFAULT 0 NOT NULL,
	`recovered_cents` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collection_rule_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`offset_days` integer NOT NULL,
	`channel` text NOT NULL,
	`template_id` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collection_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`author_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`masked_document` text NOT NULL,
	`name` text NOT NULL,
	`city` text NOT NULL,
	`neighborhood` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_external_id_unique` ON `customers` (`external_id`);--> statement-breakpoint
CREATE TABLE `knowledge_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`metadata` text,
	`valid_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`masked_phone` text NOT NULL,
	`city` text NOT NULL,
	`neighborhood` text NOT NULL,
	`source` text NOT NULL,
	`stage` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`owner_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `network_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`city` text NOT NULL,
	`neighborhood` text NOT NULL,
	`equipment` text,
	`affected_customers` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
