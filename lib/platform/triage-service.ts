import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { supportTickets } from "../../db/schema.ts";
import { REPLY_WINDOW_MS } from "./conversation-state-shared.ts";
import { diagnoseConnection, type ConnectionDiagnosis, type DiagnosisInput } from "./connection-diagnosis-shared.ts";
import type { IncidentsRepository } from "./incidents-service.ts";
import type { TriageHooks } from "./n8n-channel-service.ts";
import {
  CLARIFY_BELOW, CLARIFY_TEXT, DIAGNOSABLE_INTENTS, formatProtocol, menuChoice, protocolFooter, queueForIntent,
  type TicketIdentification, type TicketStage, type TicketSummary,
} from "./triage-shared.ts";

/**
 * O atendimento (`support_tickets`): protocolo, identificação do cliente no IXC
 * e o que a triagem decidiu — assunto, setor e se a IA já perguntou o assunto.
 *
 * A conversa com um número dura para sempre; o atendimento começa na primeira
 * fala depois do último fechamento e termina quando alguém resolve a conversa
 * ou quando o cliente passa 24 horas calado. É a unidade que o cliente reconhece
 * ("meu protocolo é…") e a que o setor recebe.
 */

export interface TicketRow extends TicketSummary { id: string; channel: string; conversationId: string; lastCustomerAt: string }
type TicketPatch = Partial<Omit<TicketRow, "id" | "channel" | "conversationId">>;

export interface TicketRepository {
  findOpen(channel: string, conversationId: string): Promise<TicketRow | undefined>;
  /** O aberto, ou o último fechado — a tela mostra o protocolo mesmo depois de resolvida. */
  latest(channel: string, conversationId: string): Promise<TicketRow | undefined>;
  /** Atendimentos abertos das conversas da página, por `canal:conversa`. */
  openMany(conversationIds: string[]): Promise<Map<string, TicketRow>>;
  /** `undefined` = já havia um aberto (duas mensagens chegaram juntas). */
  create(row: Omit<TicketRow, "protocol">): Promise<{ seq: number } | undefined>;
  update(id: string, patch: TicketPatch): Promise<void>;
}

const iso = (at: number) => new Date(at).toISOString();

/**
 * O atendimento em curso, ou um novo. Aberto há mais de 24 horas sem o cliente
 * falar é fechado por inatividade: a janela da Meta já fechou, ninguém mais
 * responderia a ele, e a fala nova é outro contato — com outro protocolo.
 */
export async function openOrContinueTicket(
  repository: TicketRepository,
  input: { channel: string; conversationId: string; now?: number },
): Promise<{ ticket: TicketRow; created: boolean }> {
  const at = input.now ?? Date.now();
  let open = await repository.findOpen(input.channel, input.conversationId);
  if (open && at - Date.parse(open.lastCustomerAt) > REPLY_WINDOW_MS) {
    await repository.update(open.id, { status: "closed", closedAt: iso(at), closedReason: "inactivity" });
    open = undefined;
  }
  if (open) {
    await repository.update(open.id, { lastCustomerAt: iso(at) });
    return { ticket: { ...open, lastCustomerAt: iso(at) }, created: false };
  }

  const row: Omit<TicketRow, "protocol"> = {
    id: randomUUID(), channel: input.channel, conversationId: input.conversationId, status: "open",
    openedAt: iso(at), lastCustomerAt: iso(at), closedAt: null, closedReason: null,
    identification: "pending", ixcCustomerId: null, intent: null, intentSource: null, intentConfidence: null,
    queue: null, stage: "new", protocolSentAt: null, diagnosis: null,
  };
  const created = await repository.create(row);
  if (!created) {
    const raced = await repository.findOpen(input.channel, input.conversationId);
    if (raced) return { ticket: raced, created: false };
    throw new Error("Atendimento não pôde ser aberto");
  }
  // O protocolo nasce num segundo passo. Se falhar, o atendimento segue sem ele
  // — e a tela diz "não gerado" em vez de mostrar um número que não existe.
  const protocol = formatProtocol(created.seq, new Date(at));
  const saved = await repository.update(row.id, { protocol }).then(() => true, () => false);
  return { ticket: { ...row, protocol: saved ? protocol : null }, created: true };
}

