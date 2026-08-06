import { randomUUID } from "node:crypto";
import { desc, eq, and, gte } from "drizzle-orm";
import { ixcWriteOperations } from "../../db/schema.ts";
import { isOpenInvoice } from "./billing-service.ts";

/**
 * Escrita no IXC (issue #20 — "a mudança mais delicada do projeto").
 *
 * Este arquivo constrói o arcabouço que a issue pede — catálogo, política,
 * idempotência, auditoria — **sem** habilitar escrita real nenhuma. Duas
 * travas independentes da minha continuam de pé, intocadas:
 *
 * 1. `lib/runtime/environment.ts` recusa a aplicação subir se
 *    `IXC_WRITE_ENABLED=true` — "Escrita no IXC é proibida na Fase 3A".
 * 2. `lib/integrations/ixc/guard.ts` bloqueia por nome de operação; nenhuma
 *    operação de escrita está na lista permitida.
 *
 * Isso reflete uma decisão já registrada no projeto, não inventada agora:
 * docs/pilot/phase-3b-results.md e docs/phase-3b-readiness-report.md fecham
 * com "decisão atual: não avançar para clientes nem para escrita". Esta
 * camada soma uma **terceira** trava (`FEATURE_IXC_WRITE`) e, mesmo que as
 * três fossem abertas, a chamada real ao IXC (`callIxc`) não está
 * implementada — o endpoint de segunda via nunca foi confirmado com o
 * provedor, e inventar uma URL seria arriscar gravar algo errado no ERP de
 * um cliente real.
 */

export const IXC_WRITE_CATALOG = [
  { operation: "invoice.reissue", label: "Gerar segunda via de boleto", implemented: true },
  { operation: "negotiation.register", label: "Registrar promessa/negociação", implemented: false },
  { operation: "service_order.open", label: "Abrir ordem de serviço", implemented: false },
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
  documentUrl?: string;
  paymentCode?: string;
  replay?: boolean;
}

/**
 * `callIxc` é injetado de propósito: a implementação real não existe (ver
 * `unconfirmedIxcInvoiceReissue` abaixo). Testes passam uma versão fake; a
 * rota da API passa a real, que sempre falha alto e claro em vez de adivinhar
 * uma URL do IXC.
 */
export async function requestInvoiceReissue(
  request: ReissueRequest,
  repository: IxcWriteOperationsRepository,
  callIxc: (invoiceId: string, customerId: string, correlationId: string) => Promise<{ documentUrl: string; paymentCode: string }>,
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
    const detail = "FEATURE_IXC_WRITE desligada — Fase 3A não permite escrita real no IXC (ver docs/pilot/phase-3b-results.md)";
    await record("blocked", detail);
    return { status: "blocked", detail };
  }

  try {
    const result = await callIxc(request.invoiceId, request.customerId, request.correlationId);
    await record("success", `Documento gerado: ${result.paymentCode}`);
    return { status: "success", detail: `Documento gerado: ${result.paymentCode}`, ...result };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Falha desconhecida ao gerar segunda via";
    await record("failed", detail);
    return { status: "failed", detail };
  }
}

/**
 * Não é uma integração real — é a lacuna, explícita e visível. O endpoint de
 * segunda via nunca foi confirmado com o provedor do IXC. Mesmo que
 * `FEATURE_IXC_WRITE` fosse ligada (o que já não é possível: `IXC_WRITE_ENABLED`
 * derruba o boot antes disso), esta função ainda recusaria a chamada — inventar
 * uma URL arriscaria gravar algo errado no ERP de um cliente real.
 */
export async function unconfirmedIxcInvoiceReissue(): Promise<never> {
  throw new Error("Endpoint real de segunda via no IXC não confirmado com o provedor (issue #20) — nenhuma chamada foi feita");
}
