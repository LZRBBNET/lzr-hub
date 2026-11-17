import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { supportTickets } from "../../db/schema.ts";
import { REPLY_WINDOW_MS } from "./conversation-state-shared.ts";
import { diagnoseConnection, type ConnectionDiagnosis, type DiagnosisInput } from "./connection-diagnosis-shared.ts";
import type { IncidentsRepository } from "./incidents-service.ts";
import type { TriageHooks, TriageTurn } from "./n8n-channel-service.ts";
import type { Intent } from "../agent/types.ts";
import {
  ASK_CPF_TEXT, INVALID_CPF_TEXT, INVOICE_INTENTS, MAX_CPF_ATTEMPTS, MISMATCH_TEXT, UNAVAILABLE_TEXT, VERIFIED_HANDOFF_TEXT,
  extractDocument, invoiceDraft, type InvoiceSelfService,
} from "./invoice-self-service-shared.ts";
import {
  CLARIFY_BELOW, CLARIFY_TEXT, DIAGNOSABLE_INTENTS, TRIAGE_LIST, offHoursMenuText, offHoursNote, formatProtocol, menuChoice, protocolFooter, queueForIntent,
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
    queue: null, stage: "new", protocolSentAt: null, diagnosis: null, selfService: null,
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
/**
 * "Devolver à IA" depois de a IA ter passado para o atendente: o atendimento volta
 * a ser dela. Sem isso, a conversa devolvida continuaria calada até fechar.
 */
export async function resumeTicketForAi(repository: TicketRepository, channel: string, conversationId: string): Promise<void> {
  const open = await repository.findOpen(channel, conversationId);
  if (open?.stage === "handoff") await repository.update(open.id, { stage: "routed" });
}

export async function closeOpenTicket(repository: TicketRepository, channel: string, conversationId: string, now = Date.now()): Promise<void> {
  const open = await repository.findOpen(channel, conversationId);
  if (open) await repository.update(open.id, { status: "closed", closedAt: iso(now), closedReason: "resolved" });
}

/**
 * O atendente mandou uma mensagem com o protocolo (em geral, a sugestão da IA
 * usada como rascunho): o cliente foi informado. Sem isto, no modo observação o
 * protocolo só contava como "informado" quando a IA enviava — o que nunca
 * acontece — e reaparecia no fim de toda sugestão seguinte.
 */
export async function markProtocolQuoted(repository: TicketRepository, channel: string, conversationId: string, text: string, now = Date.now()): Promise<boolean> {
  const open = await repository.findOpen(channel, conversationId);
  if (!open?.protocol || open.protocolSentAt || !text.includes(open.protocol)) return false;
  await repository.update(open.id, { protocolSentAt: iso(now) });
  return true;
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
  entry: { intent: string; source: string; confidence: number; clarifying: boolean; delivered: boolean; protocolIncluded: boolean; handoff?: boolean; now?: number },
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
  // A IA disse ao cliente que um atendente continua: daqui em diante ela se cala
  // (modo autônomo). Só vale se a frase chegou — sugestão não passou nada a ninguém.
  if (entry.handoff && entry.delivered) stage = "handoff";
  else if (ticket.stage === "handoff") stage = undefined;
  else if (entry.clarifying) stage = entry.delivered ? "clarifying" : undefined;
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

/** O que a segunda via precisa do IXC. Injetado, como o diagnóstico: a triagem não conhece o IXC. */
export interface InvoiceLookup {
  /** CPF/CNPJ gravado no cadastro (com ou sem máscara). Lança se o IXC não responder. */
  documentOf(ixcCustomerId: string): Promise<string | undefined>;
  openInvoices(ixcCustomerId: string): Promise<Array<{ id: string; dueAt?: string; value?: number; paymentCode?: string }>>;
  /** PIX copia-e-cola de uma fatura (`get_pix`). Ausente = sem PIX no rascunho. */
  pixCode?(invoiceId: string): Promise<{ copyPaste: string; expiresAt: string | null }>;
}

export interface InvoiceOptions {
  lookup: InvoiceLookup;
  /**
   * `FEATURE_AI_INVOICE`: a IA manda vencimento, valor e linha digitável ao
   * cliente. Desligada, ela só confirma o titular e o atendente envia — com o
   * rascunho pronto na ficha.
   */
  sendData: boolean;
  budgetMs?: number;
  now?: () => number;
}

function withinBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("IXC lento")), ms); })]).finally(() => clearTimeout(timer));
}

