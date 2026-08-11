import { daysOverdue, isOpenInvoice } from "./billing-service.ts";

/**
 * Sinais de risco de cancelamento por cliente (issue #19).
 *
 * ⚠️ Isto **não é previsão validada**, e a tela precisa dizer isso. É a soma de
 * sinais que costumam preceder cancelamento, cada um com peso declarado. Nunca
 * foi comparado contra quem de fato cancelou — o item 5 da própria issue
 * ("medir acerto") existe justamente porque essa calibração não existe ainda.
 * Chamar de "previsão" antes de medir seria vender adivinhação como ciência.
 *
 * Dois dos seis sinais que a issue pede **não são coletados** e por isso não
 * entram na conta, em vez de entrarem como zero:
 * - quedas de conexão (exigiria o monitoramento de rede, que não está ligado)
 * - sentimento da conversa (o pipeline não detecta sentimento; a classificação
 *   é de intenção, que é outra coisa)
 *
 * A pontuação é explicável por construção: cada fator devolve o próprio motivo
 * em português, e o motivo principal é sempre o de maior peso.
 */

export interface ChurnSignals {
  customerId: string;
  /** Ordens de serviço abertas pelo cliente no período observado. */
  tickets: Array<{ subject: string; openedAt?: string }>;
  invoices: Array<{ status: string; dueAt?: string }>;
  /** Início do contrato, para medir tempo de casa. */
  customerSince?: string;
}

export interface ChurnFactor {
  /** Peso somado ao score. */
  points: number;
  reason: string;
}

export interface ChurnRisk {
  customerId: string;
  score: number;
  level: "baixo" | "médio" | "alto" | "crítico";
  /** O fator de maior peso — é o que a tela mostra como "por quê". */
  mainReason: string;
  factors: ChurnFactor[];
  /** Ação sugerida, derivada do fator principal. Sugestão para humano, nunca executada sozinha. */
  suggestedAction: string;
  /** Sinais que a issue pede mas que não existem — declarados para ninguém achar que entraram na conta. */
  missingSignals: string[];
}

export const MISSING_SIGNALS = [
  "quedas de conexão (sem integração de monitoramento de rede)",
  "sentimento da conversa (o pipeline classifica intenção, não sentimento)",
];

/**
 * Ressalvas que mudam como o número deve ser lido, e que a tela mostra junto.
 *
 * A segunda saiu de uma conferência contra a base real: das 20 OS de um
 * cadastro, havia instalação, liberação de cortesia e quatro registros de
 * teste. Contar tudo como "chamado" trata pedido de instalação como
 * insatisfação. Separar exigiria o tipo da OS (`id_assunto`), que o mapeamento
 * atual não traz.
 */
export const SCORE_CAVEATS = [
  "os pesos nunca foram comparados contra quem de fato cancelou — não há taxa de acerto",
  "toda ordem de serviço conta como chamado: instalação e ajuste administrativo não são separados de reclamação",
];

/**
 * Assunto que não diz nada. `IxcServiceOrderMapper` gera este texto quando o
 * campo vem vazio do IXC — e vem vazio com frequência: num cadastro real, 13
 * das 20 OS. Sem excluir, a recorrência agrupava as 13 como "mesmo problema
 * repetido 13 vezes" e somava peso máximo. Ausência de informação não é sinal.
 */
const UNINFORMATIVE_SUBJECTS = new Set(["assunto não informado", "assunto nao informado", "-", "n/a"]);

