import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { auditEvents, channelIdempotencyKeys, channelMessages } from "../../db/schema.ts";
import { runAgentPipeline } from "../agent/pipeline.ts";
import { classifyIntent, llmConfigFromEnv } from "../agent/llm-classifier.ts";
import { sanitizeHandoffText } from "../agent/handoff.ts";
import type { ChatMessage } from "../agent/types.ts";
import { appVersion } from "../runtime/app-version.ts";
import { traceAgentResult } from "../observability/trace-agent-result.ts";
import { resolveReply, type ReplyOverrides } from "./reply-templates-shared.ts";
import { AI_SENDER } from "./conversation-state-shared.ts";
import {
  CSAT_QUESTION,
  CSAT_THANKS,
  isAwaitingCsat,
  parseCsatScore,
  shouldAskCsat,
  type SupportMetricsRepository,
} from "./support-metrics.ts";

export const CHANNEL_NAME = "n8n-whatsapp";
export const MAX_MESSAGE_LENGTH = 5000;
export const MAX_HISTORY = 40;
/**
 * Memória que o classificador por modelo enxerga: as últimas falas, e só as
 * recentes. "Sim" ou "continua igual" só fazem sentido com o que veio antes — mas
 * conversa de ontem não deve explicar a de hoje, então há um prazo, como a
 * memória de sessão de qualquer agente de IA.
 */
export const LLM_CONTEXT_TURNS = 6;
export const LLM_CONTEXT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Resposta que a IA produziu mas que ninguém enviou ao cliente. Fica gravada
 * com papel próprio para que a tela não a mostre como mensagem entregue e para
 * que o histórico do pipeline não a trate como turno da conversa.
 */
export const SUGGESTION_ROLE = "suggestion";
/** Desfecho de quem só sugeriu: nunca conta como atendimento resolvido. */
export const SUGGESTED_STATUS = "suggested";
/**
 * Desfecho da primeira resposta automática que de fato saiu e não resolveu nada.
 * O pipeline diria `simulated` ("preparei a segunda via fictícia") ou
 * `resolved`, e os dois entram na conta de resolvidos sem humano — mas o texto
 * que saiu é a resposta aprovada, que promete um atendente. Contar isso como
 * resolução seria creditar à IA um atendimento que ninguém fez.
 */
export const AUTO_REPLIED_STATUS = "replied";
const CLAIMS_RESOLUTION = new Set(["resolved", "simulated"]);

export type ChannelRole = "customer" | "agent" | "suggestion";
/**
 * `correlationId` liga a mensagem ao rastro de auditoria e ao desfecho. Sem ele
 * o registro de auditoria não alcançava a frase exata — só por conversa e
 * horário, que é aproximação.
 */
export interface ChannelMessageRow {
  role: ChannelRole;
  content: string;
  correlationId?: string;
  /** Preenchido na leitura; quem grava deixa o banco carimbar. Ausente = sem prazo conhecido. */
  createdAt?: string;
  /** E-mail de quem escreveu a resposta enviada, ou `ia` quando a resposta automática saiu pelo canal. Ausente = não registrado, nunca "a IA". */
  sentBy?: string;
  /** `wamid` da Meta, quando existe. */
  externalMessageId?: string;
}
/**
 * `response` vem `null` quando a resposta automática está desligada — o fluxo do
 * n8n precisa checar `autoReply` antes de enviar qualquer coisa ao cliente.
 *
 * `externalMessageId` é o `wamid` da resposta quando o próprio canal a enviou
 * (rota da Meta): presente = já saiu, e quem chama não reenvia.
 */
export interface ChannelResponse { response: string | null; autoReply: boolean; suggestion?: string; status: string; handoff: boolean; correlationId: string; externalMessageId?: string }

/**
 * O resultado de tentar levar a resposta ao cliente. `unknown` = pode ter saído
 * (timeout): não é sucesso, e também não convida a reenviar.
 */