/**
 * Confere o titular: o CPF informado tem de ser o do cadastro que o telefone da
 * conversa identificou. Confere → lê as faturas em aberto. O IXC lento ou fora
 * do ar vira "não consegui consultar", nunca "não confere" — acusar o cliente de
 * errar o próprio CPF por falha nossa seria mentir para ele.
 */
export async function verifyHolder(ticket: TicketRow, digits: string, invoice: InvoiceOptions, attempts: number): Promise<InvoiceSelfService> {
  const now = (invoice.now ?? Date.now)();
  const at = iso(now);
  const budget = invoice.budgetMs ?? DIAGNOSIS_BUDGET_MS;
  try {
    const document = await withinBudget(invoice.lookup.documentOf(ticket.ixcCustomerId ?? ""), budget);
    if (!document || document.replace(/\D/g, "") !== digits) return { step: "mismatch", at, attempts };
    const today = at.slice(0, 10);
    const invoices = (await withinBudget(invoice.lookup.openInvoices(ticket.ixcCustomerId ?? ""), budget)).map((item) => ({
      id: item.id, dueAt: item.dueAt ?? null, value: item.value ?? null,
      overdue: !!item.dueAt && item.dueAt.slice(0, 10) < today, paymentCode: item.paymentCode ?? null,
    }));
    // PIX só da que vence primeiro, e só depois do titular confirmado. Se o IXC
    // não devolver, a conferência continua valendo: o rascunho sai sem o código.
    let pix: InvoiceSelfService["pix"] = null;
    if (invoices[0] && invoice.lookup.pixCode) {
      try { pix = { invoiceId: invoices[0].id, ...(await withinBudget(invoice.lookup.pixCode(invoices[0].id), budget)) }; } catch { pix = null; }
    }
    return { step: "verified", at, attempts, invoices, pix, draft: invoiceDraft(invoices, pix) };
  } catch {
    return { step: "unavailable", at, attempts };
  }
}

/** A leitura de verdade para a segunda via: o documento do cadastro e as faturas em aberto, uma consulta cada. */
export function ixcInvoiceLookup(
  provider: { getCustomerRecord(customerId: string, correlationId: string): Promise<Record<string, unknown> | undefined>; listOpenInvoicesOf(customerId: string, correlationId: string): Promise<Array<{ id: string; dueAt?: string; value?: number; paymentCode?: string }>> },
  correlationId: string,
  pixCode?: (invoiceId: string, correlationId: string) => Promise<{ copyPaste: string; expiresAt: string | null }>,
): InvoiceLookup {
  return {
    ...(pixCode ? { pixCode: (invoiceId: string) => pixCode(invoiceId, correlationId) } : {}),
    documentOf: async (customerId) => {
      const document = String((await provider.getCustomerRecord(customerId, correlationId))?.cnpj_cpf ?? "").trim();
      return document || undefined;
    },
    openInvoices: (customerId) => provider.listOpenInvoicesOf(customerId, correlationId),
  };
}

/** A IA pediu o CPF e ainda espera — a resposta a isso não pode cair na regra "uma por espera". */
export function awaitingCpf(ticket: TicketRow): boolean {
  const step = ticket.selfService?.step;
  return step === "awaiting_cpf" || (step === "invalid_cpf" && (ticket.selfService?.attempts ?? 0) < MAX_CPF_ATTEMPTS);
}

