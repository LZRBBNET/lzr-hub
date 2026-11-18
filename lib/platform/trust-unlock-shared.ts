import { BUSINESS_DAYS, holidayName } from "./triage-shared.ts";

/**
 * Regra da BBNET para a IA liberar a internet em confiança (Vinícius, 18/11/2026):
 *
 *  1. Primeiro a IA tenta o pagamento — manda o PIX e diz que, pagando, libera na hora.
 *     (Isso é o roteiro do assunto; aqui só se decide se o desbloqueio pode sair.)
 *  2. Não usou o desbloqueio no mês passado (nem neste) → pode liberar.
 *  3. Usou → só libera se aquela vez foi paga em dia, sem atraso.
 *  4. No fim de semana (e feriado: também não há equipe) a IA pode liberar mesmo quando a
 *     regra 3 impediria.
 *
 * O IXC tem as regras dele por cima (contrato ativo não aceita, limite de usos): ele pode
 * recusar mesmo quando isto permite, e a recusa dele vale.
 */

/** Bloqueio por atraso: é o que o desbloqueio de confiança resolve. Bloqueio manual é decisão de alguém. */
export const DEBT_BLOCK_STATUSES: ReadonlySet<string> = new Set(["CA", "FA"]);

export type TrustUnlockReason =
  | "not_blocked" | "manual_block" | "already_active"
  | "never_used_recently" | "paid_on_time" | "weekend_override"
  | "used_last_month_late";

export interface TrustUnlockDecision { allowed: boolean; reason: TrustUnlockReason }

export interface TrustUnlockFacts {
  internetStatus: string;
  trustUnlockActive: boolean;
  /** `dt_ult_des_bloq_conf` do contrato, `AAAA-MM-DD`. */
  lastUnlockAt: string | null;
  /** Faturas pagas depois do último desbloqueio: vencimento e pagamento. */
  paidAfterUnlock: Array<{ dueAt: string; paidAt: string }>;
}

function saoPauloDay(at: Date): { day: string; weekday: number; year: number; month: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
    .formatToParts(at).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday), year: Number(parts.year), month: Number(parts.month) };
}

/** Sem equipe: sábado, domingo ou feriado. */
export function noStaffDay(at: Date): boolean {
  const today = saoPauloDay(at);
  return !BUSINESS_DAYS.has(today.weekday) || !!holidayName(today.day);
}

/** Primeiro dia do mês passado, `AAAA-MM-01`: uso daí em diante é "usou no mês passado" (ou neste). */
export function previousMonthStart(at: Date): string {
  const { year, month } = saoPauloDay(at);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`;
}

export function trustUnlockDecision(facts: TrustUnlockFacts, at: Date = new Date()): TrustUnlockDecision {
  if (facts.internetStatus === "CM") return { allowed: false, reason: "manual_block" };
  if (!DEBT_BLOCK_STATUSES.has(facts.internetStatus)) return { allowed: false, reason: "not_blocked" };
  if (facts.trustUnlockActive) return { allowed: false, reason: "already_active" };
  const usedRecently = !!facts.lastUnlockAt && facts.lastUnlockAt.slice(0, 10) >= previousMonthStart(at);
  if (!usedRecently) return { allowed: true, reason: "never_used_recently" };
  // "Pagou aquela vez em dia": houve pagamento depois do desbloqueio, e todos dentro do vencimento.
  const paidOnTime = facts.paidAfterUnlock.length > 0 && facts.paidAfterUnlock.every((item) => item.paidAt.slice(0, 10) <= item.dueAt.slice(0, 10));
  if (paidOnTime) return { allowed: true, reason: "paid_on_time" };
  if (noStaffDay(at)) return { allowed: true, reason: "weekend_override" };
  return { allowed: false, reason: "used_last_month_late" };
}

/** O que a IA diz ao cliente em cada desfecho. Nada promete prazo que o IXC não informou. */
export const TRUST_UNLOCK_TEXT = {
  done: "Pronto: liberei sua internet em confiança enquanto o pagamento compensa. Pode levar alguns minutos para voltar; se não voltar, desligue o equipamento da tomada por 30 segundos e ligue de novo. O pagamento continua necessário para não bloquear de novo.",
  needsCpf: "Para liberar, preciso confirmar o titular do contrato: me diga o CPF, só os números.",
  notBlocked: "Pelo seu cadastro, a internet não está bloqueada por atraso, então não há o que liberar. Se estiver sem conexão, me conte o que aparece nas luzes do equipamento.",
  alreadyActive: "Sua internet já está liberada em confiança. Assim que o pagamento compensar, fica tudo normal.",
  manualBlock: "O bloqueio do seu contrato não é por atraso, então não consigo liberar por aqui. A equipe confere com você no próximo atendimento.",
  usedLate: "O desbloqueio de confiança já foi usado no mês passado e aquela fatura foi paga com atraso, então não consigo liberar de novo por aqui. Pagando o PIX, a internet volta na hora.",
  refused: "O sistema não aceitou liberar agora. Pagando o PIX, a internet volta na hora; se preferir, a equipe confere com você.",
  failed: "Não consegui liberar agora por uma falha no sistema. Pagando o PIX, a internet volta na hora; a equipe também vai conferir.",
  unidentified: "Este número de WhatsApp não está no cadastro de um único contrato, então não consigo liberar por aqui. Pagando a fatura, a internet volta na hora.",
} as const;