export type AutoReplyDelivery =
  | { sent: true; messageId: string; /** O que de fato saiu, quando é reentrega de um envio já feito. */ text?: string }
  | { sent: false; outcome: "blocked" | "failed" | "unknown"; reason: string };
/** `inboundMessageId` é a chave de idempotência da fala do cliente — o `wamid`, na Meta. */
export type AutoReplySender = (input: { conversationId: string; text: string; inboundMessageId: string }) => Promise<AutoReplyDelivery>;

export interface ChannelOptions {
  autoReply: boolean;
  /** Respostas aprovadas editadas por quem administra; o que falta cai no padrão do código. */
  templates?: ReplyOverrides;
  /**
   * Quem leva a resposta automática ao cliente. Ausente, quem chama envia — o
   * fluxo do n8n lê `response`. Presente (rota da Meta), só vira mensagem
   * entregue o que o envio confirmar; o resto fica como sugestão.
   *
   * Com `send`, a resposta é **primeira resposta**: sai sem a pergunta de
   * avaliação, gravada com autor `ia`, e não conta como resolução — a conversa
   * continua na fila até um humano responder (ver `awaitingSinceFrom`).
   */
  send?: AutoReplySender;
}

type Delivery = { sent: true; messageId?: string; text?: string } | { sent: false; failure?: Extract<AutoReplyDelivery, { sent: false }> };

/**
 * Antes, com a resposta automática ligada, a resposta era gravada como enviada
 * sem que nada saísse quando ninguém do outro lado a enviava — e a tela afirmava
 * que o cliente tinha recebido. Aqui a gravação passa a seguir o envio.
 */
async function deliver(options: ChannelOptions, input: ChannelMessageInput, text: string): Promise<Delivery> {
  if (!options.autoReply) return { sent: false };
  if (!options.send) return { sent: true };
  try {
    const delivery = await options.send({ conversationId: input.externalConversationId, text, inboundMessageId: input.idempotencyKey });
    return delivery.sent ? delivery : { sent: false, failure: delivery };
  } catch {
    // Quem envia não deveria lançar; se lançou, não dá para afirmar nem que saiu nem que não.
    return { sent: false, failure: { sent: false, outcome: "unknown", reason: "Erro inesperado no envio automático." } };
  }
}

/** O que o canal enviou leva o `wamid` (casa o recibo de entrega) e o autor `ia`; o que o n8n diz ter enviado fica sem autor — não registrado. */
const sentFields = (delivery: Delivery): Pick<ChannelMessageRow, "externalMessageId" | "sentBy"> =>
  delivery.sent && delivery.messageId ? { externalMessageId: delivery.messageId, sentBy: AI_SENDER } : {};

/** A falha do envio automático tem linha própria na auditoria: "a IA tentou responder e não conseguiu" precisa ser achável. */
async function auditFailure(repository: ChannelRepository, input: ChannelMessageInput, delivery: Delivery, text: string): Promise<void> {
  if (delivery.sent || !delivery.failure) return;
  const { outcome, reason } = delivery.failure;
  await repository.audit({
    correlationId: input.correlationId,
    entity: `conversation:${input.externalConversationId}`,
    action: outcome === "blocked" ? "whatsapp.autoreply.blocked" : "whatsapp.autoreply.failed",
    result: outcome,
    reason: `Resposta automática NÃO enviada: ${sanitizeHandoffText(reason)} Ficou como sugestão: "${sanitizeHandoffText(text).slice(0, 180)}"`,
  });
}

/**
 * As falas que o classificador recebe como contexto. Sugestão fica de fora: o
 * cliente nunca a viu, então ela não faz parte do que foi dito.
 */
export function contextForClassifier(rows: ChannelMessageRow[], now = Date.now()): ChatMessage[] {
  return rows
    .filter((row) => row.role !== SUGGESTION_ROLE)
    // Sem carimbo de data não há como afirmar que é antiga; fica.
    .filter((row) => !row.createdAt || !Number.isFinite(Date.parse(row.createdAt)) || now - Date.parse(row.createdAt) <= LLM_CONTEXT_MAX_AGE_MS)
    .slice(-LLM_CONTEXT_TURNS)
    .map(({ role, content }) => ({ role: role === "agent" ? "agent" : "customer", content }));
}

