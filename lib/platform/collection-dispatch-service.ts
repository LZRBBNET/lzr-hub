import { randomUUID } from "node:crypto";
import { desc, gte } from "drizzle-orm";
import { collectionDispatches } from "../../db/schema.ts";
import { executeQueueAction } from "./queue-service.ts";
import { businessToday, isOpenInvoice } from "./billing-service.ts";
import type { CollectionRuleRow } from "./collection-rules-shared.ts";

/**
 * Disparo real da régua de cobrança (issue #15).
 *
 * "Real" tem um limite honesto: o HUB hoje só reage a mensagem do cliente,
 * nunca inicia uma — não existe ponte de saída para WhatsApp. O que esta
 * camada faz de verdade é a parte que não depende dessa ponte: decidir **quem
 * recebe contato hoje**, a partir de fatura de verdade, revalidando pagamento
 * e sem duplicar. O envio em si é enfileirado em `billing-reminders` (fica
 * registrado mesmo com a fila desligada, no mesmo espírito do modo observação
 * do canal de entrada) — quando existir worker que de fato manda WhatsApp,
 * ele consome dessa fila sem esta camada precisar mudar.
 */

export type DispatchStatus = "queued";

export interface DispatchInvoiceInput {
  id: string;
  customerId: string;
  status: string;
  dueAt?: string;
  value?: number;
}

export interface DispatchCandidate {
  invoiceId: string;
  customerId: string;
  ruleId: string;
  stepId: string;
  channel: string;
  templateId: string;
  offsetDays: number;
  scheduledFor: string;
}

export interface DispatchLedgerRow {
  id: string;
  invoiceId: string;
  customerId: string;
  ruleId: string;
  stepId: string;
  scheduledFor: string;
  status: DispatchStatus;
  channel: string;
  correlationId: string;
  createdAt: string;
}

/**
 * Horário comercial de disparo, fuso de Brasília. Ninguém gosta de cobrança às
 * 6h — a régua pode calcular a lista a qualquer hora, mas só enfileira dentro
 * da janela.
 */
const SAO_PAULO_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hourCycle: "h23", hour: "2-digit", weekday: "short" });
export function isBusinessHour(now: Date): boolean {
  const parts = SAO_PAULO_CLOCK.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const isWeekday = weekday !== "Sat" && weekday !== "Sun";
  return isWeekday && hour >= 8 && hour < 20;
}

function addDays(dateStr: string, days: number): string {
  const base = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * Quem a régua contataria hoje, revalidando pagamento na hora: fatura que já
 * saiu de "aberta" (`isOpenInvoice`) nunca entra, mesmo que tenha entrado
 * ontem. Função pura — não toca fila nem banco, por isso é fácil provar com
 * teste que a data certa gera a lista certa.
 */
export function resolveTodayCandidates(rule: CollectionRuleRow, invoices: DispatchInvoiceInput[], now: Date): DispatchCandidate[] {
  const today = businessToday(now);
  const candidates: DispatchCandidate[] = [];
  for (const step of rule.steps) {
    if (!step.active) continue;
    for (const invoice of invoices) {
      if (!invoice.dueAt || !isOpenInvoice(invoice.status)) continue;
      if (addDays(invoice.dueAt, step.offsetDays) !== today) continue;
      candidates.push({
        invoiceId: invoice.id, customerId: invoice.customerId, ruleId: rule.id, stepId: step.id,
        channel: step.channel, templateId: step.templateId, offsetDays: step.offsetDays, scheduledFor: today,
      });
    }
  }
  return candidates;
}

export interface CollectionDispatchRepository {
  /** Grava cada candidato; a unicidade decide duplicata, não uma checagem antes. */
  record(entries: Array<DispatchCandidate & { correlationId: string }>): Promise<{ inserted: DispatchCandidate[]; duplicates: number }>;
  listSince(sinceIso: string): Promise<DispatchLedgerRow[]>;
}

export class DbCollectionDispatchRepository implements CollectionDispatchRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async record(entries: Array<DispatchCandidate & { correlationId: string }>) {
    const inserted: DispatchCandidate[] = [];
    let duplicates = 0;
    for (const entry of entries) {
      const now = new Date().toISOString();
      const result = await this.db.insert(collectionDispatches).values({
        id: randomUUID(), invoiceId: entry.invoiceId, customerId: entry.customerId, ruleId: entry.ruleId,
        stepId: entry.stepId, scheduledFor: entry.scheduledFor, status: "queued", channel: entry.channel,
        correlationId: entry.correlationId, createdAt: now, updatedAt: now,
      }).onConflictDoNothing().returning({ id: collectionDispatches.id });
      if (result.length > 0) inserted.push(entry); else duplicates += 1;
    }
    return { inserted, duplicates };
  }

  async listSince(sinceIso: string): Promise<DispatchLedgerRow[]> {
    return this.db.select().from(collectionDispatches).where(gte(collectionDispatches.createdAt, sinceIso)).orderBy(desc(collectionDispatches.createdAt));
  }
}

