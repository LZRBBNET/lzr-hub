/**
 * Tipos e listas de Equipes que a **tela** também precisa.
 *
 * Mora separado do serviço porque o serviço importa `node:crypto` e o schema do
 * Drizzle — e um componente de cliente que importasse dele arrastaria os dois
 * para o pacote do navegador. Já aconteceu com a régua de cobrança.
 */

/**
 * Os motivos pelos quais a IA para e passa para uma pessoa.
 *
 * A lista é fechada porque é o que `lib/agent/handoff.ts` de fato registra em
 * `conversation_outcomes.handoff_reason`. Uma equipe só pode reivindicar motivo
 * que existe — senão a tela mostraria carga de trabalho de algo que nunca
 * acontece.
 */
export const HANDOFF_REASONS = [
  "low_intent_confidence",
  "customer_requested_human",
  "customer_irritated",
  "cancellation_risk",
  "unauthorized_request",
  "formal_complaint",
  "sensitive_action",
  "action_forbidden",
  "required_tool_failed",
  "contradictory_or_partial_data",
  "repetition_without_resolution",
] as const;
export type HandoffReason = typeof HANDOFF_REASONS[number];

/** Nome técnico não serve para quem escala equipe: cada motivo tem rótulo e explicação. */
export const REASON_LABELS: Record<string, [string, string]> = {
  low_intent_confidence: ["A IA não entendeu o pedido", "Nenhuma regra casou e a confiança ficou abaixo do corte"],
  customer_requested_human: ["Cliente pediu atendente", "Pedido explícito de falar com uma pessoa"],
  customer_irritated: ["Cliente irritado", "Tom da mensagem indica irritação"],
  cancellation_risk: ["Risco de cancelamento", "Cliente falou em cancelar"],
  unauthorized_request: ["Pedido não autorizado", "Pediu dado de outro cliente ou tentou burlar regra"],
  formal_complaint: ["Reclamação formal", "Cliente registrou reclamação"],
  sensitive_action: ["Ação sensível", "A ação exige decisão humana"],
  action_forbidden: ["Ação proibida", "A política impede a IA de executar"],
  required_tool_failed: ["Ferramenta falhou", "Uma consulta necessária não respondeu"],
  contradictory_or_partial_data: ["Dado contraditório ou parcial", "As fontes discordam ou faltou informação"],
  repetition_without_resolution: ["Repetiu sem resolver", "A conversa girou sem progresso"],
};
export const reasonLabel = (key: string): string => REASON_LABELS[key]?.[0] ?? key;
export const reasonHint = (key: string): string => REASON_LABELS[key]?.[1] ?? "Motivo registrado pelo pipeline";

export const MAX_TEAM_NAME = 60;
export const MAX_TEAM_DESCRIPTION = 240;

export interface TeamMember { userId: string; name: string; email: string; role: string; active: boolean }

export interface Team {
  id: string;
  name: string;
  /** Rótulo curto da fila de atendimento (ex.: "tecnico", "financeiro"). */
  queue: string;
  description: string | null;
  active: boolean;
  /** Motivos de transbordo que esta equipe assume. */
  handoffReasons: string[];
  members: TeamMember[];
  updatedAt: string;
}

export interface TeamInput { name: string; queue: string; description: string | null; handoffReasons: string[] }

/** Quantos transbordos, no período, caíram nos motivos que a equipe assume. */
export interface TeamLoad { teamId: string; handoffs: number; byReason: Record<string, number> }