export interface ChannelRepository {
  findIdempotent(idempotencyKey: string): Promise<ChannelResponse | undefined>;
  getHistory(channel: string, externalConversationId: string): Promise<ChannelMessageRow[]>;
  saveMessages(channel: string, externalConversationId: string, messages: ChannelMessageRow[]): Promise<void>;
  saveIdempotency(idempotencyKey: string, channel: string, externalConversationId: string, response: ChannelResponse): Promise<void>;
  /** Sem `action`, é o registro do atendimento (`channel.message.processed`). */
  audit(entry: ChannelAuditEntry): Promise<void>;
}

export interface ChannelAuditEntry { correlationId: string; entity: string; result: string; reason: string; action?: string }

export interface ChannelMessageInput { externalConversationId: string; text: string; idempotencyKey: string; correlationId: string }

/**
 * Captação de lead (issue #17): chamada quando chega mensagem de quem **não é
 * cliente**. Injetada porque o canal não deve conhecer o CRM nem o IXC — e
 * porque os testes do canal precisam rodar sem nenhum dos dois.
 *
 * Nunca derruba o atendimento: registrar oportunidade comercial é secundário
 * diante de responder a quem escreveu.
 */
export type LeadCapture = (input: { contactKey: string; text: string }) => Promise<unknown>;