/**
 * Os passos da segunda via. Só existem com o cliente identificado pelo telefone:
 * sem cadastro do número, não há com o que conferir o CPF, e o atendimento segue
 * para o financeiro como antes.
 */
function invoiceSteps(repository: TicketRepository, ticket: TicketRow, invoice: InvoiceOptions | undefined): Pick<TriageHooks, "intercept" | "afterClassify"> {
  const canVerify = () => !!invoice && ticket.identification === "identified" && !!ticket.ixcCustomerId
    && ticket.selfService?.step !== "verified" && ticket.selfService?.step !== "mismatch";
  const save = (state: InvoiceSelfService) => repository.update(ticket.id, { selfService: state });

  async function holderTurn(found: { digits?: string; invalid?: boolean }, intent: Intent, autoReply: boolean): Promise<TriageTurn> {
    const attempts = (ticket.selfService?.attempts ?? 0) + 1;
    const at = iso((invoice?.now ?? Date.now)());
    if (!found.digits) {
      const last = attempts >= MAX_CPF_ATTEMPTS;
      return {
        text: last ? "Não consegui confirmar o titular. Um atendente vai te ajudar por aqui." : INVALID_CPF_TEXT,
        status: last ? "replied" : "waiting_customer", intent, label: last ? "Conferência do titular" : "Pedido do CPF",
        after: async () => { await save({ step: "invalid_cpf", at, attempts }); },
      };
    }
    // A conferência aconteceu, a resposta chegando ou não ao cliente: grava já.
    const state = await verifyHolder(ticket, found.digits, invoice as InvoiceOptions, attempts);
    await save(state).catch(() => undefined);
    const text = state.step === "verified"
      // Modo observação: o rascunho com a fatura vai para o atendente, que confere e envia.
      ? (!autoReply || invoice?.sendData ? state.draft ?? VERIFIED_HANDOFF_TEXT : VERIFIED_HANDOFF_TEXT)
      : state.step === "mismatch" ? MISMATCH_TEXT : UNAVAILABLE_TEXT;
    return { text, status: "replied", intent, label: "Conferência do titular" };
  }

  return {
    // A resposta ao pedido do CPF — ou o CPF mandado num atendimento que já é de fatura.
    intercept: async (text, { autoReply }) => {
      if (!canVerify() || !(awaitingCpf(ticket) || INVOICE_INTENTS.has(ticket.intent ?? ""))) return undefined;
      const found = extractDocument(text);
      // Número que não fecha como CPF só é "CPF errado" se a IA pediu o CPF; fora
      // disso é outro número qualquer (um telefone com DDD também tem 11 dígitos).
      if (!found.digits && !(found.invalid && awaitingCpf(ticket))) return undefined;
      const intent = (INVOICE_INTENTS.has(ticket.intent ?? "") ? ticket.intent : "financial_invoice") as Intent;
      return holderTurn(found, intent, autoReply);
    },
    afterClassify: async (classified, { text, autoReply }) => {
      if (!INVOICE_INTENTS.has(classified.intent) || !canVerify()) return undefined;
      const found = extractDocument(text);
      if (found.digits) return holderTurn(found, classified.intent, autoReply);
      // Sem documento na fala, a IA pede — só quando é ela quem fala. No modo
      // observação a ficha mostra ao atendente que o CPF ainda falta.
      if (!autoReply) return undefined;
      const at = iso((invoice?.now ?? Date.now)());
      return {
        text: ASK_CPF_TEXT, status: "waiting_customer", intent: classified.intent, label: "Pedido do CPF",
        after: async (delivered) => { if (delivered) await save({ step: "awaiting_cpf", at, attempts: 0 }); },
      };
    },
  };
}

/**
 * Como a triagem entra no canal: menu, pergunta do assunto, protocolo na primeira
 * resposta, os passos da segunda via e o registro da decisão. Falha ao gravar
 * nunca derruba o atendimento.
 */
