import { randomUUID } from "node:crypto";
import { desc, eq, and, gte } from "drizzle-orm";
import { ixcWriteOperations } from "../../db/schema.ts";
import { isOpenInvoice } from "./billing-service.ts";

/**
 * Escrita no IXC (issue #20 — "a mudança mais delicada do projeto").
 *
 * Catálogo, política, idempotência e auditoria para a primeira operação
 * (segunda via de boleto). Ligada por decisão explícita de reavançar a fase
 * "não avançar para clientes nem para escrita" registrada em
 * docs/pilot/phase-3b-results.md — `IXC_WRITE_ENABLED` (trava de boot mais
 * ampla, "Fase 3A") continua intocada e desligada; `FEATURE_IXC_WRITE` é a
 * trava própria e mais estreita desta operação específica.
 *
 * O endpoint real (`POST /webservice/v1/get_boleto`) foi confirmado na
 * coleção Postman "API - IXC Provedor", não inventado — ver
 * lib/integrations/ixc/write-client.ts. O que **não** foi confirmado: o
 * formato exato de uma resposta de sucesso, porque o único cliente da
 * allowlist não tem fatura nenhuma para testar contra uma chamada real. Por
 * isso o resultado guarda a resposta crua (`raw`) em vez de campos
 * específicos inventados — a primeira chamada real, auditada, é quem prova o
 * formato.
 */

export const IXC_WRITE_CATALOG = [
  { operation: "invoice.reissue", label: "Gerar segunda via de boleto", implemented: true },
  { operation: "service_order.open", label: "Abrir ordem de serviço", implemented: true },
  { operation: "negotiation.register", label: "Renegociar dívida", implemented: true },
  { operation: "customer.create", label: "Cadastrar cliente novo", implemented: true },
] as const;

export type IxcWriteStatus = "success" | "blocked" | "failed";

export interface IxcWriteLedgerRow {
  id: string;
  operation: string;
  idempotencyKey: string;
  customerId: string;
  invoiceId: string | null;
  status: IxcWriteStatus;
  requestedBy: string;
  detail: string | null;
  correlationId: string;
  createdAt: string;
}

export class IxcWritePolicyError extends Error {
  constructor(message: string) { super(message); this.name = "IxcWritePolicyError"; }
}

/**
 * Política da segunda via: só fatura em aberto, e não mais que uma vez por
 * 24h — sem isso, um clique duplicado (ou um cliente ansioso insistindo)
 * geraria boleto novo a cada tentativa.
 */
export function assertReissuePolicy(invoice: { status: string }, lastSuccessAt: string | null, now: Date): void {
  if (!isOpenInvoice(invoice.status)) throw new IxcWritePolicyError("Fatura não está aberta — segunda via só se aplica a fatura em aberto");
  if (lastSuccessAt) {
    const hoursSince = (now.getTime() - new Date(lastSuccessAt).getTime()) / 3_600_000;
    if (hoursSince < 24) throw new IxcWritePolicyError("Já foi gerada uma segunda via para esta fatura nas últimas 24 horas");
  }
}

/**
 * Política da abertura de OS.
 *
 * O que ela impede, em ordem de estrago:
 *
 * 1. **Assunto e setor fora do catálogo do IXC.** São validados contra a lista
 *    lida do próprio ERP no momento da chamada, não contra um enum nosso: o
 *    catálogo tem 159 assuntos com ids salteados e muda sem nos avisar. Assunto
 *    inválido abriria chamado que ninguém sabe atender.
 * 2. **Cliente sem filial no cadastro.** A BBNET tem 21 filiais; sem saber a do
 *    cliente, a OS iria para a empresa errada do grupo. Melhor recusar.
 * 3. **Chamado repetido.** Se o cliente já tem OS aberta do mesmo assunto,
 *    abrir outra manda um segundo técnico para o mesmo problema.
 */
export const SERVICE_ORDER_MIN_MESSAGE = 10;

