import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { massNoticeDispatches } from "../../db/schema.ts";
import { executeQueueAction } from "./queue-service.ts";
import type { IncidentSeverity } from "./incidents-service.ts";

/**
 * Aviso em massa por massiva (issue #13), no mesmo limite honesto do disparo
 * da régua de cobrança: o HUB não tem ponte de saída para WhatsApp, então
 * "disparo real" aqui é decidir **quem** é avisado, sem duplicar, e registrar
 * essa decisão numa fila que um worker futuro consumiria.
 *
 * Um pedaço do que a issue pede fica fora, e não é para fingir que está
 * pronto: item 3 ("cliente que liga durante a massiva recebe resposta
 * contextualizada") depende de saber **qual cliente** está ligando a partir do
 * telefone do WhatsApp — e essa associação telefone↔cadastro é uma limitação
 * já registrada no projeto (ver CLAUDE.md, "Limites conhecidos"), não algo
 * para resolver escondido dentro desta issue. Inventar um casamento de
 * telefone aqui poderia identificar o cliente errado no meio de um
 * atendimento real — o tipo de erro que este projeto existe para evitar.
 */

export type NoticeKind = "opened" | "closed";
export const NOTICE_KINDS: NoticeKind[] = ["opened", "closed"];

export interface AffectedCustomer { customerId: string; city: string; neighborhood: string }

export interface NoticeLedgerRow {
  id: string;
  incidentId: string;
  customerId: string;
  kind: NoticeKind;
  status: "queued";
  correlationId: string;
  createdAt: string;
}

/**
 * Compara área da massiva com a área do cliente, sem inventar geografia:
 * cidade e bairro precisam bater depois de normalizar (minúsculo, sem acento,
 * sem espaço nas pontas). String vazia de um lado nunca "bate" com nada — bug
 * de cadastro não deve virar match falso.
 */
const normalize = (value: string) => value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
export function matchesArea(incident: { city: string; neighborhood: string }, customer: { city: string; neighborhood: string }): boolean {
  if (!customer.city || !customer.neighborhood) return false;
  return normalize(incident.city) === normalize(customer.city) && normalize(incident.neighborhood) === normalize(customer.neighborhood);
}

export function resolveAffectedCustomers(incident: { city: string; neighborhood: string }, customers: AffectedCustomer[]): string[] {
  return customers.filter((customer) => matchesArea(incident, customer)).map((customer) => customer.customerId);
}

export interface MassNoticeRepository {
  record(entries: Array<{ incidentId: string; customerId: string; kind: NoticeKind; correlationId: string }>): Promise<{ inserted: number; duplicates: number }>;
  listByIncident(incidentId: string): Promise<NoticeLedgerRow[]>;
}

export class DbMassNoticeRepository implements MassNoticeRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async record(entries: Array<{ incidentId: string; customerId: string; kind: NoticeKind; correlationId: string }>) {
    let inserted = 0, duplicates = 0;
    for (const entry of entries) {
      const now = new Date().toISOString();
      const result = await this.db.insert(massNoticeDispatches).values({
        id: randomUUID(), incidentId: entry.incidentId, customerId: entry.customerId, kind: entry.kind,
        status: "queued", correlationId: entry.correlationId, createdAt: now, updatedAt: now,
      }).onConflictDoNothing().returning({ id: massNoticeDispatches.id });
      if (result.length > 0) inserted += 1; else duplicates += 1;
    }
    return { inserted, duplicates };
  }

  async listByIncident(incidentId: string): Promise<NoticeLedgerRow[]> {
    return this.db.select().from(massNoticeDispatches).where(eq(massNoticeDispatches.incidentId, incidentId)).orderBy(desc(massNoticeDispatches.createdAt));
  }
}

export class MemoryMassNoticeRepository implements MassNoticeRepository {
  readonly rows: NoticeLedgerRow[] = [];
  async record(entries: Array<{ incidentId: string; customerId: string; kind: NoticeKind; correlationId: string }>) {
    let inserted = 0, duplicates = 0;
    for (const entry of entries) {
      const exists = this.rows.some((row) => row.incidentId === entry.incidentId && row.customerId === entry.customerId && row.kind === entry.kind);
      if (exists) { duplicates += 1; continue; }
      this.rows.push({ id: randomUUID(), status: "queued", createdAt: new Date().toISOString(), ...entry });
      inserted += 1;
    }
    return { inserted, duplicates };
  }
  async listByIncident(incidentId: string) { return this.rows.filter((row) => row.incidentId === incidentId); }
}

/** Teto por chamada: pacing do envio fica para o worker, mas nada aqui enfileira mais que isto numa rodada. */
export const MAX_NOTICES_PER_RUN = 200;

export interface NoticeRunResult {
  kind: NoticeKind;
  matched: number;
  recorded: number;
  duplicates: number;
  enqueued: number;
  queueEnabled: boolean;
  capped: boolean;
}

export async function runNoticeDispatch(
  incident: { id: string; city: string; neighborhood: string; severity: IncidentSeverity },
  kind: NoticeKind,
  customers: AffectedCustomer[],
  repository: MassNoticeRepository,
  correlationId: string,
): Promise<NoticeRunResult> {
  const matched = resolveAffectedCustomers(incident, customers);
  const batch = matched.slice(0, MAX_NOTICES_PER_RUN);

  const { inserted, duplicates } = await repository.record(batch.map((customerId) => ({ incidentId: incident.id, customerId, kind, correlationId })));

  let enqueued = 0, queueEnabled = false;
  for (const customerId of batch) {
    try {
      await executeQueueAction({
        action: "enqueue",
        job: {
          queue: "mass-campaigns",
          name: `mass-notice:${kind}`,
          idempotencyKey: `${incident.id}:${customerId}:${kind}`,
          correlationId,
          payload: { incidentId: incident.id, customerId, kind, severity: incident.severity },
        },
      });
      enqueued += 1; queueEnabled = true;
    } catch {
      // Fila desligada: o registro no ledger já prova a decisão de avisar.
    }
  }

  return { kind, matched: matched.length, recorded: inserted, duplicates, enqueued, queueEnabled, capped: matched.length > MAX_NOTICES_PER_RUN };
}