/**
 * Resposta ao "sem internet" a partir do diagnóstico, quando a IA fala sozinha.
 * Só os casos em que o diagnóstico muda o que dizer: bloqueio, massiva, OS já
 * aberta e conexão chegando ao equipamento. Offline sem causa conhecida segue a
 * resposta aprovada (reinício guiado). Nada aqui afirma ação que não aconteceu:
 * a IA conta o que leu no IXC e o que vem a seguir.
 */
export function diagnosisReply(diagnosis: ConnectionDiagnosis, canAskCpf: boolean): { text: string; askCpf: boolean } | undefined {
  if (diagnosis.verdict === "blocked") {
    if (diagnosis.trustUnlockEligible || !diagnosis.facts.some((fact) => fact.includes("manualmente"))) {
      return canAskCpf
        ? { text: "Verifiquei seu cadastro: sua conexão está bloqueada por pendência financeira. Posso te enviar a fatura com o PIX para regularizar — me diga o CPF do titular do contrato, só os números.", askCpf: true }
        : { text: "Verifiquei seu cadastro: sua conexão está bloqueada por pendência financeira. Um atendente te ajuda a regularizar por aqui.", askCpf: false };
    }
    return { text: "Verifiquei seu cadastro: o acesso do seu contrato está suspenso. Um atendente precisa conferir com você por aqui.", askCpf: false };
  }
  if (diagnosis.incident) return { text: `Identificamos uma instabilidade na rede da sua região (${diagnosis.incident.neighborhood}), que já está registrada com a equipe técnica. Assim que normalizar, sua internet volta sem você precisar mexer no equipamento.`, askCpf: false };
  if (diagnosis.openServiceOrderId) return { text: `Já existe um chamado técnico aberto para você (nº ${diagnosis.openServiceOrderId}). A equipe segue com ele, não é preciso abrir outro.`, askCpf: false };
  if (diagnosis.verdict === "online") return { text: "Verifiquei aqui: a conexão está chegando até o seu equipamento, então o problema deve estar no Wi-Fi ou no aparelho. Desligue o roteador da tomada por 30 segundos e ligue de novo; se continuar, me conte se acontece em todos os aparelhos.", askCpf: false };
  return undefined;
}

export interface TriageMode {
  /** Fora do horário comercial: lista clicável e aviso de quando o atendimento com pessoas volta. */
  offHours?: boolean;
  now?: () => number;
}

/**
 * Como a triagem entra no canal: menu, pergunta do assunto, protocolo na primeira
 * resposta, os passos da segunda via, a resposta pelo diagnóstico e o registro da
 * decisão. Falha ao gravar nunca derruba o atendimento.
 */
