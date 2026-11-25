import { trustOutcomeStage, type TrustActionStage } from "./trust-unlock-stage.ts";
import { ambiguousTechnicalReference, explicitUnverifiedOrderFollowup, previousTechnicalAssertion, processProtectedTechnicalTurn, protectedTechnicalIntent, publicGreeting, publicTechnicalQuestion, safeTechnicalModelQuestion, technicalContinuity, type TechnicalEmergencyOptions, type TechnicalQuestionStage } from "./meta-technical-emergency.ts";
import { choosePilotStep, extractCurrentTechnicalPilot, isPossiblePilotAnswer, type ApprovedTechnicalStep } from "./technical-conversation-pilot.ts";
import { explicitSupportDaypart, currentTechnicalComplaint } from "./current-support-tone.ts";
import { supportRequest as supportRequestForOpening } from "../agent/troubleshooting-context.ts";
import { servicePreferences } from "../agent/service-preferences.ts";
import { hasPriorOutput, serviceOpening } from "./service-opening.ts";
import { resolveSupportReply } from "./support-reply.ts";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { auditEvents, channelIdempotencyKeys, channelMessages } from "../../db/schema.ts";
import { analyzeIntent, runAgentPipeline } from "../agent/pipeline.ts";
import { classifyIntent, llmConfigFromEnv, type Classification } from "../agent/llm-classifier.ts";
import { sanitizeHandoffText } from "../agent/handoff.ts";
import type { ChatMessage, Intent } from "../agent/types.ts";
import { appVersion } from "../runtime/app-version.ts";
import { traceAgentResult } from "../observability/trace-agent-result.ts";
import { type ReplyOverrides } from "./reply-templates-shared.ts";
import { AI_AGENT_SENDER, AI_SENDER, isAiSender } from "./conversation-state-shared.ts";
import { CLARIFY_BELOW, TRIAGE_MENU, listAsText, type InteractiveList } from "./triage-shared.ts";
import { agentTask } from "./agent-playbook-shared.ts";
import type { DoubtBotInput, DoubtBotResult } from "./doubt-bot-service.ts";
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
/** Desfecho do turno em que a IA perguntou o assunto, em vez de responder. */
export const CLARIFYING_STATUS = "clarifying";

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
  /** Meta comprovou falha de entrega, quando houve recibo gravado. */
  deliveryStatus?: string;
}
/**
 * `response` vem `null` quando a resposta automática está desligada — o fluxo do
 * n8n precisa checar `autoReply` antes de enviar qualquer coisa ao cliente.
 *
 * `externalMessageId` é o `wamid` da resposta quando o próprio canal a enviou
 * (rota da Meta): presente = já saiu, e quem chama não reenvia.
 */
export interface ChannelResponse { response: string | null; autoReply: boolean; suggestion?: string; status: string; handoff: boolean; correlationId: string; externalMessageId?: string; technicalQuestionStage?: TechnicalQuestionStage; technicalPilotStep?: ApprovedTechnicalStep }

/**
 * O resultado de tentar levar a resposta ao cliente. `unknown` = pode ter saído
 * (timeout): não é sucesso, e também não convida a reenviar.
 */
export type AutoReplyDelivery =
  | { sent: true; messageId: string; /** O que de fato saiu, quando é reentrega de um envio já feito. */ text?: string }
  | { sent: false; outcome: "blocked" | "failed" | "unknown"; reason: string };
/** `inboundMessageId` é a chave de idempotência da fala do cliente — o `wamid`, na Meta. */
export type AutoReplySender = (input: { conversationId: string; text: string; inboundMessageId: string; interactive?: InteractiveList }) => Promise<AutoReplyDelivery>;

export interface ChannelOptions {
  /** When the ticket is with the team, preserve the inbound without repeating an old action. */
  holdActionInbound?: (input: ChannelMessageInput) => Promise<boolean>;
  trustActionUnavailable?: TrustActionStage;
  onTrustActionStage?: (stage:TrustActionStage) => void;
  technicalEmergency?: TechnicalEmergencyOptions;
  autoReply: boolean;
  /** Injected clock for deterministic local courtesy; no session reset. */
  now?: number;
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
  /** Triagem do atendimento (rota da Meta): menu de assunto, protocolo e setor. Ver `triage-service.ts`. */
  triage?: TriageHooks;
  /**
   * Robô de dúvidas (n8n). Dois modos:
   * - sem `agent`, no horário comercial: só vale com `autoReply` falso — a exceção em que a
   *   IA fala sozinha **uma** vez, e só de dúvida que a base sustenta;
   * - com `agent` (`FEATURE_AI_AGENT`, modo autônomo): a IA conduz a conversa e o robô
   *   responde qualquer assunto que não exija gente (`AGENT_HUMAN_INTENTS`), a cada fala.
   * Qualquer falha cai no caminho de sempre (resposta aprovada). Ver `doubt-bot-service.ts`.
   */
  doubtBot?: {
    answer(input: DoubtBotInput): Promise<DoubtBotResult>; send: AutoReplySender; agent?: boolean;
    /**
     * Modo autônomo, depois de a IA ter passado ao atendente neste atendimento: ela continua
     * ajudando (base, autoatendimentos, cortesia), mas tudo que diz mantém a conversa na fila
     * e a resposta aprovada ("um atendente vai…") não se repete — vira sugestão.
     */
    handedOff?: boolean;
  };
}

/** O que o robô de dúvidas pode responder. O resto (fatura, bloqueio, sem internet, cancelamento) tem fluxo próprio. */
export const DOUBT_INTENTS: ReadonlySet<string> = new Set(["general_information", "sales_inquiry"]);

