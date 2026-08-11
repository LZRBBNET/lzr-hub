/**
 * Cockpit do gestor (issue #22): os números de todos os módulos numa tela só.
 *
 * O princípio que rege este arquivo é o mesmo do Customer 360: cada fonte é
 * consultada em paralelo e **falha isolada**. Se o IXC cair, os cartões de
 * conversa continuam aparecendo; se o banco cair, os do IXC continuam. Um
 * cartão sem fonte disponível vira `null` com um motivo escrito — nunca zero,
 * que numa tela de gestor seria lido como "não há inadimplente", e não como
 * "não consegui perguntar".
 *
 * A própria issue já previu esse desenho: "o painel pode nascer mostrando o
 * que já existe e ganhar cartões conforme os módulos ficam prontos".
 */

/** Um número do cockpit. `value: null` sempre vem com `detail` dizendo por quê. */
export interface CockpitMetric {
  value: number | null;
  detail: string;
}

export interface CockpitSnapshot {
  period: string;
  since: string;
  /** Clientes com contrato ativo no IXC. */
  activeCustomers: CockpitMetric;
  /** Faturas em aberto na base inteira — contagem exata, sem somar valor (ver billing-service). */
  openInvoices: CockpitMetric;
  overdueValue: CockpitMetric;
  conversations: CockpitMetric;
  resolutionRate: CockpitMetric;
  csat: CockpitMetric;
  openIncidents: CockpitMetric;
  affectedCustomers: CockpitMetric;
  goalProgressPercent: CockpitMetric;
  /** Custo de IA depende do Langfuse (issue #6) — nasce indisponível e é honesto sobre isso. */
  aiCost: CockpitMetric;
  recentActivity: Array<{ id: string; action: string; entity: string; result: string; createdAt: string; actorId: string }>;
  /** Fontes que falharam nesta consulta, para a tela poder dizer o que está faltando. */
  degraded: string[];
}

const unavailable = (detail: string): CockpitMetric => ({ value: null, detail });

/**
 * O cartão de custo de IA é o mais fácil de mentir sem querer.
 *
 * Hoje a IA responde com texto fixo — só o classificador de intenção usa
 * modelo, e ele não reporta uso ao Langfuse. Então o custo somado é zero por
 * **falta de instrumentação**, não porque a IA seja gratuita. Exibir
 * "R$ 0,00" seria lido como "a IA não custa nada", que é justamente o tipo de
 * número inventado que este projeto recusa. Zero só vira zero na tela quando
 * houver rastro com custo de modelo de verdade.
 */
function aiCostMetric(input: { cost: number; observations: number } | null | undefined): CockpitMetric {
  if (!input) return unavailable("Langfuse desligado ou fora do ar");
  if (input.observations === 0) return unavailable("Nenhum rastro registrado no período");
  if (input.cost === 0) return unavailable(`${input.observations} rastro(s), nenhum com custo de modelo — o classificador não reporta uso`);
  return { value: input.cost, detail: `${input.observations} rastro(s) no período` };
}

/**
 * Monta o snapshot a partir de resultados já resolvidos. Função pura de
 * propósito: dá para provar o comportamento de degradação (uma fonte cai, as
 * outras seguem) sem banco e sem rede.
 */
export function buildCockpitSnapshot(input: {
  period: string;
  since: string;
  /**
   * Por que o IXC não respondeu. "Indisponível" e "está no ar, mas em modo
   * allowlist, que não conta a base" são coisas diferentes — quem lê o cockpit
   * precisa saber qual das duas, senão vai procurar defeito no lugar errado.
   */
  ixcUnavailableReason?: string;
  /**
   * Custo lido do Langfuse. `observations` distingue as três situações que um
   * número sozinho confundiria: não medimos, medimos e não houve rastro, ou
   * medimos e o custo é de fato zero.
   */
  aiCost?: { cost: number; observations: number } | null;
  activeContracts?: number | null;
  openInvoices?: number | null;
  overdueValue?: number | null;
  support?: { conversations: number; resolutionRate: number | null; csatAverage: number | null; csatCount: number } | null;
  incidents?: Array<{ status: string; affectedCustomers: number }> | null;
  goal?: { targetContracts: number; realizedContracts: number | null } | null;
  audit?: Array<{ id: string; action: string; entity: string; result: string; createdAt: string; actorId: string }> | null;
}): CockpitSnapshot {
  const degraded: string[] = [];

  const ixcReason = input.ixcUnavailableReason ?? "IXC indisponível";

  const activeCustomers = input.activeContracts === null || input.activeContracts === undefined
    ? (degraded.push("IXC"), unavailable(ixcReason))
    : { value: input.activeContracts, detail: "Contratos ativos no IXC" };

  const openInvoices = input.openInvoices === null || input.openInvoices === undefined
    ? unavailable(ixcReason)
    : { value: input.openInvoices, detail: "Faturas em aberto na base" };

  const overdueValue = input.overdueValue === null || input.overdueValue === undefined
    ? unavailable(ixcReason)
    : { value: input.overdueValue, detail: "Somado das faturas vencidas lidas" };

  let conversations: CockpitMetric, resolutionRate: CockpitMetric, csat: CockpitMetric;
  if (!input.support) {
    degraded.push("conversas");
    conversations = unavailable("Banco indisponível");
    resolutionRate = unavailable("Banco indisponível");
    csat = unavailable("Banco indisponível");
  } else {
    conversations = { value: input.support.conversations, detail: input.support.conversations ? "Registradas no período" : "Nenhuma no período" };
    resolutionRate = input.support.resolutionRate === null
      ? unavailable("Sem conversa no período para calcular")
      : { value: Math.round(input.support.resolutionRate * 100), detail: "Resolvidas sem humano" };
    csat = input.support.csatAverage === null
      ? unavailable("Nenhuma avaliação recebida")
      : { value: input.support.csatAverage, detail: `${input.support.csatCount} avaliação(ões)` };
  }

  let openIncidents: CockpitMetric, affectedCustomers: CockpitMetric;
  if (!input.incidents) {
    degraded.push("massivas");
    openIncidents = unavailable("Banco indisponível");
    affectedCustomers = unavailable("Banco indisponível");
  } else {
    const open = input.incidents.filter((incident) => incident.status !== "resolved");
    openIncidents = { value: open.length, detail: open.length ? "Em aberto agora" : "Nenhuma em aberto" };
    affectedCustomers = open.length
      // A estimativa é digitada por quem registrou a massiva — a tela diz isso
      // para o número não passar por medição automática.
      ? { value: open.reduce((sum, incident) => sum + incident.affectedCustomers, 0), detail: "Estimativa de quem registrou" }
      : { value: 0, detail: "Nenhuma massiva aberta" };
  }

  const goalProgressPercent = !input.goal
    ? unavailable("Nenhuma meta registrada para o mês")
    : input.goal.realizedContracts === null
      ? unavailable("Realizado depende do IXC")
      : input.goal.targetContracts === 0
        ? unavailable("Meta do mês está zerada")
        : { value: Math.round(input.goal.realizedContracts / input.goal.targetContracts * 100), detail: `${input.goal.realizedContracts} de ${input.goal.targetContracts} contratos` };

  return {
    period: input.period,
    since: input.since,
    activeCustomers, openInvoices, overdueValue,
    conversations, resolutionRate, csat,
    openIncidents, affectedCustomers,
    goalProgressPercent,
    aiCost: aiCostMetric(input.aiCost),
    recentActivity: input.audit ?? [],
    degraded,
  };
}