export function assertServiceOrderPolicy(input: {
  subjectId: string;
  sectorId: string;
  branchId: string | undefined;
  message: string;
  knownSubjectIds: Set<string>;
  knownSectorIds: Set<string>;
  openSubjects: Set<string>;
}): void {
  if (!input.knownSubjectIds.has(input.subjectId)) throw new IxcWritePolicyError("Assunto não existe no catálogo do IXC");
  if (!input.knownSectorIds.has(input.sectorId)) throw new IxcWritePolicyError("Setor não existe no catálogo do IXC");
  if (!input.branchId) throw new IxcWritePolicyError("O cadastro do cliente não informa filial — sem ela a OS iria para a empresa errada do grupo");
  // Sem descrição o técnico chega sem saber o que foi relatado, e a OS vira uma
  // visita às cegas. O assunto sozinho não diz o que o cliente falou.
  if (input.message.trim().length < SERVICE_ORDER_MIN_MESSAGE) throw new IxcWritePolicyError("Descreva o problema relatado (mínimo 10 caracteres)");
  if (input.openSubjects.has(input.subjectId)) throw new IxcWritePolicyError("Este cliente já tem ordem de serviço aberta com esse assunto");
}

export interface IxcWriteOperationsRepository {
  findByIdempotencyKey(operation: string, idempotencyKey: string): Promise<IxcWriteLedgerRow | undefined>;
  record(entry: Omit<IxcWriteLedgerRow, "id" | "createdAt">): Promise<IxcWriteLedgerRow>;
  lastSuccessAt(operation: string, invoiceId: string): Promise<string | null>;
  listSince(sinceIso: string): Promise<IxcWriteLedgerRow[]>;
}

export class DbIxcWriteOperationsRepository implements IxcWriteOperationsRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async findByIdempotencyKey(operation: string, idempotencyKey: string): Promise<IxcWriteLedgerRow | undefined> {
    const rows = await this.db.select().from(ixcWriteOperations)
      .where(and(eq(ixcWriteOperations.operation, operation), eq(ixcWriteOperations.idempotencyKey, idempotencyKey)))
      .limit(1);
    return rows[0];
  }

  async record(entry: Omit<IxcWriteLedgerRow, "id" | "createdAt">): Promise<IxcWriteLedgerRow> {
    const now = new Date().toISOString();
    const row = { id: randomUUID(), ...entry, createdAt: now };
    await this.db.insert(ixcWriteOperations).values({ ...row, updatedAt: now });
    return row;
  }

  async lastSuccessAt(operation: string, invoiceId: string): Promise<string | null> {
    const rows = await this.db.select().from(ixcWriteOperations)
      .where(and(eq(ixcWriteOperations.operation, operation), eq(ixcWriteOperations.invoiceId, invoiceId), eq(ixcWriteOperations.status, "success")))
      .orderBy(desc(ixcWriteOperations.createdAt)).limit(1);
    return rows[0]?.createdAt ?? null;
  }

  async listSince(sinceIso: string): Promise<IxcWriteLedgerRow[]> {
    return this.db.select().from(ixcWriteOperations).where(gte(ixcWriteOperations.createdAt, sinceIso)).orderBy(desc(ixcWriteOperations.createdAt));
  }
}

export class MemoryIxcWriteOperationsRepository implements IxcWriteOperationsRepository {
  readonly rows: IxcWriteLedgerRow[] = [];
  async findByIdempotencyKey(operation: string, idempotencyKey: string) {
    return this.rows.find((row) => row.operation === operation && row.idempotencyKey === idempotencyKey);
  }
  async record(entry: Omit<IxcWriteLedgerRow, "id" | "createdAt">) {
    const row: IxcWriteLedgerRow = { id: randomUUID(), createdAt: new Date().toISOString(), ...entry };
    this.rows.push(row);
    return row;
  }
  async lastSuccessAt(operation: string, invoiceId: string) {
    const matches = this.rows.filter((row) => row.operation === operation && row.invoiceId === invoiceId && row.status === "success");
    return matches.length ? matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0].createdAt : null;
  }
  async listSince(sinceIso: string) { return this.rows.filter((row) => row.createdAt >= sinceIso); }
}

export interface ReissueRequest {
  invoiceId: string;
  customerId: string;
  idempotencyKey: string;
  correlationId: string;
  requestedBy: string;
  invoice: { status: string };
}

