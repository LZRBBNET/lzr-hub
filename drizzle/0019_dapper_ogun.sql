CREATE TABLE "conversation_states" (
	"channel" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"status" text NOT NULL,
	"assignee_id" text,
	"assignee_name" text,
	"assigned_at" text,
	"resolved_at" text,
	"resolved_by" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "conversation_states_channel_external_conversation_id_pk" PRIMARY KEY("channel","external_conversation_id")
);