export class MemoryCollectionDispatchRepository implements CollectionDispatchRepository {
  readonly rows: DispatchLedgerRow[] = [];
  async record(entries: Array<DispatchCandidate & { correlationId: string }>) {
    const inserted: DispatchCandidate[] = [];
    let duplicates = 0;
    for (const entry of entries) {
      const exists = this.rows.some((row) => row.invoiceId === entry.invoiceId && row.stepId === entry.stepId && row.scheduledFor === entry.scheduledFor);
      if (exists) { duplicates += 1; continue; }
      this.rows.push({ id: randomUUID(), status: "queued", createdAt: new Date().toISOString(), ...entry });
      inserted.push(entry);
    }
    return { inserted, duplicates };
  }
  async listSince(sinceIso: string) { return this.rows.filter((row) => row.createdAt >= sinceIso); }
}

export interface DispatchRunResult {
  scheduledFor: string;
  businessHour: boolean;
  candidates: number;
  recorded: number;
  duplicates: number;
  enqueued: number;
  queueEnabled: boolean;
}

/**
 * Fora do horário comercial não grava nada: calcular de novo daqui a uma hora
 * dá exatamente a mesma lista, então não há motivo para tocar o ledger antes
 * da hora de enfileirar de verdade.
 */
export async function runTodayDispatch(
  rule: CollectionRuleRow,
  invoices: DispatchInvoiceInput[],
  repository: CollectionDispatchRepository,
  now: Date,
  correlationId: string,
): Promise<DispatchRunResult> {
  const scheduledFor = businessToday(now);
  const candidates = resolveTodayCandidates(rule, invoices, now);

  if (!isBusinessHour(now)) {
    return { scheduledFor, businessHour: false, candidates: candidates.length, recorded: 0, duplicates: 0, enqueued: 0, queueEnabled: false };
  }

  const { inserted, duplicates } = await repository.record(candidates.map((candidate) => ({ ...candidate, correlationId })));

  let enqueued = 0, queueEnabled = false;
  for (const candidate of inserted) {
    try {
      await executeQueueAction({
        action: "enqueue",
        job: {
          queue: "billing-reminders",
          name: `collection-step:${candidate.stepId}`,
          idempotencyKey: `${candidate.invoiceId}:${candidate.stepId}:${candidate.scheduledFor}`,
          correlationId,
          payload: { invoiceId: candidate.invoiceId, customerId: candidate.customerId, channel: candidate.channel, templateId: candidate.templateId },
        },
      });
      enqueued += 1; queueEnabled = true;
    } catch {
      // Fila desligada ou indisponível: o registro no ledger já prova que a
      // régua decidiu contatar essa fatura hoje. Falha na fila não é erro do
      // disparo — é exatamente o modo observação, só que para saída.
    }
  }

  return { scheduledFor, businessHour: true, candidates: candidates.length, recorded: inserted.length, duplicates, enqueued, queueEnabled };
}