/**
 * O que o robô da base não responde no modo autônomo: o cliente pediu atendente, quer
 * cancelar, reclama formalmente, pede desconto ou algo que a IA não pode fazer. Sai a
 * resposta aprovada. Os quatro primeiros passam a conversa ao atendente; o pedido não
 * autorizado não (`AGENT_KEEPS_TALKING`): a IA recusa e segue a conversa.
 */
export const AGENT_HUMAN_INTENTS: ReadonlySet<string> = new Set(["human_handoff", "cancellation_risk", "complaint", "financial_discount_request", "unauthorized_request"]);

/**
 * Fatura e PIX têm fluxo próprio (CPF do titular → fatura → PIX). Quando o fluxo não
 * pode rodar (número sem cadastro único), a base não substitui a conferência: segue a
 * resposta aprovada, que passa ao financeiro.
 */
/**
 * Motivos do pipeline que **não** passam a conversa no modo autônomo. "Não entendi" calaria a
 * IA num "obrigado"; recusa de pedido não autorizado ("qual meu CPF?") calou a IA em 17/11 e o
 * "quero ajuda na internet" seguinte ficou sem resposta.
 */
export const AGENT_KEEPS_TALKING: ReadonlySet<string> = new Set(["low_intent_confidence", "unauthorized_request"]);

/** Quantas falas a IA lê no modo autônomo: o bastante para lembrar o que já perguntou na triagem. */
export const AGENT_HISTORY_TURNS = 12;

export const AGENT_FLOW_INTENTS: ReadonlySet<string> = new Set(["financial_invoice", "financial_pix"]);

/** A frase promete um atendente: no modo autônomo isso é passar a conversa — a IA não fala por cima da promessa. */
export const promisesHuman = (text: string) => /\b(um|uma) atendente\b|\ba equipe precisa\b/i.test(text);

/** Agradecimento ou "ok" no fim da conversa: no modo autônomo a IA responde com cortesia em vez do menu de assuntos. */
const THANKS = /^(muito\s+)?(obrigad[oa]|obg|brigad[oa]|valeu|vlw|agrade[cç]o)\b[^?]{0,40}$/i;
const ACK = /^(ok|okay|blz|beleza|certo|entendi|show|perfeito|t[aá] bom|tudo bem|combinado|sim|isso|pode ser|ta|tá)[!.\s]*$/i;
/** Depois de a IA fechar o assunto, "ok" e "obrigado" são despedida, não resposta a uma pergunta. */
export const isFarewell = (text: string) => THANKS.test(text.trim()) || ACK.test(text.trim());
export function courtesyReply(text: string): string | undefined {
  const value = text.trim();
  if (THANKS.test(value)) return "Por nada! Se precisar de mais alguma coisa, é só chamar por aqui.";
  if (ACK.test(value)) return "Combinado! Se precisar de mais alguma coisa, é só me chamar.";
  return undefined;
}

/**
 * O que a triagem acrescenta ao turno. O canal não conhece atendimento nem
 * protocolo — recebe estas funções prontas, e os testes do canal rodam sem elas.
 */
export interface TriageHooks {
  /** O assunto escolhido no menu, quando a fala é a resposta a ele. */
  menuChoice(text: string): Intent | undefined;
  /** A pergunta do assunto, quando a IA não tem certeza e ainda não perguntou neste atendimento. Com `interactive`, vai como lista clicável. */
  clarification(classified: Classification): { text: string; interactive?: InteractiveList } | undefined;
  /**
   * A fala é a resposta a algo que a IA pediu (o CPF da segunda via): é tratada
   * antes do classificador — que nem chega a ver o documento.
   */
  intercept?(text: string, context: { autoReply: boolean }): Promise<TriageTurn | undefined>;
  /** Depois de saber o assunto: um passo de autoatendimento no lugar da resposta aprovada (pedir o CPF, conferir o titular). */
  afterClassify?(classified: Classification, context: { text: string; autoReply: boolean }): Promise<TriageTurn | undefined>;
  /**
   * O que vai no fim da resposta: o protocolo (na primeira) e, fora do horário, quando o
   * atendimento com pessoas volta. Com `request` (o assunto do pedido), a linha de pedido registrado.
   */
  footer(context?: { clarifying?: boolean; handoff?: boolean; request?: string; serviceOrder?: { id: string; existing?: boolean } }): string | undefined;
  /** Modo autônomo: o assunto do atendimento, se o cliente é identificado e o que o sistema sabe (diagnóstico, pedido já feito). */
  /** `offHours`: fora do horário a IA atende sozinha (ver `OFF_HOURS` em `agent-playbook-shared.ts`). */
  context?(): { topic: string | null; identified: boolean; facts: string[]; registered?: boolean; offHours?: boolean };
  /** Modo autônomo: a IA resolveu o assunto — fecha o atendimento, para a próxima fala abrir outro em vez de continuar um já encerrado. */
  closeTicket?(): Promise<void>;
  /** Modo autônomo: grava o pedido que a IA deixou pronto para a equipe. */
  registerRequest?(summary: string, intent: string): Promise<void>;
  /**
   * Modo autônomo: abre a OS no IXC para o pedido técnico pronto. Devolve o número só quando o
   * IXC criou (ou já havia uma aberta); qualquer outro desfecho deixa a ficha para a equipe.
   */
  openServiceOrder?(intent: string): Promise<{ id: string; existing?: boolean } | undefined>;
  /** Modo autônomo: o modelo pediu o desbloqueio de confiança; a triagem confere tudo e devolve o texto do desfecho. */
  trustUnlock?(promisedDate?: string, currentText?: string): Promise<{ status: string; text: string } | undefined>;
  record(entry: { intent: string; source: string; confidence: number; clarifying: boolean; delivered: boolean; protocolIncluded: boolean; handoff?: boolean }): Promise<void>;
}