export async function processChannelMessage(
  repository: ChannelRepository,
  input: ChannelMessageInput,
  metrics?: SupportMetricsRepository,
  options: ChannelOptions = { autoReply: false },
  captureLead?: LeadCapture,
): Promise<ChannelResponse> {
  const existing = await repository.findIdempotent(input.idempotencyKey);
  if (existing) return existing;

  // Antes de qualquer coisa, e sem esperar: se for gente nova, o funil registra.
  // O `catch` é a regra — um CRM fora do ar não pode impedir o atendimento.
  if (captureLead) {
    await captureLead({ contactKey: input.externalConversationId, text: input.text }).catch(() => undefined);
  }

  const historyRows = await repository.getHistory(CHANNEL_NAME, input.externalConversationId);
  // Sugestão não é turno de conversa: o cliente nunca a viu, então ela não entra
  // no histórico que a IA usa para decidir o próximo passo.
  const history: ChatMessage[] = historyRows.filter((row) => row.role !== SUGGESTION_ROLE).slice(-MAX_HISTORY) as ChatMessage[];

  const lastAgentMessage = [...historyRows].reverse().find((row) => row.role === "agent")?.content;
  const csatScore = isAwaitingCsat(lastAgentMessage) ? parseCsatScore(input.text) : null;

  // Resposta à pergunta de avaliação: registra a nota e encerra, sem acionar o pipeline.
  if (csatScore !== null) {
    await metrics?.saveRating({
      channel: CHANNEL_NAME,
      externalConversationId: input.externalConversationId,
      score: csatScore,
    });
    // Mesmo o agradecimento é mensagem enviada ao cliente: com resposta
    // automática desligada, a nota é registrada e nada sai daqui.
    const thanks = await deliver(options, input, CSAT_THANKS);
    await repository.saveMessages(CHANNEL_NAME, input.externalConversationId, [
      { role: "customer", content: input.text, correlationId: input.correlationId, externalMessageId: input.idempotencyKey },
      { role: thanks.sent ? "agent" : SUGGESTION_ROLE, content: thanks.sent ? thanks.text ?? CSAT_THANKS : CSAT_THANKS, correlationId: input.correlationId, ...sentFields(thanks) },
    ]);
    const rated: ChannelResponse = {
      response: thanks.sent ? CSAT_THANKS : null,
      autoReply: thanks.sent,
      suggestion: thanks.sent ? undefined : CSAT_THANKS,
      status: "rated",
      handoff: false,
      correlationId: input.correlationId,
      ...(thanks.sent && thanks.messageId ? { externalMessageId: thanks.messageId } : {}),
    };
    await repository.saveIdempotency(input.idempotencyKey, CHANNEL_NAME, input.externalConversationId, rated);
    await repository.audit({
      correlationId: input.correlationId,
      entity: `conversation:${input.externalConversationId}`,
      result: `csat:${csatScore}`,
      reason: "Avaliação de atendimento recebida via canal n8n/WhatsApp",
    });
    await auditFailure(repository, input, thanks, CSAT_THANKS);
    return rated;
  }

  // Classifica antes de rodar o pipeline: sem chave configurada isto cai na
  // regex e o comportamento é idêntico ao de antes. O contexto é o que o
  // modelo precisa para entender "sim" e "continua igual".
  const classified = await classifyIntent(input.text, llmConfigFromEnv(), undefined, contextForClassifier(historyRows));
  const result = runAgentPipeline(input.text, history, {
    channel: "whatsapp",
    intentOverride: { intent: classified.intent, confidence: classified.confidence },
  });
  await traceAgentResult(result, { channel: CHANNEL_NAME, correlationId: input.correlationId });

  // O pipeline decide intenção, transbordo e desfecho; o **texto** que sai pelo
  // canal é a resposta aprovada da intenção. O do pipeline é de homologação
  // ("preparei a segunda via fictícia") e não pode chegar a um cliente real.
  const approved = resolveReply(result.intent, options.templates);

  // Só pede nota quando a resposta é de fato entregue — não dá para avaliar
  // um atendimento que o cliente não recebeu. E não na primeira resposta pela
  // Meta: "um atendente retorna... Antes de encerrar, avalie" se contradiz.
  const askCsat = options.autoReply && !options.send && shouldAskCsat(result.finalStatus, result.handoff.required);
  const reply = askCsat ? `${approved}\n\n${CSAT_QUESTION}` : approved;
  const delivery = await deliver(options, input, reply);
  // Não saiu: fica a resposta aprovada, sem a pergunta de avaliação — igual ao
  // modo observação. Saiu: fica o que o cliente recebeu.
  const content = delivery.sent ? delivery.text ?? reply : approved;

  await repository.saveMessages(CHANNEL_NAME, input.externalConversationId, [
    { role: "customer", content: input.text, correlationId: input.correlationId, externalMessageId: input.idempotencyKey },
    // O `wamid` da resposta é o que casa o recibo de entrega com esta linha.
    { role: delivery.sent ? "agent" : SUGGESTION_ROLE, content, correlationId: input.correlationId, ...sentFields(delivery) },
  ]);

  const response: ChannelResponse = {
    response: delivery.sent ? content : null,
    autoReply: delivery.sent,
    suggestion: delivery.sent ? undefined : content,
    status: !delivery.sent ? SUGGESTED_STATUS
      : delivery.messageId && CLAIMS_RESOLUTION.has(result.finalStatus) ? AUTO_REPLIED_STATUS
      : result.finalStatus,
    handoff: result.handoff.required,
    correlationId: input.correlationId,
    ...(delivery.sent && delivery.messageId ? { externalMessageId: delivery.messageId } : {}),
  };

  await repository.saveIdempotency(input.idempotencyKey, CHANNEL_NAME, input.externalConversationId, response);
  await repository.audit({
    correlationId: input.correlationId,
    entity: `conversation:${input.externalConversationId}`,
    result: response.status,
    // O fato mais consequente da operação é uma resposta ter saído para um
    // cliente. "Mensagem recebida" descrevia a metade inofensiva e calava a outra.
    // Sanitizado mesmo sendo texto nosso: as respostas de hoje são fixas, mas a
    // auditoria é lida por quem não participou do atendimento, e a regra do
    // projeto não abre exceção para "este caso não tem dado pessoal".
    reason: delivery.sent
      ? `Resposta ENVIADA ao cliente: "${sanitizeHandoffText(content).slice(0, 180)}"`
      : delivery.failure
        ? `Resposta automática NÃO enviada (ver registro do envio); fica como sugestão: "${sanitizeHandoffText(content).slice(0, 180)}"`
        : `Resposta apenas sugerida, não enviada: "${sanitizeHandoffText(content).slice(0, 180)}"`,
  });
  await auditFailure(repository, input, delivery, content);
  await metrics?.saveOutcome({
    channel: CHANNEL_NAME,
    externalConversationId: input.externalConversationId,
    intent: result.intent,
    // Sem envio, o desfecho é "sugerido": não pode entrar na conta de resolvidos.
    finalStatus: response.status,
    handoff: result.handoff.required,
    handoffReason: result.handoff.reason,
    correlationId: input.correlationId,
    // Quem classificou, com quanta certeza, e qual código produziu tudo isso.
    intentSource: classified.source,
    intentConfidence: Math.round(classified.confidence * 100),
    intentModel: classified.model ?? null,
    appVersion: appVersion(),
  });

  return response;
}

