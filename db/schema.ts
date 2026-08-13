import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

const auditColumns = { createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() };
export const customers = pgTable("customers", { id:text("id").primaryKey(), externalId:text("external_id").notNull().unique(), maskedDocument:text("masked_document").notNull(), name:text("name").notNull(), city:text("city").notNull(), neighborhood:text("neighborhood").notNull(), ...auditColumns });
export const networkIncidents = pgTable("network_incidents", { id:text("id").primaryKey(), title:text("title").notNull(), severity:text("severity").notNull(), status:text("status").notNull(), city:text("city").notNull(), neighborhood:text("neighborhood").notNull(), equipment:text("equipment"), affectedCustomers:integer("affected_customers").notNull().default(0), startedAt:text("started_at").notNull(), endedAt:text("ended_at"), ...auditColumns });
/**
 * Alerta de rede real, ingerido do grupo do Telegram onde o monitoramento
 * (fonte exata ainda não confirmada) posta queda e normalização. `equipment`
 * fica com o código bruto do nome do equipamento — CDB, ARYB, SUP, POV, ESC
 * parecem indicar local, mas decodificar sem confirmação seria inventar
 * geografia. `correlationKey` casa o par queda/normalização (por id do evento
 * quando existe, senão por equipamento+descrição) — sem duplicar a linha, um
 * update fecha o alerta já aberto. `rawText` nunca é descartado, mesmo quando
 * o formato não é reconhecido (`parsed:false`): perder o alerta caído por não
 * bater com a regex é pior do que mostrá-lo cru.
 */
export const networkAlerts = pgTable("network_alerts", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  kind: text("kind").notNull(),
  equipment: text("equipment").notNull(),
  description: text("description"),
  status: text("status").notNull(),
  externalEventId: text("external_event_id"),
  correlationKey: text("correlation_key").notNull(),
  startedAt: text("started_at").notNull(),
  resolvedAt: text("resolved_at"),
  rawText: text("raw_text").notNull(),
  parsed: boolean("parsed").notNull().default(true),
  ...auditColumns,
}, (table) => ({
  byCorrelation: index("network_alerts_correlation_idx").on(table.correlationKey),
}));
/**
 * Ledger de aviso de massiva: uma linha por massiva+cliente+tipo (abertura ou
 * normalização). A unicidade é o que garante que ninguém recebe o mesmo aviso
 * duas vezes — mesma lógica do ledger da régua de cobrança, restrição do banco
 * em vez de promessa da lógica de cima.
 */
export const massNoticeDispatches = pgTable("mass_notice_dispatches", {
  id: text("id").primaryKey(),
  incidentId: text("incident_id").notNull(),
  customerId: text("customer_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  correlationId: text("correlation_id").notNull(),
  ...auditColumns,
}, (table) => ({
  onceByKind: uniqueIndex("mass_notice_dispatches_once").on(table.incidentId, table.customerId, table.kind),
}));
/**
 * Ledger de escrita no IXC (issue #20). Uma linha por tentativa, não só por
 * sucesso: "blocked" (política ou fase recusou) e "failed" (IXC respondeu erro)
 * ficam registrados do mesmo jeito que "success" — é a trilha de auditoria que
 * a issue exige, e ela precisa existir mesmo enquanto nada é escrito de
 * verdade. Único por (operation, idempotencyKey): reenviar a mesma chave
 * nunca dispara duas vezes.
 */
export const ixcWriteOperations = pgTable("ixc_write_operations", {
  id: text("id").primaryKey(),
  operation: text("operation").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  customerId: text("customer_id").notNull(),
  invoiceId: text("invoice_id"),
  status: text("status").notNull(),
  requestedBy: text("requested_by").notNull(),
  detail: text("detail"),
  correlationId: text("correlation_id").notNull(),
  ...auditColumns,
}, (table) => ({
  onceByKey: uniqueIndex("ixc_write_operations_idempotency").on(table.operation, table.idempotencyKey),
}));
/**
 * Promessa de pagamento (issue #16). Registrada no HUB, nunca no IXC — a
 * issue é explícita: "para gerar negociação DENTRO do IXC depende do épico de
 * escrita, até lá a IA registra a promessa só no HUB". `status` começa
 * "pending" e só muda quando alguém consulta contra a fatura real: "fulfilled"
 * se a fatura fechou, "broken" se a data passou e a fatura segue aberta.
 */
export const paymentPromises = pgTable("payment_promises", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull(),
  customerId: text("customer_id").notNull(),
  promisedFor: text("promised_for").notNull(),
  status: text("status").notNull(),
  registeredBy: text("registered_by").notNull(),
  correlationId: text("correlation_id").notNull(),
  ...auditColumns,
});
/**
 * Chat interno entre a equipe (issue #10). Existe para o atendente tirar dúvida
 * com o técnico sem sair da tela e sem usar WhatsApp pessoal — e para essa
 * conversa ficar registrada junto do atendimento, em vez de sumir.
 *
 * `linkedConversationId` é opcional e guarda o `externalConversationId` do
 * atendimento discutido, quando houver. Fica solto de propósito: uma conversa
 * interna pode ser sobre um cliente, sobre um problema de rede, ou sobre nada
 * em particular.
 */