/** Assuntos iguais repetidos indicam problema não resolvido — pior sinal que chamados variados. */
function recurrence(tickets: Array<{ subject: string }>): { repeated: number; subject: string | null } {
  const counts = new Map<string, number>();
  for (const ticket of tickets) {
    const key = ticket.subject.trim().toLowerCase().slice(0, 40);
    if (!key || UNINFORMATIVE_SUBJECTS.has(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let subject: string | null = null, repeated = 0;
  for (const [key, count] of counts) if (count > repeated) { repeated = count; subject = key; }
  return repeated > 1 ? { repeated, subject } : { repeated: 0, subject: null };
}

function monthsSince(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  const start = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  return (now.getTime() - start.getTime()) / (30 * 86_400_000);
}

const LEVELS: Array<[number, ChurnRisk["level"]]> = [[70, "crítico"], [45, "alto"], [20, "médio"], [0, "baixo"]];

/**
 * Ação sugerida por fator principal. É sugestão para uma pessoa decidir —
 * nada aqui dispara nada sozinho.
 */
const ACTIONS: Record<string, string> = {
  recorrencia: "Ligar proativamente: o mesmo problema voltou e não foi resolvido",
  chamados: "Avaliar visita técnica — volume de chamados acima do normal",
  atraso: "Acionar cobrança antes do bloqueio, que costuma virar cancelamento",
  novo: "Acompanhar de perto: cliente novo com problema sai mais fácil",
};

/**
 * Janela de observação dos chamados, em dias.
 *
 * Existe porque o snapshot do IXC devolve as últimas OS do cliente **de
 * qualquer época e já fechadas** — sem recortar, um chamado de 2019 entraria
 * como "chamado no período" e inflaria o risco de quem não tem problema
 * nenhum hoje.
 */
export const TICKET_WINDOW_DAYS = 90;

/**
 * Chamado sem data legível não entra na janela: contar como recente inflaria
 * o risco sem prova. Mesmo princípio da fatura sem vencimento na Cobrança —
 * nunca chutar para dentro de uma faixa.
 */
function withinWindow(tickets: ChurnSignals["tickets"], now: Date, windowDays: number) {
  const floor = new Date(now.getTime() - windowDays * 86_400_000);
  return tickets.filter((ticket) => {
    if (!ticket.openedAt) return false;
    const opened = new Date(`${ticket.openedAt.slice(0, 10)}T00:00:00Z`);
    return !Number.isNaN(opened.getTime()) && opened >= floor;
  });
}

export function scoreChurnRisk(signals: ChurnSignals, now: Date = new Date(), windowDays = TICKET_WINDOW_DAYS): ChurnRisk {
  const factors: ChurnFactor[] = [];
  const tagged: Array<{ tag: string; points: number }> = [];

  const recentTickets = withinWindow(signals.tickets, now, windowDays);
  const ticketCount = recentTickets.length;
  if (ticketCount >= 5) { factors.push({ points: 40, reason: `${ticketCount} chamados em ${windowDays} dias` }); tagged.push({ tag: "chamados", points: 40 }); }
  else if (ticketCount >= 3) { factors.push({ points: 25, reason: `${ticketCount} chamados em ${windowDays} dias` }); tagged.push({ tag: "chamados", points: 25 }); }
  else if (ticketCount >= 1) { factors.push({ points: 10, reason: `${ticketCount} chamado(s) em ${windowDays} dias` }); tagged.push({ tag: "chamados", points: 10 }); }

  const { repeated } = recurrence(recentTickets);
  if (repeated > 1) { factors.push({ points: 20, reason: `Mesmo problema repetido ${repeated} vezes` }); tagged.push({ tag: "recorrencia", points: 20 }); }

  const open = signals.invoices.filter((invoice) => isOpenInvoice(invoice.status));
  const overdue = open.filter((invoice) => (daysOverdue(invoice.dueAt, now) ?? 0) > 0);
  if (overdue.length >= 3) { factors.push({ points: 35, reason: `${overdue.length} faturas vencidas` }); tagged.push({ tag: "atraso", points: 35 }); }
  else if (overdue.length === 2) { factors.push({ points: 25, reason: "2 faturas vencidas" }); tagged.push({ tag: "atraso", points: 25 }); }
  else if (overdue.length === 1) { factors.push({ points: 15, reason: "1 fatura vencida" }); tagged.push({ tag: "atraso", points: 15 }); }

  const worstDelay = Math.max(0, ...overdue.map((invoice) => daysOverdue(invoice.dueAt, now) ?? 0));
  if (worstDelay > 30) { factors.push({ points: 15, reason: `Atraso de ${worstDelay} dias na fatura mais antiga` }); tagged.push({ tag: "atraso", points: 15 }); }

  const months = monthsSince(signals.customerSince, now);
  // Cliente novo com problema sai mais fácil que quem tem anos de casa; só
  // conta quando há problema junto, senão todo cliente novo viraria "risco".
  if (months !== null && months < 6 && factors.length > 0) {
    factors.push({ points: 10, reason: `Cliente há menos de 6 meses (${Math.max(0, Math.round(months))} mês/meses)` });
    tagged.push({ tag: "novo", points: 10 });
  }

  const score = Math.min(100, factors.reduce((sum, factor) => sum + factor.points, 0));
  const level = LEVELS.find(([floor]) => score >= floor)![1];
  const strongest = [...factors].sort((a, b) => b.points - a.points)[0];
  const strongestTag = [...tagged].sort((a, b) => b.points - a.points)[0];

  return {
    customerId: signals.customerId,
    score, level,
    mainReason: strongest?.reason ?? "Nenhum sinal de risco observado",
    factors: [...factors].sort((a, b) => b.points - a.points),
    suggestedAction: strongestTag ? ACTIONS[strongestTag.tag] : "Nenhuma ação necessária",
    missingSignals: MISSING_SIGNALS,
  };
}

/**
 * Ordena a fila de ação: maior risco primeiro. Cliente sem sinal nenhum fica
 * de fora — uma fila cheia de score zero esconde quem precisa de atenção.
 */
export function buildActionQueue(risks: ChurnRisk[], limit = 20): ChurnRisk[] {
  return risks.filter((risk) => risk.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}