/** Atendimento aberto fecha quando alguém resolve a conversa. A próxima fala abre outro, com outro protocolo. */
export async function closeOpenTicket(repository: TicketRepository, channel: string, conversationId: string, now = Date.now()): Promise<void> {
  const open = await repository.findOpen(channel, conversationId);
  if (open) await repository.update(open.id, { status: "closed", closedAt: iso(now), closedReason: "resolved" });
}

/** Busca no IXC pelo telefone. Lança quando o IXC não responde; `undefined` = nenhum ou mais de um cadastro. */
export type CustomerLookup = (phone: string) => Promise<{ id: string } | undefined>;

/**
 * Quem é o cliente, uma vez por atendimento. O IXC tem limite de consultas por
 * minuto, e a busca por telefone gasta várias (cada formato do número em cada
 * campo): repetir a cada mensagem gastaria o limite que o atendente precisa.
 * Só tenta de novo quando o IXC não respondeu da última vez.
 */
export async function identifyTicketCustomer(repository: TicketRepository, ticket: TicketRow, lookup: CustomerLookup): Promise<TicketRow> {
  if (ticket.identification === "identified" || ticket.identification === "not_found") return ticket;
  let patch: TicketPatch;
  try {
    const customer = await lookup(ticket.conversationId);
    patch = customer ? { identification: "identified", ixcCustomerId: customer.id } : { identification: "not_found", ixcCustomerId: null };
  } catch {
    patch = { identification: "unavailable" };
  }
  await repository.update(ticket.id, patch).catch(() => undefined);
  return { ...ticket, ...patch };
}

/**
 * O que a busca do atendimento já sabe, no formato da captação de lead: assim o
 * funil não consulta o IXC de novo. IXC fora do ar continua lançando — e, na
 * dúvida, o funil não cria lead (regra da issue #17).
 */
export function knownCustomer(ticket: TicketRow): CustomerLookup {
  return async () => {
    if (ticket.identification === "identified" && ticket.ixcCustomerId) return { id: ticket.ixcCustomerId };
    if (ticket.identification === "not_found") return undefined;
    throw new Error("IXC indisponível");
  };
}

/**
 * Grava a decisão da triagem. O assunto só é trocado por uma classificação
 * confiante (ou escolha no menu): o "ok, obrigado" do fim da conversa não pode
 * mudar o setor de quem pediu segunda via.
 */
export async function recordTriage(
  repository: TicketRepository,
  ticket: TicketRow,
  entry: { intent: string; source: string; confidence: number; clarifying: boolean; delivered: boolean; protocolIncluded: boolean; now?: number },
): Promise<void> {
  const patch: TicketPatch = {};
  const confident = entry.source === "menu" || (entry.confidence >= CLARIFY_BELOW && entry.intent !== "general_information");
  if (confident || !ticket.intent) {
    patch.intent = entry.intent; patch.intentSource = entry.source; patch.intentConfidence = Math.round(entry.confidence * 100);
    patch.queue = queueForIntent(entry.intent);
  }
  // A pergunta só vale como "perguntou" se chegou ao cliente; senão ele não tem o
  // que responder. Depois da resposta a ela, o atendimento segue para o setor
  // mesmo se continuar vago — a triagem não pergunta duas vezes. Fala vaga sem
  // pergunta (modo observação) deixa a etapa como está: se a resposta automática
  // for ligada no meio, a pergunta ainda pode ser feita.
  let stage: TicketStage | undefined;
  if (entry.clarifying) stage = entry.delivered ? "clarifying" : undefined;
  else if (confident || ticket.stage === "clarifying") stage = "routed";
  if (stage) patch.stage = stage;
  if (entry.delivered && entry.protocolIncluded && !ticket.protocolSentAt) patch.protocolSentAt = iso(entry.now ?? Date.now());
  if (Object.keys(patch).length > 0) await repository.update(ticket.id, patch);
}

/** Lê o IXC e devolve o diagnóstico. Injetado: a triagem não conhece o IXC, e os testes rodam sem ele. */
export type Diagnose = (ixcCustomerId: string) => Promise<ConnectionDiagnosis>;
/** O webhook da Meta espera a resposta: o diagnóstico não pode prender a rota além disto. */
export const DIAGNOSIS_BUDGET_MS = 6000;