/**
 * Um turno que a triagem conduz sem o pipeline: a pergunta do assunto, o pedido
 * do CPF, a conferência do titular. `after` recebe se o texto chegou ao cliente
 * — "a IA pediu o CPF" só é verdade se o pedido saiu.
 */
export interface TriageTurn {
  text: string;
  /** Desfecho quando o texto sai; sem envio, é sugestão. */
  status: string;
  intent: Intent;
  /** Como o turno aparece na auditoria ("Pedido do CPF ENVIADO…"). */
  label: string;
  clarifying?: boolean;
  /** Vai como lista clicável; o histórico guarda o texto e as opções numeradas. */
  interactive?: InteractiveList;
  /** A frase passa para o atendente. Sem valor, vale `promisesHuman(text)`. */
  handoff?: boolean;
  /** O atendimento já tem pedido registrado: a despedida não tira a conversa da fila da equipe. */
  keepInQueue?: boolean;
  storedCustomerText?: string;
  after?(delivered: boolean, messageId?: string): Promise<void>;
}

type Delivery = { sent: true; messageId?: string; text?: string } | { sent: false; failure?: Extract<AutoReplyDelivery, { sent: false }> };

/**
 * Antes, com a resposta automática ligada, a resposta era gravada como enviada
 * sem que nada saísse quando ninguém do outro lado a enviava — e a tela afirmava
 * que o cliente tinha recebido. Aqui a gravação passa a seguir o envio.
 */
async function deliver(options: ChannelOptions, input: ChannelMessageInput, text: string, interactive?: InteractiveList): Promise<Delivery> {
  if (!options.autoReply) return { sent: false };
  if (!options.send) return { sent: true };
  try {
    const delivery = await options.send({ conversationId: input.externalConversationId, text, inboundMessageId: input.idempotencyKey, ...(interactive ? { interactive } : {}) });
    return delivery.sent ? delivery : { sent: false, failure: delivery };
  } catch {
    // Quem envia não deveria lançar; se lançou, não dá para afirmar nem que saiu nem que não.
    return { sent: false, failure: { sent: false, outcome: "unknown", reason: "Erro inesperado no envio automático." } };
  }
}

/**
 * O que o canal enviou leva o `wamid` (casa o recibo de entrega) e o autor da IA; o que o
 * n8n diz ter enviado fica sem autor — não registrado. `ia-agente` = a IA atendeu (sai da
 * fila); `ia` = primeira resposta ou passagem para o atendente (fica na fila).
 */
const sentFields = (delivery: Delivery, sender: string = AI_SENDER): Pick<ChannelMessageRow, "externalMessageId" | "sentBy"> =>
  delivery.sent && delivery.messageId ? { externalMessageId: delivery.messageId, sentBy: sender } : {};

/** O modo autônomo está valendo nesta fala: a IA fala (`autoReply`) e conduz a conversa. */
const agentMode = (options: ChannelOptions) => !!options.doubtBot?.agent && options.autoReply;
/** Quem assina a resposta da IA: `ia-agente` tira da fila; depois de passar ao atendente, nada tira. */
const agentSender = (options: ChannelOptions, handoff: boolean) =>
  agentMode(options) && !handoff && !options.doubtBot?.handedOff ? AI_AGENT_SENDER : AI_SENDER;

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

/** Support memory is bounded separately from the paid classifier context.
 * Only recorded conversation turns count; unsent suggestions never consume it.
 * Unknown timestamps retain the existing compatibility policy, not delivery proof.
 */
