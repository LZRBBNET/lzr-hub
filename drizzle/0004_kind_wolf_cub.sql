CREATE TABLE `channel_idempotency_keys` (
	`idempotency_key` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`external_conversation_id` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channel_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`external_conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `channel_messages_conversation_idx` ON `channel_messages` (`channel`,`external_conversation_id`,`created_at`);