export const internalThreads = pgTable("internal_threads", {
  id: text("id").primaryKey(),
  subject: text("subject").notNull(),
  linkedConversationId: text("linked_conversation_id"),
  createdBy: text("created_by").notNull(),
  lastMessageAt: text("last_message_at").notNull(),
  ...auditColumns,
});
/**
 * Quem participa de cada conversa. É a tabela que faz o RBAC valer: quem não
 * tem linha aqui não lê a conversa, e a consulta parte daqui — nunca da lista
 * de conversas filtrada depois.
 */
export const internalParticipants = pgTable("internal_participants", {
  threadId: text("thread_id").notNull(),
  userId: text("user_id").notNull(),
  /** Última leitura, para marcar mensagem nova sem precisar de outra tabela. */
  lastReadAt: text("last_read_at"),
  ...auditColumns,
}, (table) => ({
  once: uniqueIndex("internal_participants_once").on(table.threadId, table.userId),
  byUser: index("internal_participants_user_idx").on(table.userId),
}));
export const internalMessages = pgTable("internal_messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  authorId: text("author_id").notNull(),
  body: text("body").notNull(),
  ...auditColumns,
}, (table) => ({
  byThread: index("internal_messages_thread_idx").on(table.threadId, table.createdAt),
}));
export const collectionRules = pgTable("collection_rules", { id:text("id").primaryKey(), name:text("name").notNull(), status:text("status").notNull(), version:integer("version").notNull().default(1), authorId:text("author_id").notNull(), ...auditColumns });
export const collectionRuleSteps = pgTable("collection_rule_steps", { id:text("id").primaryKey(), ruleId:text("rule_id").notNull(), offsetDays:integer("offset_days").notNull(), channel:text("channel").notNull(), templateId:text("template_id").notNull(), attempts:integer("attempts").notNull().default(1), active:boolean("active").notNull().default(true), ...auditColumns });
/**
 * Ledger de disparo da régua: uma linha por fatura+etapa+data. A unicidade
 * (invoiceId, stepId, scheduledFor) é o que garante "zero duplicidade de
 * cobrança" — não como promessa da lógica de cima, mas como restrição do
 * banco. Rodar o disparo do dia duas vezes por engano não duplica nada.
 */
export const collectionDispatches = pgTable("collection_dispatches", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull(),
  customerId: text("customer_id").notNull(),
  ruleId: text("rule_id").notNull(),
  stepId: text("step_id").notNull(),
  scheduledFor: text("scheduled_for").notNull(),
  status: text("status").notNull(),
  channel: text("channel").notNull(),
  correlationId: text("correlation_id").notNull(),
  ...auditColumns,
}, (table) => ({
  onceByStep: uniqueIndex("collection_dispatches_once").on(table.invoiceId, table.stepId, table.scheduledFor),
}));
export const collectionCampaigns = pgTable("collection_campaigns", { id:text("id").primaryKey(), name:text("name").notNull(), segment:text("segment").notNull(), status:text("status").notNull(), audience:integer("audience").notNull().default(0), recoveredCents:integer("recovered_cents").notNull().default(0), ...auditColumns });
/**
 * Lead do funil comercial (issue #17). A tabela existia desde o início e nunca
 * recebeu uma linha; as colunas abaixo de `ownerId` foram acrescentadas quando
 * o CRM passou a existir de verdade.
 *
 * `contactKey` é o identificador da conversa que originou o lead (o número do
 * WhatsApp, hoje). Ele é **único**: o mesmo contato escrevendo dez vezes é um
 * lead só, e a unicidade fica no banco porque checar na aplicação é o tipo de
 * trava que falha na décima corrida simultânea.
 *
 * `maskedPhone` guarda o número já mascarado para exibição; a chave crua fica
 * em `contactKey` porque é ela que precisa casar exatamente.
 */