export function contextForSupport(rows: ChannelMessageRow[], now = Date.now()): ChatMessage[] {
  return rows.filter((row) => row.role !== SUGGESTION_ROLE)
    .filter((row) => !row.createdAt || !Number.isFinite(Date.parse(row.createdAt)) || now - Date.parse(row.createdAt) <= LLM_CONTEXT_MAX_AGE_MS)
    .slice(-MAX_HISTORY)
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

export interface ChannelMessageInput {
  externalConversationId: string; text: string; idempotencyKey: string; correlationId: string;
  /** O que fica gravado como fala do cliente, quando difere do texto que a IA lê (áudio transcrito: "[Áudio transcrito] …"). */
  storedText?: string;
}

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
  const greeting = publicGreeting(input.text);
  const handedOff = options.doubtBot?.handedOff || options.trustActionUnavailable === "ticket_handoff";
  if (handedOff && (greeting || currentTrustRequest(input.text, [], options.now ?? Date.now())))
    return holdActionTurn(repository, input, options);
  const emergency = options.technicalEmergency;
  if (emergency && greeting)
    return processProtectedTechnicalTurn(repository, input, { ...emergency, replyKind: "greeting" });
  if (greeting && agentMode(options)) {
    const daypart = explicitSupportDaypart(greeting);
    const opened = daypart ? daypart.charAt(0).toUpperCase() + daypart.slice(1) : "Olá";
    return currentTurnClarification(repository, input, metrics, options, `${opened}! Aqui é o suporte da BBNET. Como posso ajudar?`);
  }
  if (emergency && explicitUnverifiedOrderFollowup(input.text))
    return processProtectedTechnicalTurn(repository, input, { ...emergency, reviewReason: "guard_unverified_os_followup" });
  const complaint = emergency && currentTechnicalComplaint(input.text);
  if (emergency?.pilot) {
    const observation = extractCurrentTechnicalPilot(input.text);
    if (observation) {
      const pilotPlan = choosePilotStep(observation);
      return processProtectedTechnicalTurn(repository, input, pilotPlan ? {
        ...emergency, pilotPlan,
        complaint: complaint ? { kind: "frustrated", report: pilotPlan.report } : undefined,
      } : { ...emergency, reviewReason: emergency.reviewReason ?? "guard_pilot_review" });
    }
  }
  if (emergency && complaint) {
    return processProtectedTechnicalTurn(repository, input, complaint.kind === "review"
      ? { ...emergency, reviewReason: emergency.reviewReason ?? "guard_current_complaint_needs_review" }
      : { ...emergency, complaint });
  }
  if (emergency && publicTechnicalQuestion(input.text)) return processProtectedTechnicalTurn(repository, input, emergency);

  // Only otherwise unhandled words may answer a proven recent technical question.
  const isProtectedInput = emergency && protectedTechnicalIntent(analyzeIntent(input.text).intent);
  if (emergency && isProtectedInput && !emergency.continuation) return processProtectedTechnicalTurn(repository, input, emergency);
  const storedHistory = await repository.getHistory(CHANNEL_NAME, input.externalConversationId);
  if (emergency?.continuation) {
    const anchored = await technicalContinuity(repository, storedHistory, input, emergency.continuation.sentAt, undefined, emergency.continuation.replyToMessageId, emergency.pilot, emergency.pilotRedLightLabel, emergency.pilotLosGuidance);
    if (anchored) return processProtectedTechnicalTurn(repository, input, emergency, anchored);
  }
  if (emergency?.pilot && isPossiblePilotAnswer(input.text, emergency.pilotRedLightLabel))
    return processProtectedTechnicalTurn(repository, input, { ...emergency, reviewReason: emergency.reviewReason ?? "guard_pilot_review" });
  if (emergency && isProtectedInput) return processProtectedTechnicalTurn(repository, input, emergency);
  const lastReply = [...storedHistory].reverse().find(row => row.role === "agent");
  const now = Date.now();
  const lastReplyAt = Date.parse(lastReply?.createdAt ?? "");
  if (emergency && lastReply && isAiSender(lastReply.sentBy)
    && lastReplyAt <= now && now - lastReplyAt <= LLM_CONTEXT_MAX_AGE_MS) {
    if (ambiguousTechnicalReference(input.text) && previousTechnicalAssertion(lastReply.content))
      return processProtectedTechnicalTurn(repository, input, { ...emergency, reviewReason: "guard_referred_technical_claim" });
    if (safeTechnicalModelQuestion(lastReply.content)) return processProtectedTechnicalTurn(repository, input, emergency);
  }
  if (emergency && protectedTechnicalIntent(emergency.priorIntent))
    return processProtectedTechnicalTurn(repository, input, emergency);

  // Context isolation only; keep the immutable original transcript/audit intact.
  const historyRows = emergency
    ? storedHistory.filter(row => row.role !== "agent" || !isAiSender(row.sentBy) || !previousTechnicalAssertion(row.content))
    : storedHistory;

  // A captação de lead permanece no fluxo existente, fora do recorte técnico.
  if (captureLead) {
    await captureLead({ contactKey: input.externalConversationId, text: input.text }).catch(() => undefined);
  }
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
      { role: "customer", content: input.storedText ?? input.text, correlationId: input.correlationId, externalMessageId: input.idempotencyKey },
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

  // A resposta a um pedido da IA (o CPF) é conduzida pela triagem, sem classificador.
  const intercepted = await options.triage?.intercept?.(input.text, { autoReply: options.autoReply });
  if (intercepted) return triageTurn(repository, intercepted.storedCustomerText ? { ...input, storedText: intercepted.storedCustomerText } : input, metrics, options, intercepted, { intent: intercepted.intent, confidence: 1, source: "flow" });

  // O assunto escolhido no menu da triagem dispensa o classificador: o cliente disse.
  const menuIntent = options.triage?.menuChoice(input.text);

  // Modo autônomo: "obrigado" e "ok" ganham cortesia, não o menu de assuntos.
  // Só agradecimento: "ok"/"sim" no meio da triagem é resposta a uma pergunta da IA, e quem tem o contexto é o modelo.
  // Com o pedido já registrado, "ok" também é despedida: sem isso o modelo recebia o "ok" e repetia a ficha inteira.
  const registered = !!options.triage?.context?.().registered;
  const courtesy = !menuIntent && agentMode(options) && (THANKS.test(input.text.trim()) || (registered && isFarewell(input.text))) ? courtesyReply(input.text) ?? "Combinado! Se precisar de mais alguma coisa, é só me chamar." : undefined;
  if (courtesy) {
    return triageTurn(repository, input, metrics, options, { text: courtesy, status: AUTO_REPLIED_STATUS, intent: "general_information", label: "Resposta de cortesia", handoff: false, keepInQueue: registered }, { intent: "general_information", confidence: 1, source: "flow" });
  }
  // Classifica antes de rodar o pipeline: sem chave configurada isto cai na
  // regex e o comportamento é idêntico ao de antes. O contexto é o que o
  // modelo precisa para entender "sim" e "continua igual".
  const classified: Classification = menuIntent
    ? { intent: menuIntent, confidence: 1, source: "menu" }
    : await classifyIntent(input.text, llmConfigFromEnv(), undefined, contextForClassifier(historyRows));

  // A classificação tardia não deve escapar para diagnóstico/autoatendimento.
  if (emergency && protectedTechnicalIntent(classified.intent)) return processProtectedTechnicalTurn(repository, input, emergency);

  // Sem certeza do assunto, a IA pergunta — mas só quando é ela quem fala. No
  // modo observação o atendente lê a conversa e não precisa de menu.
  const clarification = !menuIntent && options.autoReply ? options.triage?.clarification(classified) : undefined;
  if (clarification) {
    return triageTurn(repository, input, metrics, options, { text: clarification.text, interactive: clarification.interactive, status: CLARIFYING_STATUS, intent: classified.intent, label: "Pergunta do assunto", clarifying: true }, classified);
  }

  // Assunto com autoatendimento (segunda via): pedir o CPF ou conferir o titular
  // no lugar da resposta aprovada, que só promete um atendente.
  const step = await options.triage?.afterClassify?.(classified, { text: input.text, autoReply: options.autoReply });
  if (step) return triageTurn(repository, input, metrics, options, step, classified);

  // O robô do n8n responde. No modo autônomo ele **conduz o atendimento**: todo assunto passa por
  // ele com o roteiro do assunto (`agentTask`) e o que o sistema sabe — resolve, ou pergunta o que
  // falta até o pedido ficar pronto para a equipe. Fatura de cliente identificado fica com o fluxo
  // do CPF. Fora do modo autônomo: só dúvida, uma vez, quando a IA não fala por outro caminho.
  const agent = agentMode(options);
  const context = agent ? options.triage?.context?.() : undefined;
  // O assunto do atendimento guia a conversa: "de manhã" ou "sim" no meio da triagem não troca o assunto.
  const confident = classified.source === "menu" || (classified.confidence >= CLARIFY_BELOW && classified.intent !== "general_information");
  const topic = (agent && !confident && context?.topic ? context.topic : classified.intent) as Intent;
  const botAnswers = !!options.doubtBot && (agent
    ? !(AGENT_FLOW_INTENTS.has(topic) && context?.identified)
    : !options.autoReply && !menuIntent && DOUBT_INTENTS.has(classified.intent));
  if (botAnswers && options.doubtBot) {
    // Quem escolheu "2" no menu perguntou pelo assunto da opção, não pelo número.
    const question = menuIntent ? TRIAGE_MENU.find((option) => option.intent === menuIntent)?.label ?? input.text : input.text;
    const answered = agent
      ? await doubtBotTurn(repository, input, metrics, options, options.doubtBot, { ...classified, intent: topic }, contextForSupport(historyRows).slice(-AGENT_HISTORY_TURNS), question,
        { task: agentTask(topic, { identified: context?.identified, offHours: context?.offHours }), facts: context?.facts ?? [], rows: historyRows })
      : await doubtBotTurn(repository, input, metrics, options, options.doubtBot, classified, contextForClassifier(historyRows), question);
    if (answered) return answered;
  }

  // Cumprimento ou pedido vago ("oi") no horário comercial: o robô também pergunta o assunto,
  // como faria alguém atendendo. É o mesmo menu da triagem; a resposta do cliente a ele vira
  // assunto e segue para o atendente (os autoatendimentos continuam atrás de `autoReply`).
  if (!options.autoReply && options.doubtBot && !menuIntent) {
    const asking = options.triage?.clarification(classified);
    if (asking) {
      return triageTurn(repository, input, metrics, { ...options, autoReply: true, send: options.doubtBot.send }, {
        text: asking.text, interactive: asking.interactive, status: CLARIFYING_STATUS, intent: classified.intent, label: "Pergunta do assunto", clarifying: true,
      }, classified);
    }
  }

  const result = runAgentPipeline(input.text, history, {
    channel: "whatsapp",
    intentOverride: { intent: classified.intent, confidence: classified.confidence },
  });
  await traceAgentResult(result, { channel: CHANNEL_NAME, correlationId: input.correlationId });

  // O pipeline decide intenção, transbordo e desfecho; o **texto** que sai pelo
  // canal é a resposta aprovada da intenção. O do pipeline é de homologação
  // ("preparei a segunda via fictícia") e não pode chegar a um cliente real.
  const resolvedReply = resolveSupportReply({ intent: result.intent, message: input.text, history: contextForSupport(historyRows), handoffReason: result.handoff.reason, templates: options.templates });

  const opened = serviceOpening(resolvedReply, {
    now: options.now ?? Date.now(), priorOutput: hasPriorOutput(historyRows),
    concise: servicePreferences(input.text, contextForSupport(historyRows)).conciseOpening || !!supportRequestForOpening(input.text),
  });
  // Modo autônomo: só passa a conversa o que exige gente ou o que promete um atendente.
  // "Não entendi" (baixa confiança) não cala a IA — ela segue conversando.
  const handoff = agent && ((!!result.handoff.reason && !AGENT_KEEPS_TALKING.has(result.handoff.reason)) || promisesHuman(opened));
  // Já passada ao atendente: a resposta aprovada repetiria "um atendente vai…" a cada fala. Vira sugestão.
  const pipelineOptions = agent && options.doubtBot?.handedOff ? { ...options, autoReply: false } : options;
  // A primeira resposta do atendimento leva o protocolo no fim.
  const footer = options.triage?.footer(agent ? { handoff } : undefined);
  const approved = footer ? `${opened}

${footer}` : opened;

  // Só pede nota quando a resposta é de fato entregue — não dá para avaliar
  // um atendimento que o cliente não recebeu. E não na primeira resposta pela
  // Meta: "um atendente retorna... Antes de encerrar, avalie" se contradiz.
  const askCsat = options.autoReply && !options.send && shouldAskCsat(result.finalStatus, result.handoff.required);
  const reply = askCsat ? `${approved}\n\n${CSAT_QUESTION}` : approved;
  const delivery = await deliver(pipelineOptions, input, reply);
  // Não saiu: fica a resposta aprovada, sem a pergunta de avaliação — igual ao
  // modo observação. Saiu: fica o que o cliente recebeu.
  const content = delivery.sent ? delivery.text ?? reply : approved;
  const response = await recordTurn(repository, input, metrics, {
    content, delivery,
    status: !delivery.sent ? SUGGESTED_STATUS
      : delivery.messageId && CLAIMS_RESOLUTION.has(result.finalStatus) ? AUTO_REPLIED_STATUS
      : result.finalStatus,
    // No modo autônomo o "pede humano" da tela é a decisão da IA, não o "não entendi" do pipeline.
    intent: result.intent, handoff: agent ? handoff : result.handoff.required, handoffReason: agent && !handoff ? null : result.handoff.reason,
    classified, label: handoff ? "Resposta (passada ao atendente)" : "Resposta",
    sender: agentSender(options, handoff),
  });
  await options.triage?.record({ intent: result.intent, source: classified.source, confidence: classified.confidence, clarifying: false, delivered: delivery.sent, protocolIncluded: !!footer, handoff });
  return response;
}

