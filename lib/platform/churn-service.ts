/**
 * Churn **realizado**: contratos que a BBNET perdeu no período, lidos do IXC.
 *
 * Isso não é "risco de churn". Risco é previsão sobre quem ainda não saiu, e
 * exigiria sinal que ninguém coleta hoje (consumo, reincidência de chamado,
 * atraso recorrente). O que dá para afirmar é o que já aconteceu — e é isso
 * que este serviço responde. A tela precisa manter essa distinção clara, senão
 * um número de perda vira uma previsão que ninguém fez.
 */
export interface Cancellation { reasonCode: string; cancelledAt?: string; monthlyValue?: number }

export interface ChurnOverview {
  cancellations: number;
  scanned: number;
  truncated: boolean;
  activeContracts: number;
  inactiveContracts: number;
  /** Cancelamentos sobre a base ativa. Null quando não há base para dividir. */
  churnRate: number | null;
  /** Ativações menos cancelamentos: positivo é crescimento real da base. */
  netContracts: number | null;
  monthlyRecurringLost: number;
  /**
   * Distribuição por código de motivo. O IXC devolve só o código — os endpoints
   * de tradução testados não existem na API, então não inventamos o rótulo.
   */
  reasonCodes: Array<{ code: string; contracts: number }>;
  byDay: Array<{ day: string; contracts: number }>;
  withoutValue: number;
}

export function summarizeChurn(
  cancellations: Cancellation[],
  options: { total: number; truncated: boolean; activeContracts: number; inactiveContracts: number; activationsInPeriod?: number },
): ChurnOverview {
  const reasonTotals = new Map<string, number>();
  const dayTotals = new Map<string, number>();
  let lost = 0, withoutValue = 0;

  for (const item of cancellations) {
    const code = item.reasonCode.trim() || "não informado";
    reasonTotals.set(code, (reasonTotals.get(code) ?? 0) + 1);
    const day = (item.cancelledAt ?? "").slice(0, 10);
    if (day) dayTotals.set(day, (dayTotals.get(day) ?? 0) + 1);
    if (item.monthlyValue === undefined || !Number.isFinite(item.monthlyValue)) withoutValue += 1;
    else lost += item.monthlyValue;
  }

  return {
    cancellations: options.total,
    scanned: cancellations.length,
    truncated: options.truncated,
    activeContracts: options.activeContracts,
    inactiveContracts: options.inactiveContracts,
    churnRate: options.activeContracts ? options.total / options.activeContracts : null,
    netContracts: options.activationsInPeriod === undefined ? null : options.activationsInPeriod - options.total,
    monthlyRecurringLost: lost,
    reasonCodes: [...reasonTotals.entries()].map(([code, contracts]) => ({ code, contracts })).sort((a, b) => b.contracts - a.contracts),
    byDay: [...dayTotals.entries()].map(([day, contracts]) => ({ day, contracts })).sort((a, b) => a.day.localeCompare(b.day)),
    withoutValue,
  };
}