export interface ReissueResult {
  status: IxcWriteStatus;
  detail: string;
  /** Resposta crua do IXC — os nomes de campo exatos de uma resposta de sucesso ainda não foram confirmados contra um caso real. */
  raw?: Record<string, unknown>;
  replay?: boolean;
}

/**
 * `callIxc` é injetado de propósito: quem chama (a rota da API) monta a
 * função real com a configuração de runtime do IXC; os testes passam uma
 * versão fake. Isso mantém este arquivo livre de detalhe de HTTP — ver
 * `lib/integrations/ixc/write-client.ts` para a implementação real.
 */
export async function requestInvoiceReissue(
  request: ReissueRequest,
  repository: IxcWriteOperationsRepository,
  callIxc: (invoiceId: string, customerId: string, correlationId: string) => Promise<{ raw: Record<string, unknown> }>,
): Promise<ReissueResult> {
  const existing = await repository.findByIdempotencyKey("invoice.reissue", request.idempotencyKey);
  if (existing) return { status: existing.status, detail: existing.detail ?? "", replay: true };

  const record = (status: IxcWriteStatus, detail: string) => repository.record({
    operation: "invoice.reissue", idempotencyKey: request.idempotencyKey, customerId: request.customerId,
    invoiceId: request.invoiceId, status, requestedBy: request.requestedBy, detail, correlationId: request.correlationId,
  });

  try {
    const lastSuccessAt = await repository.lastSuccessAt("invoice.reissue", request.invoiceId);
    assertReissuePolicy(request.invoice, lastSuccessAt, new Date());
  } catch (error) {
    const detail = error instanceof IxcWritePolicyError ? error.message : "Política recusou a operação";
    await record("blocked", detail);
    return { status: "blocked", detail };
  }

  if (process.env.FEATURE_IXC_WRITE !== "true") {
    const detail = "FEATURE_IXC_WRITE desligada — escrita real no IXC não está ligada";
    await record("blocked", detail);
    return { status: "blocked", detail };
  }

  try {
    const result = await callIxc(request.invoiceId, request.customerId, request.correlationId);
    // Guarda a resposta crua no ledger: é o material que confirma (ou não) o
    // formato de sucesso da primeira chamada real, para revisão humana.
    const detail = `Boleto retornado pelo IXC: ${JSON.stringify(result.raw).slice(0, 500)}`;
    await record("success", detail);
    return { status: "success", detail, raw: result.raw };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Falha desconhecida ao gerar segunda via";
    await record("failed", detail);
    return { status: "failed", detail };
  }
}

/**
 * Política da renegociação de dívida — a operação mais perigosa do catálogo.
 *
 * Ela consolida faturas reais, recalcula juro e multa e cria parcelas novas.
 * Errar aqui não gera um chamado a mais: gera cobrança errada.
 *
 * A trava que menos se parece com uma trava é a do **valor conferido**: quem
 * dispara precisa mandar de volta o total que viu na tela, e ele tem que bater
 * com o que o servidor somou a partir do IXC. Isso prova que a pessoa e o
 * sistema estão olhando o mesmo número — um clique num botão que carregou dado
 * velho não renegocia nada.
 */
export const RENEGOTIATION_TOTAL_TOLERANCE = 0.01;