const normalizedActionText = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/g, " ");
const trustRequestVerb = /\b(?:pode(?:riam?|m)?\s+(?:desbloquear|liberar)|consegue\s+(?:desbloquear|liberar)|quero\s+(?:desbloquear|liberar|o desbloqueio|a liberacao)|preciso\s+(?:desbloquear|liberar|do desbloqueio|da liberacao)|(?:libera|libere|desbloqueia|desbloqueie))\b/;
const trustTarget = /\b(?:internet|conexao|sinal|(?:por|de|em) confianca|(?:liberacao|desbloqueio) temporari[oa])\b/;
const unrelatedAction = /\b(?:nao|nem)\s+(?:(?:quero|pode|precisa|tente)\s+)?(?:me\s+)?(?:desbloquear|liberar|desbloqueie|libere|libera|desbloqueia)\b|\b(?:se eu pedir|como faco para|como funciona|o que significa|esquece|desisti|na verdade (?:quero|preciso)|era (?:so|um teste)|nao (?:e|era) para|(?:quero|manda|envie|me passa)\s+(?:(?:o|a|um|uma|meu|minha)\s+)?(?:pix|boleto|segunda via))\b/;

export function currentTrustRequest(text: string, rows: ChannelMessageRow[], now: number): boolean {
  const current = normalizedActionText(text);
  const explicit = (value: string) => !unrelatedAction.test(value) && trustRequestVerb.test(value) && trustTarget.test(value);
  if (explicit(current)) return true;
  // A bare date only continues the last explicit request and a recent visible question;
  // it never substitutes the separate verified holder's authorization.
  if (!/^(?:(?:pago|vou pagar|so consigo pagar) )?(?:amanha|depois de amanha|hoje mais tarde|outro dia|mais tarde|segunda|terca|quarta|quinta|sexta|sabado|domingo|(?:dia )?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)[.! ]*$/.test(current)) return false;
  const [request, prompt] = rows.filter(row => row.role !== SUGGESTION_ROLE).slice(-2);
  const recent = (row: ChannelMessageRow) => {
    const stamp = Date.parse(row.createdAt ?? "");
    return Number.isFinite(stamp) && stamp <= now && now - stamp <= 5 * 60_000;
  };
  return request?.role === "customer" && prompt?.role === "agent" && isAiSender(prompt.sentBy)
    && recent(request) && recent(prompt) && explicit(normalizedActionText(request.content))
    && /\b(?:quando|qual dia|que dia)\b.*\b(?:pagar|pagamento)\b[^?]*\?/i.test(normalizedActionText(prompt.content));
}

