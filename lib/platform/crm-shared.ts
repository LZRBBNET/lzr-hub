/**
 * Etapas do funil e tipos do CRM, sem nada de servidor.
 *
 * Fica separado porque a tela do Kanban precisa das etapas, e componente com
 * `"use client"` que importa de `lib/platform/` arrasta `node:crypto` e o
 * schema do Drizzle para o pacote do navegador — já quebrou o projeto uma vez.
 */

/**
 * As etapas são **fixas**, não configuráveis. A issue pedia configuráveis, e
 * essa é uma escolha consciente: etapa configurável só serve depois que a
 * operação sabe qual é o funil dela, e hoje ninguém nunca usou um. Fixar quatro
 * etapas legíveis vale mais que uma tela de configuração de algo que ainda não
 * tem prática — e mudar isso depois é migração de dados, não redesenho.
 */
export const LEAD_STAGES = [
  { id: "novo", label: "Novo contato", hint: "Chegou e ainda não foi qualificado" },
  { id: "qualificado", label: "Qualificado", hint: "Tem viabilidade e interesse" },
  { id: "proposta", label: "Proposta enviada", hint: "Recebeu plano e preço" },
  { id: "ganho", label: "Ganho", hint: "Virou contrato" },
  { id: "perdido", label: "Perdido", hint: "Desistiu ou não tinha viabilidade" },
] as const;

export type LeadStage = typeof LEAD_STAGES[number]["id"];
/** Etapas que ainda estão em andamento — as duas últimas encerram o lead. */
export const OPEN_STAGES: LeadStage[] = ["novo", "qualificado", "proposta"];
export const CLOSED_STAGES: LeadStage[] = ["ganho", "perdido"];

export const LEAD_SOURCES = ["whatsapp", "telefone", "indicação", "presencial", "site", "outro"] as const;

export interface Lead {
  id: string;
  name: string;
  maskedPhone: string;
  city: string;
  neighborhood: string;
  source: string;
  stage: LeadStage;
  ownerId: string | null;
  contactKey: string | null;
  note: string | null;
  closedAt: string | null;
  lostReason: string | null;
  /** Cadastro criado no IXC a partir deste lead. Preenchido, impede um segundo cadastro. */
  ixcCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadActivity {
  id: string;
  leadId: string;
  kind: "stage_change" | "contact" | "note";
  fromStage: string | null;
  toStage: string | null;
  detail: string;
  actorId: string;
  createdAt: string;
}

export interface FunnelMetrics {
  /** Quantos leads em cada etapa, agora. */
  byStage: Record<string, number>;
  created: number;
  won: number;
  lost: number;
  open: number;
  /** Ganhos ÷ encerrados. `null` quando nada foi encerrado — 0% seria mentira. */
  conversionRate: number | null;
  /** Dias entre criação e fechamento dos leads ganhos. `null` sem nenhum ganho. */
  averageCycleDays: number | null;
  /** De onde vieram os leads do período. */
  bySource: Array<{ source: string; leads: number }>;
}
