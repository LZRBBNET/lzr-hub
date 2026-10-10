/**
 * Quem cuida de cada conversa, e quando ela precisa de resposta.
 *
 * Sem dependência de servidor: a tela, a casca do app e o canal usam as mesmas
 * regras. Antes cada lugar contava "aguardando" do seu jeito, e o menu dizia
 * "2 clientes esperando" por conversas de dez dias atrás que nem podiam mais
 * ser respondidas — a janela de 24 horas da Meta já tinha fechado.
 *
 * O modelo é o das caixas de entrada de suporte (Chatwoot, Intercom, Front):
 * uma conversa está **aberta** ou **resolvida**, e aberta pode ter um
 * **responsável** humano. Sem responsável, quem atende é a IA. Resolvida volta
 * a ficar aberta, sem responsável, quando o cliente escreve de novo — com o
 * histórico intacto.
 */

export type ConversationStatus = "open" | "resolved";

/** O que fica gravado. Ausência de linha = aberta, sem responsável. */
export interface ConversationStateRow {
  status: ConversationStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  assignedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

/** O estado que vale agora, já considerando a reabertura pela fala do cliente. */
export interface EffectiveState {
  status: ConversationStatus;
  /** Estava resolvida e o cliente escreveu depois disso. */
  reopened: boolean;
  assigneeId: string | null;
  assigneeName: string | null;
  assignedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

const UNASSIGNED: EffectiveState = { status: "open", reopened: false, assigneeId: null, assigneeName: null, assignedAt: null, resolvedAt: null, resolvedBy: null };

const after = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) && Date.parse(a) > Date.parse(b);

/**
 * Reabrir é derivado, não gravado: a conversa resolvida que recebeu fala nova
 * do cliente está aberta e sem responsável. Gravar isso exigiria que o canal de
 * entrada escrevesse no estado a cada mensagem — e um canal que falha no meio
 * deixaria a conversa "resolvida" com cliente esperando.
 */
export function effectiveState(row: ConversationStateRow | undefined, lastCustomerAt: string | null | undefined): EffectiveState {
  if (!row) return UNASSIGNED;
  if (row.status === "resolved") {
    if (after(lastCustomerAt, row.resolvedAt)) return { ...UNASSIGNED, reopened: true, resolvedAt: row.resolvedAt, resolvedBy: row.resolvedBy };
    return { status: "resolved", reopened: false, assigneeId: row.assigneeId, assigneeName: row.assigneeName, assignedAt: row.assignedAt, resolvedAt: row.resolvedAt, resolvedBy: row.resolvedBy };
  }
  return { status: "open", reopened: false, assigneeId: row.assigneeId, assigneeName: row.assigneeName, assignedAt: row.assignedAt, resolvedAt: null, resolvedBy: null };
}

/**
 * A IA pode responder sozinha? Não, se um humano assumiu e a conversa segue
 * aberta. É a trava que faltava antes de ligar a resposta automática: sem ela, a
 * IA responderia por cima do atendente no meio da conversa. Chamada no momento
 * em que a fala nova chega — então uma conversa resolvida conta como reaberta.
 */
export function botMayReply(row: ConversationStateRow | undefined): boolean {
  return !(row && row.status === "open" && row.assigneeId);
}

/**
 * Autor gravado em `sent_by` quando a resposta automática da IA sai pelo próprio
 * canal (Meta). Nulo continua significando "não registrado" — nunca "a IA".
 */
export const AI_SENDER = "ia";
export const AI_SENDER_NAME = "IA";

type SentRow = { role: string; sentBy?: string | null; createdAt?: string };
const isAiReply = (row: SentRow) => row.role === "agent" && row.sentBy === AI_SENDER;
const isHumanReply = (row: SentRow) => row.role === "agent" && !!row.sentBy && row.sentBy !== AI_SENDER;

/**
 * A resposta automática é **primeira resposta**, uma por espera. As respostas
 * aprovadas são fixas e quase todas prometem um atendente ("um atendente retorna
 * por aqui"): a IA confirma que recebeu, e o resto é de gente. Uma segunda
 * resposta automática na mesma espera repetiria o texto ou responderia ao "ok"
 * do cliente com "Pode me contar o que você precisa?".
 *
 * A espera recomeça quando um humano responde ou resolve a conversa.
 */
export function autoReplyUsed(historyOldestFirst: SentRow[], resolvedAt: string | null | undefined): boolean {
  for (let i = historyOldestFirst.length - 1; i >= 0; i--) {
    const row = historyOldestFirst[i];
    if (isHumanReply(row)) return false;
    if (isAiReply(row)) return !after(resolvedAt, row.createdAt);
  }
  return false;
}

/**
 * Desde quando o cliente espera um humano. Sugestão não conta como resposta (o
 * cliente nunca a viu), e a resposta automática também não: ela confirma o
 * recebimento e promete um atendente, então a conversa continua na fila até
 * alguém de fato responder.
 */
export function awaitingSinceFrom(rowsNewestFirst: SentRow[]): string | undefined {
  let since: string | undefined;
  for (const row of rowsNewestFirst) {
    if (row.role === "suggestion" || isAiReply(row)) continue;
    if (row.role !== "customer") break;
    since = row.createdAt;
  }
  return since;
}

/** A janela de texto livre da Meta: 24 horas desde a última fala do cliente. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function windowOpen(lastCustomerAt: string | null | undefined, now: number) {
  if (!lastCustomerAt) return false;
  const at = Date.parse(lastCustomerAt);
  return Number.isFinite(at) && now - at <= REPLY_WINDOW_MS;
}

/**
 * Precisa de resposta de alguém: o cliente falou por último (sugestão da IA não
 * conta), a conversa está aberta e ainda dá para responder. Esperando com a
 * janela fechada não entra — ninguém consegue responder, e contar isso no menu
 * só ensina a ignorar o número.
 */
export function needsReply(item: { awaitingSince?: string; lastCustomerAt?: string; state?: EffectiveState }, now: number) {
  return !!item.awaitingSince && (item.state?.status ?? "open") === "open" && windowOpen(item.lastCustomerAt ?? item.awaitingSince, now);
}

/** Espera até 5 min é normal; até 30 min pede atenção; acima disso está atrasada. */
export const WAIT_WARN_MS = 5 * 60 * 1000;
export const WAIT_LATE_MS = 30 * 60 * 1000;
export function waitTone(since: string, now: number): "ok" | "warn" | "bad" {
  const elapsed = now - Date.parse(since);
  if (!Number.isFinite(elapsed) || elapsed < WAIT_WARN_MS) return "ok";
  return elapsed < WAIT_LATE_MS ? "warn" : "bad";
}

export type StateAction = "claim" | "release" | "resolve" | "reopen";
export const STATE_ACTIONS: readonly StateAction[] = ["claim", "release", "resolve", "reopen"];
