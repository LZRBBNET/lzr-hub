ALTER TABLE "channel_messages" ADD COLUMN "correlation_id" text;--> statement-breakpoint
ALTER TABLE "conversation_outcomes" ADD COLUMN "intent_source" text;--> statement-breakpoint
ALTER TABLE "conversation_outcomes" ADD COLUMN "intent_confidence" integer;--> statement-breakpoint
ALTER TABLE "conversation_outcomes" ADD COLUMN "intent_model" text;--> statement-breakpoint
ALTER TABLE "conversation_outcomes" ADD COLUMN "app_version" text;