export type UnsupportedKind = "audio" | "image" | "video" | "document" | "sticker" | "location" | "contacts" | "other";

const UNSUPPORTED_LABELS: Record<UnsupportedKind, string> = {
  audio: "Áudio recebido", image: "Imagem recebida", video: "Vídeo recebido", document: "Documento recebido",
  sticker: "Figurinha recebida", location: "Localização recebida", contacts: "Contato compartilhado recebido",
  other: "Mensagem de tipo não suportado recebida",
};

/** O que o atendente lê no lugar do que a tela não sabe exibir. */
export function unsupportedMessageText(kind: UnsupportedKind, caption?: string): string {
  const base = `[${UNSUPPORTED_LABELS[kind]} — esta tela ainda não exibe esse tipo de mensagem]`;
  return caption ? `${base} Legenda: ${caption.slice(0, 500)}` : base;
}

/**
 * Áudio, foto, documento: o cliente falou, só que não em texto. Antes isso era
 * descartado em silêncio e ninguém sabia que havia alguém esperando.
 *
 * Fica registrado para o atendente, **sem** acionar a IA: não há texto para
 * classificar, e responder à legenda de uma foto como se fosse o pedido seria
 * responder a outra coisa. Também não grava desfecho — não houve atendimento.
 */
export async function recordUnsupportedMessage(
  repository: ChannelRepository,
  input: { externalConversationId: string; idempotencyKey: string; correlationId: string; kind: UnsupportedKind; caption?: string },
): Promise<ChannelResponse> {
  const existing = await repository.findIdempotent(input.idempotencyKey);
  if (existing) return existing;
  await repository.saveMessages(CHANNEL_NAME, input.externalConversationId, [
    { role: "customer", content: unsupportedMessageText(input.kind, input.caption), correlationId: input.correlationId, externalMessageId: input.idempotencyKey },
  ]);
  const response: ChannelResponse = { response: null, autoReply: false, status: "unsupported", handoff: false, correlationId: input.correlationId };
  await repository.saveIdempotency(input.idempotencyKey, CHANNEL_NAME, input.externalConversationId, response);
  await repository.audit({
    correlationId: input.correlationId,
    entity: `conversation:${input.externalConversationId}`,
    result: "unsupported",
    reason: `${UNSUPPORTED_LABELS[input.kind]} pelo canal; registrada para o atendente, sem resposta da IA`,
  });
  return response;
}