export function assertRenegotiationPolicy(input: {
  invoiceIds: string[];
  eligibleIds: Set<string>;
  originalTotal: number;
  expectedTotal: number;
  walletId: string;
  paymentTermId: string;
  knownWalletIds: Set<string>;
  knownPaymentTermIds: Set<string>;
  branchId: string | undefined;
  accountId: string | undefined;
  contractId: string | undefined;
}): void {
  if (input.invoiceIds.length === 0) throw new IxcWritePolicyError("Escolha pelo menos uma fatura para renegociar");
  // Fatura que não é do cliente, ou que já foi paga, não entra: renegociar uma
  // fatura paga recria a dívida de quem já pagou.
  const foreign = input.invoiceIds.filter((id) => !input.eligibleIds.has(id));
  if (foreign.length > 0) throw new IxcWritePolicyError(`Fatura(s) fora do que pode ser renegociado neste cadastro: ${foreign.join(", ")}`);
  if (!input.knownWalletIds.has(input.walletId)) throw new IxcWritePolicyError("Carteira de cobrança não existe no catálogo do IXC");
  if (!input.knownPaymentTermIds.has(input.paymentTermId)) throw new IxcWritePolicyError("Condição de pagamento não existe no catálogo do IXC");
  if (!input.branchId) throw new IxcWritePolicyError("O cadastro do cliente não informa filial");
  if (!input.accountId) throw new IxcWritePolicyError("O cadastro do cliente não informa conta (id_conta), exigida pelo wizard");
  if (!input.contractId) throw new IxcWritePolicyError("O cliente não tem contrato para vincular à renegociação");
  if (!(input.originalTotal > 0)) throw new IxcWritePolicyError("As faturas escolhidas somam zero — não há dívida a renegociar");
  if (Math.abs(input.originalTotal - input.expectedTotal) > RENEGOTIATION_TOTAL_TOLERANCE) {
    throw new IxcWritePolicyError(`O total conferido (${input.expectedTotal.toFixed(2)}) não bate com o que o IXC devolve agora (${input.originalTotal.toFixed(2)}). Recarregue e confira antes de renegociar`);
  }
}

export interface ServiceOrderRequest {
  customerId: string;
  subjectId: string;
  sectorId: string;
  branchId: string | undefined;
  priority: string;
  message: string;
  idempotencyKey: string;
  correlationId: string;
  requestedBy: string;
  knownSubjectIds: Set<string>;
  knownSectorIds: Set<string>;
  /** Assuntos das OS ainda abertas deste cliente, lidos do IXC agora. */
  openSubjects: Set<string>;
}

/**
 * Abre ordem de serviço no IXC, seguindo a mesma régua da segunda via:
 * idempotência primeiro, política depois, flag por último, e tudo no ledger —
 * inclusive o que foi bloqueado. Auditoria existe para provar decisão, não só
 * sucesso.
 */
export async function requestServiceOrderOpen(
  request: ServiceOrderRequest,
  repository: IxcWriteOperationsRepository,
  callIxc: (correlationId: string) => Promise<{ raw: Record<string, unknown> }>,
): Promise<ReissueResult> {
  const existing = await repository.findByIdempotencyKey("service_order.open", request.idempotencyKey);
  if (existing) return { status: existing.status, detail: existing.detail ?? "", replay: true };

  const record = (status: IxcWriteStatus, detail: string) => repository.record({
    operation: "service_order.open", idempotencyKey: request.idempotencyKey, customerId: request.customerId,
    // A OS não tem fatura; o ledger guarda o assunto no lugar, que é o que
    // identifica de que chamado se trata quando alguém for auditar.
    invoiceId: `assunto:${request.subjectId}`, status, requestedBy: request.requestedBy, detail, correlationId: request.correlationId,
  });

  try {
    assertServiceOrderPolicy(request);
  } catch (error) {
    const detail = error instanceof IxcWritePolicyError ? error.message : "Política recusou a operação";
    await record("blocked", detail);
    return { status: "blocked", detail };
  }

  if (process.env.FEATURE_IXC_WRITE !== "true") {
    const detail = "FEATURE_IXC_WRITE desligada — escrita real no IXC não está ligada";
    await record("blocked", detail);
    return { status: "blocked", detail };
  }

  try {
    const result = await callIxc(request.correlationId);
    const detail = `OS retornada pelo IXC: ${JSON.stringify(result.raw).slice(0, 500)}`;
    await record("success", detail);
    return { status: "success", detail, raw: result.raw };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Falha desconhecida ao abrir ordem de serviço";
    await record("failed", detail);
    return { status: "failed", detail };
  }
}

/**
 * Política do cadastro de cliente novo.
 *
 * O estrago aqui é diferente dos outros: não é uma ação errada, é um **registro
 * permanente errado**. Cliente duplicado no ERP vira dois fluxos de fatura e um
 * contrato órfão que ninguém sabe qual é o bom, e apagar cadastro com contrato
 * pendurado não é opção.
 *
 * Por isso a checagem de duplicata é feita contra o IXC no momento da chamada, e
 * o resultado dela é passado aqui já resolvido — a política não adivinha.
 */
