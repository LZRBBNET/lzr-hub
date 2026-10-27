import type { Intent } from "../agent/types.ts";
import type { ConnectionDiagnosis } from "./connection-diagnosis-shared.ts";

/**
 * Triagem do atendimento: protocolo, setor e o menu que confirma o assunto.
 *
 * Sem dependência de servidor: a tela de Atendimentos usa os mesmos rótulos.
 *
 * O desenho segue o que os bots de provedor fazem (o Opa! Suite da própria IXC,
 * SimplesDesk, Talqui): a IA entende o assunto, e quando não tem certeza
 * **pergunta** em vez de passar para humano às cegas. Antes, 11 de 13 conversas
 * reais transbordavam por "não entendi" — e o atendente recebia a conversa sem
 * saber nem o assunto.
 */

/** Setor de destino. É o mesmo rótulo de fila (`queue`) que Equipes já usa. */
export type TriageQueue = "tecnico" | "financeiro" | "comercial" | "atendimento";

export const QUEUE_LABELS: Record<TriageQueue, string> = {
  tecnico: "Suporte técnico",
  financeiro: "Financeiro",
  comercial: "Comercial",
  atendimento: "Atendimento",
};
export const TRIAGE_QUEUES = Object.keys(QUEUE_LABELS) as TriageQueue[];
export const queueLabel = (queue: string | null | undefined): string => (queue && queue in QUEUE_LABELS ? QUEUE_LABELS[queue as TriageQueue] : "Sem setor");

/**
 * Para onde vai cada assunto. Cancelamento fica com o Comercial porque é
 * retenção; reclamação e pedido de atendente, com o atendimento geral.
 */
export function queueForIntent(intent: Intent | string): TriageQueue {
  if (intent.startsWith("technical_")) return "tecnico";
  if (intent.startsWith("financial_")) return "financeiro";
  if (intent === "sales_inquiry" || intent === "cancellation_risk") return "comercial";
  return "atendimento";
}

/**
 * O menu que confirma o assunto. Texto numerado, como o da IXC, e não lista
 * interativa da Meta: funciona em qualquer WhatsApp e o atendente lê na tela
 * exatamente o que o cliente leu.
 */
export const TRIAGE_MENU: ReadonlyArray<{ label: string; intent: Intent }> = [
  { label: "Sem internet", intent: "technical_no_connection" },
  { label: "Internet lenta ou Wi-Fi fraco", intent: "technical_slow" },
  { label: "Segunda via ou PIX", intent: "financial_invoice" },
  { label: "Internet bloqueada", intent: "financial_unlock" },
  { label: "Já paguei", intent: "financial_payment" },
  { label: "Visita técnica, instalação ou mudança de endereço", intent: "technical_visit" },
  { label: "Planos e contratação", intent: "sales_inquiry" },
  { label: "Cancelamento", intent: "cancellation_risk" },
  { label: "Falar com um atendente", intent: "human_handoff" },
];

// Start with one open question rather than making someone traverse nine choices.
// Keep numeric menu parsing for existing conversations that saw the old menu.
export const CLARIFY_TEXT = "Sou a assistente virtual da BBNET. O que você precisa resolver? Pode me contar com suas palavras.";

/** Abaixo disto a IA pergunta o assunto em vez de responder. É o mesmo corte do transbordo por "não entendi". */
export const CLARIFY_BELOW = 0.6;

const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * O assunto escolhido no menu: o número ("3", "3.", "opção 3") ou o nome exato da
 * opção. Texto livre não entra aqui — quem escreve "minha fatura veio errada" é
 * entendido melhor pelo classificador do que por casamento de palavra.
 */
export function menuChoice(text: string): Intent | undefined {
  const value = normalize(text);
  const number = value.match(/^(?:opcao\s*)?(\d{1,2})\s*[).:-]?$/);
  if (number) return TRIAGE_MENU[Number(number[1]) - 1]?.intent;
  return TRIAGE_MENU.find((option) => normalize(option.label) === value)?.intent;
}

/** `AAAAMMDD` no fuso de Brasília + o sequencial com 6 dígitos. */
export function formatProtocol(seq: number, at: Date): string {
  const day = at.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace(/-/g, "");
  return `${day}${String(seq).padStart(6, "0")}`;
}

export const protocolFooter = (protocol: string) => `Protocolo do atendimento: ${protocol}`;

export type TicketStage = "new" | "clarifying" | "routed";
export type TicketIdentification = "pending" | "identified" | "not_found" | "unavailable";

/** O que a tela mostra do atendimento. */
export interface TicketSummary {
  protocol: string | null;
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
  closedReason: string | null;
  identification: TicketIdentification;
  ixcCustomerId: string | null;
  intent: string | null;
  intentSource: string | null;
  intentConfidence: number | null;
  queue: string | null;
  stage: TicketStage;
  protocolSentAt: string | null;
  /** Diagnóstico de conexão, quando o assunto é técnico e o cliente foi identificado. */
  diagnosis: ConnectionDiagnosis | null;
}

/** Assuntos em que o diagnóstico de conexão ajuda: o problema pode estar no contrato, no login ou na rede. */
export const DIAGNOSABLE_INTENTS = new Set(["technical_no_connection", "technical_slow", "technical_wifi", "technical_restart"]);

export const STAGE_LABELS: Record<TicketStage, string> = {
  new: "Recebido",
  clarifying: "IA perguntou o assunto",
  routed: "Encaminhado ao setor",
};

export const IDENTIFICATION_LABELS: Record<TicketIdentification, string> = {
  pending: "Consultando o IXC",
  identified: "Cliente identificado pelo telefone",
  not_found: "Telefone sem cadastro único no IXC",
  unavailable: "IXC não respondeu",
};