export class D1ChannelRepository implements ChannelRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }
  async findIdempotent(idempotencyKey: string): Promise<ChannelResponse | undefined> {
    const rows = await this.db.select().from(channelIdempotencyKeys).where(eq(channelIdempotencyKeys.idempotencyKey, idempotencyKey)).limit(1);
    return rows[0]?.responseJson as ChannelResponse | undefined;
  }
  async getHistory(channel: string, externalConversationId: string): Promise<ChannelMessageRow[]> {
    const rows = await this.db.select().from(channelMessages)
      .where(and(eq(channelMessages.channel, channel), eq(channelMessages.externalConversationId, externalConversationId)))
      // Empate de carimbo (gravações antigas do mesmo lote): a fala do cliente vem antes da resposta.
      .orderBy(asc(channelMessages.createdAt), asc(sql`case ${channelMessages.role} when 'customer' then 0 else 1 end`));
    return rows.map((row: { role: string; content: string; correlationId: string | null; createdAt: string; sentBy: string | null; externalMessageId: string | null }) => ({
      role: row.role === "agent" ? "agent" : row.role === SUGGESTION_ROLE ? SUGGESTION_ROLE : "customer",
      content: row.content,
      // Devolvido junto porque está gravado: esconder na leitura o que o banco
      // guarda faz o duplo de teste divergir do real sem ninguém perceber.
      correlationId: row.correlationId ?? undefined,
      createdAt: row.createdAt,
      sentBy: row.sentBy ?? undefined,
      externalMessageId: row.externalMessageId ?? undefined,
    }));
  }
  async saveMessages(channel: string, externalConversationId: string, messages: ChannelMessageRow[]): Promise<void> {
    // Um milissegundo a mais por mensagem do lote: com o mesmo carimbo, o banco
    // devolvia a sugestão antes da fala do cliente que ela responde.
    const base = Date.now();
    await this.db.insert(channelMessages).values(messages.map((message, index) => ({
      id: randomUUID(), channel, externalConversationId, role: message.role, content: message.content,
      correlationId: message.correlationId ?? null,
      sentBy: message.sentBy ?? null, externalMessageId: message.externalMessageId ?? null,
      createdAt: new Date(base + index).toISOString(),
    })));
  }
  async saveIdempotency(idempotencyKey: string, channel: string, externalConversationId: string, response: ChannelResponse): Promise<void> {
    await this.db.insert(channelIdempotencyKeys).values({
      idempotencyKey, channel, externalConversationId, responseJson: response, createdAt: new Date().toISOString(),
    });
  }
  async audit(entry: ChannelAuditEntry): Promise<void> {
    await this.db.insert(auditEvents).values({
      id: randomUUID(), actorId: "n8n-channel", role: "system", action: entry.action ?? "channel.message.processed",
      entity: entry.entity, beforeMasked: null, afterMasked: null, reason: entry.reason,
      correlationId: entry.correlationId, result: entry.result, origin: "ia", createdAt: new Date().toISOString(),
    });
  }
}

export class MemoryChannelRepository implements ChannelRepository {
  private readonly idempotencyStore = new Map<string, ChannelResponse>();
  private readonly messageStore: Array<ChannelMessageRow & { channel: string; externalConversationId: string }> = [];
  readonly audits: ChannelAuditEntry[] = [];
  async findIdempotent(idempotencyKey: string) { return this.idempotencyStore.get(idempotencyKey); }
  async getHistory(channel: string, externalConversationId: string) {
    return this.messageStore
      .filter((m) => m.channel === channel && m.externalConversationId === externalConversationId)
      .map(({ role, content, correlationId, createdAt, sentBy, externalMessageId }) => ({ role, content, correlationId, createdAt, sentBy, externalMessageId }));
  }
  async saveMessages(channel: string, externalConversationId: string, messages: ChannelMessageRow[]) {
    // Carimbo como o banco real faz: o prazo da memória do classificador depende dele.
    const now = new Date().toISOString();
    for (const message of messages) this.messageStore.push({ ...message, createdAt: now, channel, externalConversationId });
  }
  async saveIdempotency(idempotencyKey: string, _channel: string, _externalConversationId: string, response: ChannelResponse) {
    this.idempotencyStore.set(idempotencyKey, response);
  }
  async audit(entry: ChannelAuditEntry) { this.audits.push(entry); }
}