export function assertCustomerCreatePolicy(input: {
  documentValid: boolean;
  existingCustomerId: string | undefined;
  leadStage: string | undefined;
  leadAlreadyLinked: string | null | undefined;
  cityId: string;
  knownCityIds: Set<string>;
  street: string;
  number: string;
  cep: string;
}): void {
  // Documento inválido cria alguém que nunca vai faturar direito: boleto
  // recusado pelo banco, nota fiscal que não sai.
  if (!input.documentValid) throw new IxcWritePolicyError("CPF/CNPJ inválido — confira os dígitos antes de cadastrar");
  if (input.existingCustomerId) throw new IxcWritePolicyError(`Já existe cadastro no IXC com este documento (cliente ${input.existingCustomerId})`);
  // Cadastrar quem ainda está negociando põe no ERP alguém que não comprou.
  if (input.leadStage !== "ganho") throw new IxcWritePolicyError("Só lead ganho vira cadastro — mova para “Ganho” quando a venda fechar");
  if (input.leadAlreadyLinked) throw new IxcWritePolicyError(`Este lead já virou o cadastro ${input.leadAlreadyLinked} no IXC`);
  if (!input.knownCityIds.has(input.cityId)) throw new IxcWritePolicyError("Cidade não existe no catálogo do IXC");
  if (input.street.trim().length < 3 || !input.number.trim()) throw new IxcWritePolicyError("Endereço e número são obrigatórios — sem eles o técnico não tem onde instalar");
  if (input.cep.replace(/\D/g, "").length !== 8) throw new IxcWritePolicyError("CEP precisa ter 8 dígitos");
}

export interface CustomerCreateServiceRequest {
  leadId: string;
  idempotencyKey: string;
  correlationId: string;
  requestedBy: string;
  policy: Parameters<typeof assertCustomerCreatePolicy>[0];
}

/**
 * Cadastra cliente no IXC. Mesma régua das outras escritas.
 *
 * Diferente da renegociação, aqui uma chamada só resolve — não há estado
 * intermediário para deixar pela metade. O que a idempotência protege é o clique
 * repetido: dois cadastros do mesmo cliente é o estrago principal.
 */
export async function requestCustomerCreate(
  request: CustomerCreateServiceRequest,
  repository: IxcWriteOperationsRepository,
  callIxc: (correlationId: string) => Promise<{ raw: Record<string, unknown>; customerId: string }>,
  onCreated?: (customerId: string) => Promise<unknown>,
): Promise<ReissueResult> {
  const existing = await repository.findByIdempotencyKey("customer.create", request.idempotencyKey);
  if (existing) return { status: existing.status, detail: existing.detail ?? "", replay: true };

  const record = (status: IxcWriteStatus, detail: string, customerId = "") => repository.record({
    operation: "customer.create", idempotencyKey: request.idempotencyKey,
    customerId: customerId || "novo", invoiceId: `lead:${request.leadId}`,
    status, requestedBy: request.requestedBy, detail, correlationId: request.correlationId,
  });

  try {
    assertCustomerCreatePolicy(request.policy);
  } catch (error) {
    const detail = error instanceof IxcWritePolicyError ? error.message : "Política recusou a operação";
    await record("blocked", detail);
    return { status: "blocked", detail };
  }

  if (process.env.FEATURE_IXC_WRITE !== "true") {
    const detail = "FEATURE_IXC_WRITE desligada — escrita real no IXC não está ligada";
    await record("blocked", detail);
    return { status: "blocked", detail };
  }

  try {
    const result = await callIxc(request.correlationId);
    // Guardar o vínculo é o que impede o segundo cadastro do mesmo lead depois.
    // Falhar aqui não desfaz o cadastro — por isso o detalhe diz o id, sempre.
    let linkNote = "";
    if (onCreated) {
      try { await onCreated(result.customerId); }
      catch { linkNote = " ⚠️ O cadastro foi criado, mas o vínculo com o lead não foi gravado — anote o número antes de tentar de novo."; }
    }
    const detail = `Cliente ${result.customerId} cadastrado no IXC.${linkNote} Resposta: ${JSON.stringify(result.raw).slice(0, 300)}`;
    await record("success", detail, result.customerId);
    return { status: "success", detail, raw: result.raw };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Falha desconhecida ao cadastrar cliente";
    await record("failed", detail);
    return { status: "failed", detail };
  }
}