async function holdActionTurn(repository: ChannelRepository, input: ChannelMessageInput, options: ChannelOptions): Promise<ChannelResponse> {
  const response = { response: null, autoReply: false, status: "human_queue_held", handoff: true, correlationId: input.correlationId };
  if (options.holdActionInbound) {
    if (!await options.holdActionInbound(input)) return await repository.findIdempotent(input.idempotencyKey) ?? response;
  } else await repository.saveMessages(CHANNEL_NAME, input.externalConversationId, [{
    role: "customer", content: input.storedText ?? input.text, correlationId: input.correlationId, externalMessageId: input.idempotencyKey,
  }]);
  await repository.saveIdempotency(input.idempotencyKey, CHANNEL_NAME, input.externalConversationId, response);
  return response;
}

async function currentTurnClarification(repository: ChannelRepository, input: ChannelMessageInput, metrics: SupportMetricsRepository | undefined, options: ChannelOptions, text: string): Promise<ChannelResponse> {
  const delivery = await deliver(options, input, text);
  return recordTurn(repository, input, metrics, {
    content: delivery.sent ? delivery.text ?? text : text, delivery, status: delivery.sent ? AUTO_REPLIED_STATUS : SUGGESTED_STATUS,
    intent: "general_information", handoff: false, handoffReason: null,
    classified: { intent: "general_information", confidence: 1, source: "flow" },
    label: "Resposta à mensagem atual", sender: agentSender(options, false),
  });
}