/**
 * O diagnóstico de verdade: o IXC (login, contrato, OS abertas) e as massivas
 * registradas na tela — que é a fonte de massiva que existe hoje (não há
 * integração de monitoramento de rede). Massiva que não carregar não impede o
 * diagnóstico: só deixa de aparecer.
 */
export function ixcDiagnose(
  provider: { getServiceDiagnosis(customerId: string, correlationId: string): Promise<DiagnosisInput> },
  incidents: Pick<IncidentsRepository, "list">,
  correlationId: string,
): Diagnose {
  return async (customerId) => {
    const [data, recent] = await Promise.all([provider.getServiceDiagnosis(customerId, correlationId), incidents.list(50).catch(() => [])]);
    return diagnoseConnection(data, recent.filter((incident) => incident.status !== "resolved"));
  };
}

/**
 * Diagnóstico de conexão, uma vez por atendimento técnico e só com o cliente
 * identificado — sem saber quem é, não há contrato para olhar. Roda depois da
 * resposta ao cliente, então não atrasa o que ele recebe. Estourar o tempo ou
 * o IXC falhar só deixa o atendimento sem diagnóstico: o atendente verifica.
 */
export async function diagnoseTicket(repository: TicketRepository, ticket: TicketRow, intent: string, diagnose: Diagnose | undefined, budgetMs = DIAGNOSIS_BUDGET_MS): Promise<ConnectionDiagnosis | undefined> {
  if (!diagnose || ticket.diagnosis || !DIAGNOSABLE_INTENTS.has(intent) || ticket.identification !== "identified" || !ticket.ixcCustomerId) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const diagnosis = await Promise.race([
      diagnose(ticket.ixcCustomerId),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), budgetMs); }),
    ]);
    if (diagnosis) await repository.update(ticket.id, { diagnosis });
    return diagnosis;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Como a triagem entra no canal: menu, pergunta do assunto, protocolo na primeira
 * resposta e o registro da decisão. Falha ao gravar nunca derruba o atendimento.
 */
export function triageHooks(repository: TicketRepository, ticket: TicketRow, diagnose?: Diagnose): TriageHooks {
  return {
    menuChoice: (text) => (ticket.stage === "clarifying" ? menuChoice(text) : undefined),
    // Pergunta uma vez por atendimento: se a resposta à pergunta também for vaga,
    // segue o caminho normal (que passa para um atendente) em vez de repetir o menu.
    clarification: (classified) => (ticket.stage === "new" && (classified.confidence < CLARIFY_BELOW || classified.intent === "general_information") ? { text: CLARIFY_TEXT } : undefined),
    footer: () => (ticket.protocol && !ticket.protocolSentAt ? protocolFooter(ticket.protocol) : undefined),
    record: async (entry) => {
      await recordTriage(repository, ticket, entry).catch(() => undefined);
      if (!entry.clarifying) await diagnoseTicket(repository, ticket, entry.intent, diagnose);
    },
  };
}

/**
 * O começo de cada fala do cliente: atendimento aberto (ou continuado), cliente
 * identificado e a triagem pronta para o canal.
 *
 * Nunca derruba o atendimento: se a tabela não responder, devolve `undefined` e
 * o canal segue como antes — sem protocolo e sem menu, mas respondendo.
 */
export async function startTriage(
  repository: TicketRepository,
  input: { channel: string; conversationId: string; lookup: CustomerLookup; diagnose?: Diagnose; now?: number },
): Promise<{ ticket: TicketRow; hooks: TriageHooks; knownCustomer: CustomerLookup } | undefined> {
  try {
    const { ticket: opened } = await openOrContinueTicket(repository, input);
    const ticket = await identifyTicketCustomer(repository, opened, input.lookup);
    return { ticket, hooks: triageHooks(repository, ticket, input.diagnose), knownCustomer: knownCustomer(ticket) };
  } catch {
    return undefined;
  }
}

export function ticketSummary(row: TicketRow): TicketSummary {
  return {
    protocol: row.protocol, status: row.status, openedAt: row.openedAt, closedAt: row.closedAt, closedReason: row.closedReason,
    identification: row.identification, ixcCustomerId: row.ixcCustomerId, intent: row.intent, intentSource: row.intentSource,
    intentConfidence: row.intentConfidence, queue: row.queue, stage: row.stage, protocolSentAt: row.protocolSentAt,
    diagnosis: row.diagnosis,
  };
}