export interface RenegotiationServiceRequest {
  customerId: string;
  invoiceIds: string[];
  idempotencyKey: string;
  correlationId: string;
  requestedBy: string;
  policy: Parameters<typeof assertRenegotiationPolicy>[0];
}

export interface RenegotiationCallResult { raw: Record<string, unknown>; renegotiationId: string; surcharge: string; dueDate: string }

/**
 * Renegocia dívida no IXC.
 *
 * Difere das outras escritas num ponto que muda tudo: **o passo 1 já grava no
 * ERP**. Quando algo falha depois dele, não existe "nada aconteceu" — existe uma
 * renegociação pela metade nas faturas do cliente. O ledger por isso registra o
 * `id_renegociacao` e o passo alcançado, para alguém achar e resolver na mão. Um
 * `failed` sem essas duas informações seria pior que inútil: esconderia um
 * rastro que ficou no ERP.
 */
export async function requestRenegotiation(
  request: RenegotiationServiceRequest,
  repository: IxcWriteOperationsRepository,
  callIxc: (
    correlationId: string,
    onProgress: (progress: { step: number; renegotiationId?: string; note: string }) => void,
  ) => Promise<RenegotiationCallResult>,
): Promise<ReissueResult> {
  const existing = await repository.findByIdempotencyKey("negotiation.register", request.idempotencyKey);
  if (existing) return { status: existing.status, detail: existing.detail ?? "", replay: true };

  let progress: { step: number; renegotiationId?: string; note: string } = { step: 0, note: "nada enviado ao IXC" };
  const record = (status: IxcWriteStatus, detail: string) => repository.record({
    operation: "negotiation.register", idempotencyKey: request.idempotencyKey, customerId: request.customerId,
    // Enquanto não há renegociação, o ledger guarda as faturas envolvidas; assim
    // que o IXC devolve o id, é ele que identifica o que ficou lá.
    invoiceId: progress.renegotiationId ? `renegociacao:${progress.renegotiationId}` : `faturas:${request.invoiceIds.join(",")}`.slice(0, 200),
    status, requestedBy: request.requestedBy, detail, correlationId: request.correlationId,
  });

  try {
    assertRenegotiationPolicy(request.policy);
  } catch (error) {
    const detail = error instanceof IxcWritePolicyError ? error.message : "Política recusou a operação";
    await record("blocked", detail);
    return { status: "blocked", detail };
  }

  if (process.env.FEATURE_IXC_WRITE !== "true") {
    const detail = "FEATURE_IXC_WRITE desligada — escrita real no IXC não está ligada";
    await record("blocked", detail);
    return { status: "blocked", detail };
  }

  try {
    const result = await callIxc(request.correlationId, (update) => { progress = update; });
    progress = { ...progress, renegotiationId: result.renegotiationId };
    const detail = `Renegociação ${result.renegotiationId} concluída no IXC. Acréscimo ${result.surcharge}, vencimento ${result.dueDate || "não informado"}. Resposta: ${JSON.stringify(result.raw).slice(0, 300)}`;
    await record("success", detail);
    return { status: "success", detail, raw: result.raw };
  } catch (error) {
    const cause = error instanceof Error ? error.message : "Falha desconhecida";
    const detail = progress.renegotiationId
      ? `PENDENTE DE CONFERÊNCIA MANUAL — a renegociação ${progress.renegotiationId} foi criada no IXC e a sequência parou no passo ${progress.step} (${progress.note}). Causa: ${cause}. Verifique no IXC antes de tentar de novo.`
      : `Falhou antes de gravar qualquer coisa no IXC (passo ${progress.step}). Causa: ${cause}`;
    await record("failed", detail);
    return { status: "failed", detail };
  }
}
