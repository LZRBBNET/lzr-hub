CREATE TABLE "channel_contacts" (
	"channel" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"display_name" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "channel_contacts_channel_external_conversation_id_pk" PRIMARY KEY("channel","external_conversation_id")
);
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "delivery_error" text;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD COLUMN "delivery_updated_at" text;--> statement-breakpoint
CREATE INDEX "channel_messages_external_id_idx" ON "channel_messages" USING btree ("external_message_id");