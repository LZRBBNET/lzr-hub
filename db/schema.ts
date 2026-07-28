import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

const auditColumns = { createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() };
export const customers = pgTable("customers", { id:text("id").primaryKey(), externalId:text("external_id").notNull().unique(), maskedDocument:text("masked_document").notNull(), name:text("name").notNull(), city:text("city").notNull(), neighborhood:text("neighborhood").notNull(), ...auditColumns });
export const networkIncidents = pgTable("network_incidents", { id:text("id").primaryKey(), title:text("title").notNull(), severity:text("severity").notNull(), status:text("status").notNull(), city:text("city").notNull(), neighborhood:text("neighborhood").notNull(), equipment:text("equipment"), affectedCustomers:integer("affected_customers").notNull().default(0), startedAt:text("started_at").notNull(), endedAt:text("ended_at"), ...auditColumns });
export const collectionRules = pgTable("collection_rules", { id:text("id").primaryKey(), name:text("name").notNull(), status:text("status").notNull(), version:integer("version").notNull().default(1), authorId:text("author_id").notNull(), ...auditColumns });
export const collectionRuleSteps = pgTable("collection_rule_steps", { id:text("id").primaryKey(), ruleId:text("rule_id").notNull(), offsetDays:integer("offset_days").notNull(), channel:text("channel").notNull(), templateId:text("template_id").notNull(), attempts:integer("attempts").notNull().default(1), active:boolean("active").notNull().default(true), ...auditColumns });
export const collectionCampaigns = pgTable("collection_campaigns", { id:text("id").primaryKey(), name:text("name").notNull(), segment:text("segment").notNull(), status:text("status").notNull(), audience:integer("audience").notNull().default(0), recoveredCents:integer("recovered_cents").notNull().default(0), ...auditColumns });
export const leads = pgTable("leads", { id:text("id").primaryKey(), name:text("name").notNull(), maskedPhone:text("masked_phone").notNull(), city:text("city").notNull(), neighborhood:text("neighborhood").notNull(), source:text("source").notNull(), stage:text("stage").notNull(), score:integer("score").notNull().default(0), ownerId:text("owner_id"), ...auditColumns });
export const knowledgeDocuments = pgTable("knowledge_documents", { id:text("id").primaryKey(), title:text("title").notNull(), category:text("category").notNull(), content:text("content").notNull(), status:text("status").notNull(), version:integer("version").notNull().default(1), metadata:jsonb("metadata"), validUntil:text("valid_until"), ...auditColumns });
export const auditEvents = pgTable("audit_events", { id:text("id").primaryKey(), actorId:text("actor_id").notNull(), role:text("role").notNull(), action:text("action").notNull(), entity:text("entity").notNull(), beforeMasked:text("before_masked"), afterMasked:text("after_masked"), reason:text("reason").notNull(), correlationId:text("correlation_id").notNull(), result:text("result").notNull(), origin:text("origin").notNull(), createdAt:text("created_at").notNull() });

export const integrationCache = pgTable("integration_cache", {
  cacheKey: text("cache_key").primaryKey(),
  provider: text("provider").notNull(),
  subjectId: text("subject_id").notNull(),
  payloadMasked: jsonb("payload_masked").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("integration_cache_subject_idx").on(table.provider, table.subjectId), index("integration_cache_expiry_idx").on(table.expiresAt)]);

export const syncJobs = pgTable("sync_jobs", {
  id: text("id").primaryKey(),
  jobType: text("job_type").notNull(),
  subjectId: text("subject_id").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(2),
  correlationId: text("correlation_id").notNull(),
  errorCode: text("error_code"),
  scheduledAt: text("scheduled_at").notNull(),
  finishedAt: text("finished_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("sync_jobs_dedupe_idx").on(table.jobType, table.subjectId, table.scheduledAt), index("sync_jobs_status_idx").on(table.status, table.scheduledAt)]);

export const syncCheckpoints = pgTable("sync_checkpoints", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  subjectId: text("subject_id").notNull(),
  cursorMasked: text("cursor_masked"),
  lastSuccessAt: text("last_success_at"),
  lastAttemptAt: text("last_attempt_at").notNull(),
  status: text("status").notNull(),
  correlationId: text("correlation_id").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("sync_checkpoints_provider_subject_idx").on(table.provider, table.subjectId)]);

export const serviceHealthEvents = pgTable("service_health_events", {
  id: text("id").primaryKey(),
  service: text("service").notNull(),
  state: text("state").notNull(),
  latencyMs: integer("latency_ms"),
  correlationId: text("correlation_id").notNull(),
  detailCode: text("detail_code").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("service_health_created_idx").on(table.service, table.createdAt)]);

export const ixcSmokeResults = pgTable("ixc_smoke_results", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  operation: text("operation").notNull(),
  status: text("status").notNull(),
  latencyMs: integer("latency_ms").notNull().default(0),
  cacheState: text("cache_state").notNull().default("none"),
  recordCount: integer("record_count").notNull().default(0),
  errorCode: text("error_code"),
  correlationId: text("correlation_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("ixc_smoke_run_idx").on(table.runId, table.createdAt), index("ixc_smoke_status_idx").on(table.status, table.createdAt)]);

export const channelMessages = pgTable("channel_messages", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  externalConversationId: text("external_conversation_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("channel_messages_conversation_idx").on(table.channel, table.externalConversationId, table.createdAt)]);

export const channelIdempotencyKeys = pgTable("channel_idempotency_keys", {
  idempotencyKey: text("idempotency_key").primaryKey(),
  channel: text("channel").notNull(),
  externalConversationId: text("external_conversation_id").notNull(),
  responseJson: jsonb("response_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const conversationOutcomes = pgTable("conversation_outcomes", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  externalConversationId: text("external_conversation_id").notNull(),
  intent: text("intent").notNull(),
  finalStatus: text("final_status").notNull(),
  handoff: boolean("handoff").notNull().default(false),
  handoffReason: text("handoff_reason"),
  correlationId: text("correlation_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("conversation_outcomes_created_idx").on(table.createdAt), index("conversation_outcomes_conversation_idx").on(table.channel, table.externalConversationId)]);

export const csatRatings = pgTable("csat_ratings", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  externalConversationId: text("external_conversation_id").notNull(),
  score: integer("score").notNull(),
  comment: text("comment"),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("csat_ratings_conversation_idx").on(table.channel, table.externalConversationId), index("csat_ratings_created_idx").on(table.createdAt)]);

export const pilotEvents = pgTable("pilot_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  module: text("module").notNull(),
  severity: text("severity").notNull().default("info"),
  descriptionSanitized: text("description_sanitized").notNull(),
  stepsSanitized: text("steps_sanitized"),
  expectedSanitized: text("expected_sanitized"),
  actualSanitized: text("actual_sanitized"),
  screenshotRef: text("screenshot_ref"),
  participantAlias: text("participant_alias").notNull(),
  metricName: text("metric_name"),
  metricValue: integer("metric_value"),
  status: text("status").notNull().default("open"),
  ownerRole: text("owner_role"),
  correlationId: text("correlation_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("pilot_events_type_idx").on(table.eventType, table.createdAt), index("pilot_events_status_idx").on(table.status, table.severity)]);