type Row = typeof supportTickets.$inferSelect;
const toTicket = (row: Row): TicketRow => ({
  id: row.id, channel: row.channel, conversationId: row.externalConversationId, protocol: row.protocol,
  status: row.status === "closed" ? "closed" : "open", openedAt: row.openedAt, lastCustomerAt: row.lastCustomerAt,
  closedAt: row.closedAt, closedReason: row.closedReason,
  identification: (row.identification as TicketIdentification) ?? "pending", ixcCustomerId: row.ixcCustomerId,
  intent: row.intent, intentSource: row.intentSource, intentConfidence: row.intentConfidence, queue: row.queue,
  stage: (row.stage as TicketStage) ?? "new", protocolSentAt: row.protocolSentAt,
  diagnosis: (row.diagnosis as ConnectionDiagnosis | null) ?? null,
});

export class DbTicketRepository implements TicketRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async findOpen(channel: string, conversationId: string) {
    const rows: Row[] = await this.db.select().from(supportTickets)
      .where(and(eq(supportTickets.channel, channel), eq(supportTickets.externalConversationId, conversationId), eq(supportTickets.status, "open"))).limit(1);
    return rows[0] ? toTicket(rows[0]) : undefined;
  }

  async latest(channel: string, conversationId: string) {
    const rows: Row[] = await this.db.select().from(supportTickets)
      .where(and(eq(supportTickets.channel, channel), eq(supportTickets.externalConversationId, conversationId)))
      .orderBy(desc(supportTickets.seq)).limit(1);
    return rows[0] ? toTicket(rows[0]) : undefined;
  }

  async openMany(conversationIds: string[]) {
    if (conversationIds.length === 0) return new Map<string, TicketRow>();
    const rows: Row[] = await this.db.select().from(supportTickets)
      .where(and(inArray(supportTickets.externalConversationId, conversationIds), eq(supportTickets.status, "open")));
    return new Map(rows.map((row) => [`${row.channel}:${row.externalConversationId}`, toTicket(row)]));
  }

  async create(row: Omit<TicketRow, "protocol">) {
    const rows: Array<{ seq: number }> = await this.db.insert(supportTickets).values({
      id: row.id, channel: row.channel, externalConversationId: row.conversationId, status: row.status,
      openedAt: row.openedAt, lastCustomerAt: row.lastCustomerAt, identification: row.identification, stage: row.stage,
    }).onConflictDoNothing().returning({ seq: supportTickets.seq });
    return rows[0];
  }

  async update(id: string, patch: TicketPatch) {
    await this.db.update(supportTickets).set(patch).where(eq(supportTickets.id, id));
  }
}

export class MemoryTicketRepository implements TicketRepository {
  readonly tickets: TicketRow[] = [];
  private seq = 0;
  failUpdates = false;
  async findOpen(channel: string, conversationId: string) {
    return this.tickets.find((t) => t.channel === channel && t.conversationId === conversationId && t.status === "open");
  }
  async latest(channel: string, conversationId: string) {
    return [...this.tickets].reverse().find((t) => t.channel === channel && t.conversationId === conversationId);
  }
  async openMany(conversationIds: string[]) {
    return new Map(this.tickets.filter((t) => t.status === "open" && conversationIds.includes(t.conversationId)).map((t) => [`${t.channel}:${t.conversationId}`, t]));
  }
  async create(row: Omit<TicketRow, "protocol">) {
    // Checagem e inclusão sem `await` no meio, como o índice único faz no banco.
    if (this.tickets.some((t) => t.channel === row.channel && t.conversationId === row.conversationId && t.status === "open")) return undefined;
    this.tickets.push({ ...row, protocol: null });
    return { seq: ++this.seq };
  }
  async update(id: string, patch: TicketPatch) {
    if (this.failUpdates) throw new Error("banco fora");
    const index = this.tickets.findIndex((t) => t.id === id);
    if (index >= 0) this.tickets[index] = { ...this.tickets[index], ...patch };
  }
}
