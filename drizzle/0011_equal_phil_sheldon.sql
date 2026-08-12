CREATE TABLE "internal_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_participants" (
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"last_read_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"linked_conversation_id" text,
	"created_by" text NOT NULL,
	"last_message_at" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "internal_messages_thread_idx" ON "internal_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "internal_participants_once" ON "internal_participants" USING btree ("thread_id","user_id");--> statement-breakpoint
CREATE INDEX "internal_participants_user_idx" ON "internal_participants" USING btree ("user_id");