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
  { operation: "negotiation.register", label: "Registrar promessa/negociação", implemented: false },
  { operation: "customer.create", label: "Cadastrar cliente novo", implemented: false },
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
