CREATE TABLE "agent_reply_templates" (
	"intent" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"version" integer NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "sent_by" text;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "external_message_id" text;