/**
 * O turno do robô de dúvidas. `undefined` = não houve resposta do robô (sem trecho
 * na base, n8n fora, texto reprovado): o canal segue o caminho normal. Falha tem
 * linha própria na auditoria; "a base não sabe" não é falha.
 */
async function doubtBotTurn(
  repository: ChannelRepository,
  input: ChannelMessageInput,
  metrics: SupportMetricsRepository | undefined,
  options: ChannelOptions,
  bot: NonNullable<ChannelOptions["doubtBot"]>,
  classified: Classification,
  history: ChatMessage[],
  question: string = input.text,
  agentInput?: { task: string; facts: string[]; rows: ChannelMessageRow[] },
): Promise<ChannelResponse | undefined> {
  let result: DoubtBotResult;
  try { result = await bot.answer({ question, intent: classified.intent, history, ...(agentInput ? { task: agentInput.task, facts: agentInput.facts } : {}) }); } catch { result = { kind: "failed", reason: "Erro inesperado no robô de dúvidas." }; }
  if (result.kind === "failed") {
    await repository.audit({
      correlationId: input.correlationId, entity: `conversation:${input.externalConversationId}`,
      action: "whatsapp.doubtbot.failed", result: "failed",
      reason: `Robô de dúvidas (n8n) sem resposta: ${sanitizeHandoffText(result.reason)} A conversa segue para o atendente.`,
    }).catch(() => undefined);
    return undefined;
  }
  if (result.kind === "none") return undefined;

  // Pedido pronto (modo autônomo): a ficha vai para o atendimento antes de a confirmação sair — o
  // "ficou registrado" do rodapé só é dito depois de gravado. Daí a conversa fica na fila da equipe.
  // Pedido já registrado neste atendimento: não registra de novo nem repete a ficha, só confirma que está anotado.
  const trustAction = !!bot.agent && result.action === "trust_unlock";
  if (trustAction && (bot.handedOff || options.trustActionUnavailable === "ticket_handoff"))
    return holdActionTurn(repository, input, options);
  if (trustAction && !currentTrustRequest(input.text, agentInput?.rows ?? [], options.now ?? Date.now()))
    return currentTurnClarification(repository, input, metrics, options, "Só para confirmar: o que você precisa agora?");
  const already = !trustAction && !!bot.agent && result.state === "request_complete" && !!options.triage?.context?.().registered;
  if (already) result = { ...result, text: "Já está anotado, tá bom? A equipe da BBNET continua por aqui. Se precisar de mais alguma coisa, é só me chamar.", state: "ongoing" };
  const request = !trustAction && !!bot.agent && result.state === "request_complete";
  if (request) await options.triage?.registerRequest?.(result.summary ?? result.text, classified.intent).catch(() => undefined);
  // Pedido técnico pronto: a OS sai no IXC antes da confirmação — o "abri a OS nº X" só é dito com o número na mão.
  const serviceOrder = request ? await options.triage?.openServiceOrder?.(classified.intent).catch(() => undefined) : undefined;
  // A resposta pode prometer um atendente mesmo sem pedido completo: isso também deixa a conversa na fila.
  const handoff = !trustAction && !!bot.agent && (request || already || promisesHuman(result.text));
  // Pedido de desbloqueio: o desfecho real (liberou, negou pela regra, falta o CPF) vem do sistema, não do modelo.
  if (trustAction) {
    let text: string | undefined;
    let stage: TrustActionStage = options.trustActionUnavailable ?? "hook_missing";
    if (options.triage?.trustUnlock) {
      try {
        const promisedDate = result.promisedDate && normalizedActionText(input.text).includes(normalizedActionText(result.promisedDate))
          ? result.promisedDate : undefined;
        const unlock = await options.triage.trustUnlock(promisedDate, input.text);
        text = unlock?.text;
        stage = unlock ? trustOutcomeStage(unlock.status) : options.trustActionUnavailable ?? "no_outcome";
      } catch { stage = "hook_error"; }
    }
    try { options.onTrustActionStage?.(stage); } catch { /* diagnostics do not change the response */ }
    result = { ...result, text: text ?? "Não consegui verificar a solicitação de liberação. Não tenho uma confirmação do sistema.", sources: [] };
  }
  const footer = options.triage?.footer(request ? { request: classified.intent, serviceOrder } : bot.agent ? { handoff } : undefined);
  const text = footer ? `${result.text}

${footer}` : result.text;
  const delivery = await deliver({ ...options, autoReply: true, send: bot.send }, input, text);
  const sourcesText = result.sources.length ? ` (fontes: ${result.sources.map((title) => sanitizeHandoffText(title)).join("; ")})` : "";
  const label = request ? `Pedido registrado pela IA${sourcesText}` : bot.agent ? `Resposta da IA${sourcesText}` : `Resposta do robô de dúvidas${sourcesText}`;
  const response = await recordTurn(repository, input, metrics, {
    content: delivery.sent ? delivery.text ?? text : text, delivery,
    // Primeira resposta, não atendimento: não conta como resolvido e a conversa continua na fila.
    status: delivery.sent ? AUTO_REPLIED_STATUS : SUGGESTED_STATUS,
    intent: classified.intent, handoff: false, handoffReason: null, classified, label,
    // No modo autônomo a resposta do robô atendeu (a conversa sai da fila), salvo se ela passou ao atendente.
    sender: agentSender(options, handoff),
  });
  await options.triage?.record({ intent: classified.intent, source: classified.source, confidence: classified.confidence, clarifying: false, delivered: delivery.sent, protocolIncluded: !!footer, handoff });
  // Assunto resolvido e mensagem entregue: o atendimento termina aqui. Se o cliente falar de novo, abre outro, com protocolo novo.
  if (bot.agent && result.state === "resolved" && delivery.sent) await options.triage?.closeTicket?.().catch(() => undefined);
  return response;
}