export function triageHooks(repository: TicketRepository, ticket: TicketRow, diagnose?: Diagnose, invoice?: InvoiceOptions, mode: TriageMode = {}): TriageHooks {
  const at = () => new Date((mode.now ?? Date.now)());
  const invoiceHooks = invoiceSteps(repository, ticket, invoice);
  // Diagnóstico feito para responder ao cliente não se repete no registro do turno.
  let diagnosedNow = false;
  // O protocolo só conta como informado se esteve no texto — o rodapé pode ter só o aviso de horário.
  let protocolInFooter = false;
  return {
    intercept: invoiceHooks.intercept,
    afterClassify: async (classified, context) => {
      const step = await invoiceHooks.afterClassify?.(classified, context);
      if (step || !context.autoReply) return step;
      if (!DIAGNOSABLE_INTENTS.has(classified.intent)) return undefined;
      const diagnosis = await diagnoseTicket(repository, ticket, classified.intent, diagnose);
      if (!diagnosis) return undefined;
      diagnosedNow = true;
      const canAskCpf = !!invoice && ticket.identification === "identified" && !!ticket.ixcCustomerId;
      const reply = diagnosisReply(diagnosis, canAskCpf);
      if (!reply) return undefined;
      return {
        text: reply.text, status: reply.askCpf ? "waiting_customer" : "replied", intent: classified.intent, label: "Resposta pelo diagnóstico",
        // O cliente bloqueado por atraso já entra no fluxo da segunda via: a resposta dele é o CPF.
        after: async (delivered) => { if (delivered && reply.askCpf) await repository.update(ticket.id, { selfService: { step: "awaiting_cpf", at: at().toISOString(), attempts: 0 } }); },
      };
    },
    menuChoice: (text) => (ticket.stage === "clarifying" ? menuChoice(text) : undefined),
    // Pergunta uma vez por atendimento: se a resposta à pergunta também for vaga,
    // segue o caminho normal (que passa para um atendente) em vez de repetir o menu.
    // Fora do horário vai como lista clicável, já dizendo quando há gente.
    clarification: (classified) => {
      if (!(ticket.stage === "new" && (classified.confidence < CLARIFY_BELOW || classified.intent === "general_information"))) return undefined;
      return mode.offHours ? { text: offHoursMenuText(at()), interactive: TRIAGE_LIST } : { text: CLARIFY_TEXT };
    },
    footer: (context) => {
      const lines: string[] = [];
      if (ticket.protocol && !ticket.protocolSentAt) { lines.push(protocolFooter(ticket.protocol)); protocolInFooter = true; }
      // A abertura fora do horário já diz quando há gente; nas respostas, a promessa "um atendente" ganha data.
      // Resposta que resolve (`handoff: false`) não precisa: ninguém foi prometido.
      if (mode.offHours && !context?.clarifying && context?.handoff !== false) lines.push(offHoursNote(at()));
      return lines.length ? lines.join("\n") : undefined;
    },
    record: async (entry) => {
      await recordTriage(repository, ticket, { ...entry, protocolIncluded: entry.protocolIncluded && protocolInFooter }).catch(() => undefined);
      if (!entry.clarifying && !diagnosedNow) await diagnoseTicket(repository, ticket, entry.intent, diagnose);
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
  input: { channel: string; conversationId: string; lookup: CustomerLookup; diagnose?: Diagnose; invoice?: InvoiceOptions; offHours?: boolean; now?: number },
): Promise<{ ticket: TicketRow; hooks: TriageHooks; knownCustomer: CustomerLookup; awaitingAnswer: boolean; handedOff: boolean } | undefined> {
  try {
    const { ticket: opened } = await openOrContinueTicket(repository, input);
    const ticket = await identifyTicketCustomer(repository, opened, input.lookup);
    return {
      ticket, hooks: triageHooks(repository, ticket, input.diagnose, input.invoice, { offHours: input.offHours, now: input.now === undefined ? undefined : () => input.now as number }), knownCustomer: knownCustomer(ticket),
      // A IA perguntou algo (assunto ou CPF): a resposta do cliente merece resposta.
      awaitingAnswer: ticket.stage === "clarifying" || awaitingCpf(ticket),
      // A IA passou para o atendente neste atendimento: no modo autônomo, ela não volta a falar sozinha.
      handedOff: ticket.stage === "handoff",
    };
  } catch {
    return undefined;
  }
}

export function ticketSummary(row: TicketRow): TicketSummary {
  return {
    protocol: row.protocol, status: row.status, openedAt: row.openedAt, closedAt: row.closedAt, closedReason: row.closedReason,
    identification: row.identification, ixcCustomerId: row.ixcCustomerId, intent: row.intent, intentSource: row.intentSource,
    intentConfidence: row.intentConfidence, queue: row.queue, stage: row.stage, protocolSentAt: row.protocolSentAt,
    diagnosis: row.diagnosis, selfService: row.selfService,
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
  selfService: (row.selfService as InvoiceSelfService | null) ?? null,
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