export const leads = pgTable("leads", {
  id:text("id").primaryKey(), name:text("name").notNull(), maskedPhone:text("masked_phone").notNull(),
  city:text("city").notNull(), neighborhood:text("neighborhood").notNull(), source:text("source").notNull(),
  stage:text("stage").notNull(), score:integer("score").notNull().default(0), ownerId:text("owner_id"),
  contactKey:text("contact_key"),
  note:text("note"),
  /** Quando saiu do funil, ganhando ou perdendo. Null enquanto está em andamento. */
  closedAt:text("closed_at"),
  /** Preenchido só quando o lead é perdido — ganhar não pede justificativa. */
  lostReason:text("lost_reason"),
  ...auditColumns,
}, (table) => [uniqueIndex("leads_contact_key_idx").on(table.contactKey)]);

/**
 * O que aconteceu com o lead: mudança de etapa, contato feito, proposta enviada.
 *
 * Existe por dois motivos. O primeiro é o cartão do lead mostrar história em vez
 * de só um estado. O segundo é **medir ciclo de venda**: sem a data em que o
 * lead entrou em cada etapa, "tempo médio até fechar" não tem como ser
 * calculado, e foi exatamente o que a tela dizia que não sabia responder.
 */
export const leadActivities = pgTable("lead_activities", {
  id:text("id").primaryKey(),
  leadId:text("lead_id").notNull(),
  /** `stage_change` | `contact` | `note` */
  kind:text("kind").notNull(),
  fromStage:text("from_stage"),
  toStage:text("to_stage"),
  detail:text("detail").notNull(),
  actorId:text("actor_id").notNull(),
  createdAt:text("created_at").notNull(),
}, (table) => [index("lead_activities_lead_idx").on(table.leadId, table.createdAt)]);
/**
 * Meta comercial do mês. Uma linha por competência (`2026-08`), da empresa
 * inteira — não por equipe: atribuir contrato a vendedor exigiria um campo do
 * IXC que ainda não foi confirmado, e meta por equipe calculada em cima de
 * atribuição inventada não mede nada.
 *
 * O **realizado** não mora aqui: vem do IXC no momento da consulta. Guardar o
 * realizado seria guardar uma cópia que envelhece.
 */
export const salesGoals = pgTable("sales_goals", {
  id: text("id").primaryKey(),
  /** Competência no formato `AAAA-MM`. */
  period: text("period").notNull(),
  targetContracts: integer("target_contracts").notNull(),
  /** Opcional: nem toda operação define meta de receita, só de volume. */
  targetRevenueCents: integer("target_revenue_cents"),
  note: text("note"),
  createdBy: text("created_by").notNull(),
  ...auditColumns,
}, (table) => [uniqueIndex("sales_goals_period_idx").on(table.period)]);

/**
 * Equipe de atendimento e a fila que ela recebe.
 *
 * `queue` é a fila de transbordo para onde a conversa vai quando a IA passa
 * para humano — precisa casar com o motivo registrado em `conversation_outcomes`.
 */
export const teams = pgTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  queue: text("queue").notNull(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  /**
   * Motivos de transbordo que a equipe assume, validados contra `HANDOFF_REASONS`.
   * É o que liga a equipe a dado medido: sem isso a tela não teria como dizer
   * quantos atendimentos caíram nela.
   */
  handoffReasons: jsonb("handoff_reasons").notNull().default([]),
  ...auditColumns,
}, (table) => [uniqueIndex("teams_name_idx").on(table.name)]);

/** Vínculo de pessoa com equipe. Uma pessoa pode estar em mais de uma. */
export const teamMembers = pgTable("team_members", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  userId: text("user_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("team_members_pair_idx").on(table.teamId, table.userId), index("team_members_user_idx").on(table.userId)]);

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

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  active: boolean("active").notNull().default(true),
  /** Senha gerada pelo sistema: a pessoa precisa definir a sua no primeiro acesso. */
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  lastLoginAt: text("last_login_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Pedido de recuperação de senha.
 *
 * O projeto não tem envio de e-mail, então não existe link de redefinição: a
 * pessoa registra o pedido e quem administra resolve gerando uma senha nova.
 * Guardamos o e-mail **como digitado**, exista a conta ou não — recusar o
 * pedido de um e-mail inexistente revelaria quais contas existem.
 */
export const passwordResetRequests = pgTable("password_reset_requests", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  status: text("status").notNull().default("pending"),
  note: text("note"),
  resolvedBy: text("resolved_by"),
  resolvedAt: text("resolved_at"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("password_reset_status_idx").on(table.status, table.createdAt)]);

/** Guardamos só o hash do token: vazamento do banco não concede sessão a ninguém. */
export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("sessions_user_idx").on(table.userId), index("sessions_expiry_idx").on(table.expiresAt)]);

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