/** Envia (ou sugere) e grava um turno conduzido pela triagem, com o protocolo se for a primeira fala da IA no atendimento. */
async function triageTurn(
  repository: ChannelRepository,
  input: ChannelMessageInput,
  metrics: SupportMetricsRepository | undefined,
  options: ChannelOptions,
  turn: TriageTurn,
  classified: Classification,
): Promise<ChannelResponse> {
  const agent = agentMode(options);
  const handoff = !turn.clarifying && (turn.handoff ?? promisesHuman(turn.text));
  // O aviso de horário só deixa de sair, no modo autônomo, quando a IA resolveu: lá ele se repetiria a cada fala.
  const footer = options.triage?.footer({ clarifying: !!turn.clarifying, handoff: agent ? handoff : undefined });
  const text = footer ? `${turn.text}\n\n${footer}` : turn.text;
  const delivery = await deliver(options, input, text, turn.interactive);
  // Lista clicável: o histórico mostra também as opções, que não estão no corpo.
  const shown = turn.interactive ? `${text}\n\n${listAsText(turn.interactive)}` : text;
  const response = await recordTurn(repository, input, metrics, {
    content: delivery.sent ? delivery.text ?? shown : shown, delivery, status: delivery.sent ? turn.status : SUGGESTED_STATUS,
    intent: turn.intent, handoff: false, handoffReason: null, classified, label: turn.label,
    sender: agentSender(options, handoff || !!turn.keepInQueue),
  });
  await options.triage?.record({ intent: turn.intent, source: classified.source, confidence: classified.confidence, clarifying: !!turn.clarifying, delivered: delivery.sent, protocolIncluded: !!footer, handoff: agent && handoff });
  await turn.after?.(delivery.sent, delivery.sent ? delivery.messageId : undefined).catch(() => undefined);
  return response;
}

/**
 * Grava o turno: a fala do cliente e o que a IA disse (ou só sugeriu), a
 * idempotência, a auditoria e o desfecho. A resposta e a pergunta do assunto
 * passam pelo mesmo registro — o que sai para o cliente tem um rastro só.
 */
async function recordTurn(
  repository: ChannelRepository,
  input: ChannelMessageInput,
  metrics: SupportMetricsRepository | undefined,
  turn: { content: string; delivery: Delivery; status: string; intent: string; handoff: boolean; handoffReason: string | null; classified: Classification; label: string; sender?: string },
): Promise<ChannelResponse> {
  const { content, delivery } = turn;
  await repository.saveMessages(CHANNEL_NAME, input.externalConversationId, [
    { role: "customer", content: input.storedText ?? input.text, correlationId: input.correlationId, externalMessageId: input.idempotencyKey },
    // O `wamid` da resposta é o que casa o recibo de entrega com esta linha.
    { role: delivery.sent ? "agent" : SUGGESTION_ROLE, content, correlationId: input.correlationId, ...sentFields(delivery, turn.sender) },
  ]);

  const response: ChannelResponse = {
    response: delivery.sent ? content : null,
    autoReply: delivery.sent,
    suggestion: delivery.sent ? undefined : content,
    status: turn.status,
    handoff: turn.handoff,
    correlationId: input.correlationId,
    ...(delivery.sent && delivery.messageId ? { externalMessageId: delivery.messageId } : {}),
  };

  await repository.saveIdempotency(input.idempotencyKey, CHANNEL_NAME, input.externalConversationId, response);
  const quoted = `"${sanitizeHandoffText(content).slice(0, 180)}"`;
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
      ? `${turn.label} ENVIADA ao cliente: ${quoted}`
      : delivery.failure
        ? `${turn.label} automática NÃO enviada (ver registro do envio); fica como sugestão: ${quoted}`
        : `${turn.label} apenas sugerida, não enviada: ${quoted}`,
  });
  await auditFailure(repository, input, delivery, content);
  await metrics?.saveOutcome({
    channel: CHANNEL_NAME,
    externalConversationId: input.externalConversationId,
    intent: turn.intent,
    // Sem envio, o desfecho é "sugerido": não pode entrar na conta de resolvidos.
    finalStatus: response.status,
    handoff: turn.handoff,
    handoffReason: turn.handoffReason,
    correlationId: input.correlationId,
    // Quem classificou, com quanta certeza, e qual código produziu tudo isso.
    intentSource: turn.classified.source,
    intentConfidence: Math.round(turn.classified.confidence * 100),
    intentModel: turn.classified.model ?? null,
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
    return rows.map((row: { role: string; content: string; correlationId: string | null; createdAt: string; sentBy: string | null; externalMessageId: string | null; deliveryStatus: string | null }) => ({
      role: row.role === "agent" ? "agent" : row.role === SUGGESTION_ROLE ? SUGGESTION_ROLE : "customer",
      content: row.content,
      // Devolvido junto porque está gravado: esconder na leitura o que o banco
      // guarda faz o duplo de teste divergir do real sem ninguém perceber.
      correlationId: row.correlationId ?? undefined,
      createdAt: row.createdAt,
      sentBy: row.sentBy ?? undefined,
      externalMessageId: row.externalMessageId ?? undefined,
      deliveryStatus: row.deliveryStatus ?? undefined,
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
