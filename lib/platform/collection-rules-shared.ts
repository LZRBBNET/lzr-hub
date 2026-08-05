/**
 * Tipos e constantes da régua de cobrança que a **tela** também precisa.
 *
 * Isto existe separado do serviço por um motivo concreto: o serviço importa
 * `node:crypto` e o schema do Drizzle. Quando um componente de cliente importava
 * dele — mesmo que só para pegar a lista de canais — o empacotador arrastava
 * `node:crypto` para dentro do pacote do navegador e a aplicação inteira
 * quebrava ao carregar, não só a tela de Régua.
 *
 * Regra: o que a tela precisa mora aqui; o que toca banco mora no serviço.
 */
export const RULE_CHANNELS = ["WhatsApp", "SMS", "E-mail", "Ligação"] as const;
export type RuleChannel = typeof RULE_CHANNELS[number];

export interface RuleStepRow {
  id: string;
  offsetDays: number;
  channel: string;
  templateId: string;
  attempts: number;
  active: boolean;
}

export interface CollectionRuleRow {
  id: string;
  name: string;
  status: string;
  version: number;
  authorId: string;
  updatedAt: string;
  steps: RuleStepRow[];
}

export interface RuleStepInput { offsetDays: number; channel: string; templateId: string; attempts: number; active: boolean }
export interface RuleInput { name: string; steps: RuleStepInput[] }
