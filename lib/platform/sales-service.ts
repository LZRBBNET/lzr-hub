/**
 * Desempenho comercial medido no que a BBNET realmente vendeu: contratos
 * ativados no período, lidos do IXC.
 *
 * Não existe CRM aqui. Lead, funil, taxa de conversão e ciclo de venda
 * dependem de registrar o contato **antes** da venda, e nada no LZR HUB nem no
 * IXC faz isso hoje — a tabela `leads` existe no schema e nunca recebeu uma
 * linha. Por isso este serviço só responde o que dá para provar: a venda
 * fechada. O que falta é declarado na tela, não estimado.
 */
/** `status` é a situação atual do contrato no IXC: "A" ativo, "I" encerrado. */
export interface SalesActivation { planName: string; monthlyValue?: number; activatedAt?: string; status?: string }

export interface SalesOverview {
  activations: number;
  /** Quantas foram efetivamente lidas — base do ticket médio e do mix. */
  scanned: number;
  truncated: boolean;
  activeContracts: number;
  monthlyRecurringAdded: number;
  averageTicket: number | null;
  /** Planos mais vendidos no período, do maior para o menor. */
  planMix: Array<{ plan: string; contracts: number; value: number }>;
  /** Ativações sem valor de plano legível: contadas à parte, nunca somadas como zero. */
  withoutValue: number;
  byDay: Array<{ day: string; contracts: number }>;
  /**
   * Quantas dessas vendas já foram canceladas. A venda continua contando — quem
   * vendeu vendeu — mas esconder isso daria a impressão de que a base cresceu
   * na mesma proporção, e não cresceu.
   */
  alreadyCancelled: number;
}

export function summarizeSales(
  activations: SalesActivation[],
  options: { total: number; truncated: boolean; activeContracts: number },
): SalesOverview {
  const planTotals = new Map<string, { contracts: number; value: number }>();
  const dayTotals = new Map<string, number>();
  let recurring = 0, withValue = 0, withoutValue = 0, alreadyCancelled = 0;

  for (const activation of activations) {
    // "I" é encerrado no IXC — "C" não existe e devolveria zero em silêncio.
    if (activation.status?.trim().toUpperCase() === "I") alreadyCancelled += 1;
    const plan = activation.planName.trim() || "Plano não informado";
    const current = planTotals.get(plan) ?? { contracts: 0, value: 0 };
    const value = activation.monthlyValue;
    if (value === undefined || !Number.isFinite(value)) withoutValue += 1;
    else { recurring += value; withValue += 1; current.value += value; }
    current.contracts += 1;
    planTotals.set(plan, current);

    const day = (activation.activatedAt ?? "").slice(0, 10);
    if (day) dayTotals.set(day, (dayTotals.get(day) ?? 0) + 1);
  }

  return {
    activations: options.total,
    scanned: activations.length,
    truncated: options.truncated,
    activeContracts: options.activeContracts,
    monthlyRecurringAdded: recurring,
    // Média sobre as que têm valor: dividir pelo total incluiria as sem valor como zero.
    averageTicket: withValue ? recurring / withValue : null,
    planMix: [...planTotals.entries()]
      .map(([plan, totals]) => ({ plan, ...totals }))
      .sort((a, b) => b.contracts - a.contracts),
    withoutValue,
    byDay: [...dayTotals.entries()].map(([day, contracts]) => ({ day, contracts })).sort((a, b) => a.day.localeCompare(b.day)),
    alreadyCancelled,
  };
}
