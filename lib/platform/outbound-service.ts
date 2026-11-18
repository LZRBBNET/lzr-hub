import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { outboundMessages, whatsappOptOuts } from "../../db/schema.ts";
import type { IxcCustomerContactDto, IxcDueInvoiceDto } from "../integrations/ixc/types.ts";
import type { SendResult } from "../integrations/meta/cloud-client.ts";
import type { NetworkIncidentRow } from "./incidents-service.ts";
import {
  BILLING_STAGES, TEMPLATES, TEMPLATE_LANGUAGE, brasiliaDate, canonicalPhone, firstName, formatDay, formatMoney, sendingHours, whatsappNumber,
  type TemplateKey,
} from "./outbound-shared.ts";

/**
 * Cobrança e avisos de rede que a BBNET manda primeiro, pelo WhatsApp (modelos aprovados).
 *
 * Quem dispara é o agendamento (`.github/workflows/outbound.yml` → `/api/jobs/outbound`): o app
 * não tem relógio. Cada rodada é limitada (`maxSends`) — a Meta tem limite diário de conversas
 * iniciadas pela empresa e cobra por mensagem — e retoma de onde parou: a reserva no ledger
 * (`outbound_messages`, índice único por aviso + referência + cliente) é o que impede mandar a
 * mesma cobrança duas vezes. A reserva vem **antes** do envio; envio que falhou fica marcado e
 * não é refeito sozinho.
 *
 * Do IXC só se lê o necessário, em lote: as faturas do dia numa consulta por página, e o
 * contato de até 200 clientes por consulta (`IN`) — a cota é de 30 consultas por minuto
 * para o processo inteiro, e o atendimento tem prioridade.
 */

export type OutboundStatus = "pending" | "sent" | "failed" | "skipped";

export interface OutboundEntry { kind: string; refId: string; customerId: string; phone: string; template: string }

export interface OutboundRepository {
  /** `false` = já existe (este aviso já saiu ou foi tentado para este cliente e referência). */
  reserve(entry: OutboundEntry): Promise<boolean>;
  finish(entry: Pick<OutboundEntry, "kind" | "refId" | "customerId">, status: OutboundStatus, externalMessageId: string | null, detail: string | null): Promise<void>;
  /** Clientes que já receberam este aviso desta referência — a normalização vai só para eles. */
  recipients(kind: string, refId: string): Promise<Array<{ customerId: string; phone: string }>>;
  sentSince(isoDate: string): Promise<number>;
  isOptedOut(phone: string): Promise<boolean>;
  setOptOut(phone: string, out: boolean, source: string): Promise<void>;
}

export class DbOutboundRepository implements OutboundRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }
  async reserve(entry: OutboundEntry) {
    const now = new Date().toISOString();
    const rows = await this.db.insert(outboundMessages).values({ id: randomUUID(), ...entry, status: "pending", externalMessageId: null, detail: null, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [outboundMessages.kind, outboundMessages.refId, outboundMessages.customerId] }).returning({ id: outboundMessages.id });
    return rows.length === 1;
  }
  async finish(entry: Pick<OutboundEntry, "kind" | "refId" | "customerId">, status: OutboundStatus, externalMessageId: string | null, detail: string | null) {
    await this.db.update(outboundMessages).set({ status, externalMessageId, detail, updatedAt: new Date().toISOString() })
      .where(and(eq(outboundMessages.kind, entry.kind), eq(outboundMessages.refId, entry.refId), eq(outboundMessages.customerId, entry.customerId)));
  }
  async recipients(kind: string, refId: string) {
    return this.db.select({ customerId: outboundMessages.customerId, phone: outboundMessages.phone }).from(outboundMessages)
      .where(and(eq(outboundMessages.kind, kind), eq(outboundMessages.refId, refId), eq(outboundMessages.status, "sent")));
  }
  async sentSince(isoDate: string) {
    const rows = await this.db.select({ total: sql<number>`count(*)` }).from(outboundMessages)
      .where(and(eq(outboundMessages.status, "sent"), gte(outboundMessages.createdAt, isoDate)));
    return Number(rows[0]?.total ?? 0);
  }
  async isOptedOut(phone: string) {
    const rows = await this.db.select({ phone: whatsappOptOuts.phone }).from(whatsappOptOuts).where(eq(whatsappOptOuts.phone, phone)).limit(1);
    return rows.length > 0;
  }
  async setOptOut(phone: string, out: boolean, source: string) {
    if (!out) { await this.db.delete(whatsappOptOuts).where(eq(whatsappOptOuts.phone, phone)); return; }
    const now = new Date().toISOString();
    await this.db.insert(whatsappOptOuts).values({ phone, source, createdAt: now, updatedAt: now }).onConflictDoNothing();
  }
}

export class MemoryOutboundRepository implements OutboundRepository {
  readonly rows: Array<OutboundEntry & { status: OutboundStatus; externalMessageId: string | null; detail: string | null; createdAt: string }> = [];
  readonly optOuts = new Set<string>();
  async reserve(entry: OutboundEntry) {
    if (this.rows.some((row) => row.kind === entry.kind && row.refId === entry.refId && row.customerId === entry.customerId)) return false;
    this.rows.push({ ...entry, status: "pending", externalMessageId: null, detail: null, createdAt: new Date().toISOString() });
    return true;
  }
  async finish(entry: Pick<OutboundEntry, "kind" | "refId" | "customerId">, status: OutboundStatus, externalMessageId: string | null, detail: string | null) {
    const row = this.rows.find((item) => item.kind === entry.kind && item.refId === entry.refId && item.customerId === entry.customerId);
    if (row) Object.assign(row, { status, externalMessageId, detail });
  }
  async recipients(kind: string, refId: string) { return this.rows.filter((row) => row.kind === kind && row.refId === refId && row.status === "sent").map(({ customerId, phone }) => ({ customerId, phone })); }
  async sentSince(isoDate: string) { return this.rows.filter((row) => row.status === "sent" && row.createdAt >= isoDate).length; }
  async isOptedOut(phone: string) { return this.optOuts.has(phone); }
  async setOptOut(phone: string, out: boolean) { if (out) this.optOuts.add(phone); else this.optOuts.delete(phone); }
}

export type TemplateSender = (input: { to: string; name: string; language: string; bodyParams: string[] }) => Promise<SendResult>;

export interface OutboundProvider {
  listOpenInvoicesDue(date: string, page: number, pageSize: number, correlationId: string): Promise<{ items: IxcDueInvoiceDto[]; total: number }>;
  listCustomerContacts(ids: string[], correlationId: string): Promise<IxcCustomerContactDto[]>;
  listCustomersInNeighborhood(neighborhood: string, page: number, pageSize: number, correlationId: string): Promise<{ items: IxcCustomerContactDto[]; total: number }>;
}

export interface OutboundRunOptions {
  provider: OutboundProvider;
  repository: OutboundRepository;
  send: TemplateSender;
  /** Com `dryRun`, conta e monta as mensagens sem reservar nem enviar nada. */
  dryRun: boolean;
  /** Teto desta rodada; o resto fica para a próxima. */
  maxSends: number;
  /** Teto do dia, contando o que já saiu hoje (limite de conversas da Meta). */
  dailyCap: number;
  correlationId: string;
  now?: () => Date;
}

export interface OutboundReport {
  job: string;
  dryRun: boolean;
  /** Por aviso: quantos caberiam hoje, quantos saíram, por que o resto não saiu. Só contagens — nada de dado de cliente (fica no log do Actions). */
  stages: Record<string, { candidates: number; sent: number; skipped: Record<string, number> }>;
  sent: number;
  stoppedBy?: "max_per_run" | "daily_cap" | "meta_limit" | "outside_hours";
}

const bump = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };
/** A Meta disse que o limite acabou: parar a rodada inteira, não insistir mensagem por mensagem. */
const metaStop = (result: SendResult) => !result.ok && (result.kind === "rate_limited" || result.metaCode === 131048 || result.metaCode === 131049);

interface Delivery { kind: string; refId: string; contact: IxcCustomerContactDto; template: TemplateKey; params: string[] }

async function deliverAll(options: OutboundRunOptions, report: OutboundReport, stage: string, deliveries: Delivery[], budget: { left: number }): Promise<boolean> {
  const stats = report.stages[stage] ??= { candidates: 0, sent: 0, skipped: {} };
  for (const delivery of deliveries) {
    stats.candidates++;
    const phone = whatsappNumber(delivery.contact.whatsapp, delivery.contact.mobile);
    if (!delivery.contact.active) { bump(stats.skipped, "cliente_inativo"); continue; }
    if (!phone) { bump(stats.skipped, "sem_celular"); continue; }
    if (await options.repository.isOptedOut(canonicalPhone(phone))) { bump(stats.skipped, "pediu_para_sair"); continue; }
    if (options.dryRun) { stats.sent++; continue; }
    if (budget.left <= 0) return false;
    const template = TEMPLATES[delivery.template];
    const entry = { kind: delivery.kind, refId: delivery.refId, customerId: delivery.contact.id, phone, template: template.name };
    if (!await options.repository.reserve(entry)) { bump(stats.skipped, "ja_enviado"); continue; }
    const result = await options.send({ to: phone, name: template.name, language: TEMPLATE_LANGUAGE, bodyParams: delivery.params });
    await options.repository.finish(entry, result.ok ? "sent" : "failed", result.ok ? result.messageId : null, result.ok ? null : result.reason.slice(0, 240)).catch(() => undefined);
    if (result.ok) { stats.sent++; report.sent++; budget.left--; continue; }
    bump(stats.skipped, `meta_${result.kind}`);
    if (metaStop(result)) { report.stoppedBy = "meta_limit"; return false; }
  }
  return true;
}

async function budgetFor(options: OutboundRunOptions, report: OutboundReport, at: Date): Promise<{ left: number } | undefined> {
  if (!options.dryRun && !sendingHours(at)) { report.stoppedBy = "outside_hours"; return undefined; }
  const today = `${brasiliaDate(at)}T03:00:00.000Z`; // meia-noite de Brasília
  const already = options.dryRun ? 0 : await options.repository.sentSince(today);
  const left = Math.min(options.maxSends, Math.max(options.dailyCap - already, 0));
  if (left <= 0 && !options.dryRun) { report.stoppedBy = "daily_cap"; return undefined; }
  return { left };
}

/** Lembrete 3 dias antes, vence hoje, 1 dia de atraso e véspera do bloqueio (7 dias). */
export async function runBillingReminders(options: OutboundRunOptions): Promise<OutboundReport> {
  const at = (options.now ?? (() => new Date()))();
  const report: OutboundReport = { job: "billing", dryRun: options.dryRun, stages: {}, sent: 0 };
  const budget = await budgetFor(options, report, at);
  if (!budget) return report;
  for (const stage of BILLING_STAGES) {
    const date = brasiliaDate(at, stage.offsetDays);
    const invoices: IxcDueInvoiceDto[] = [];
    for (let page = 1; page <= 10; page++) {
      const { items, total } = await options.provider.listOpenInvoicesDue(date, page, 500, options.correlationId);
      invoices.push(...items);
      if (items.length < 500 || invoices.length >= total) break;
    }
    // Um aviso por cliente e etapa: quem tem duas faturas no mesmo dia recebe uma mensagem só (a maior).
    const byCustomer = new Map<string, IxcDueInvoiceDto>();
    for (const invoice of invoices) {
      if (!invoice.customerId || invoice.value <= 0) continue;
      const current = byCustomer.get(invoice.customerId);
      if (!current || invoice.value > current.value) byCustomer.set(invoice.customerId, invoice);
    }
    const ids = [...byCustomer.keys()];
    for (let start = 0; start < ids.length; start += 200) {
      const contacts = await options.provider.listCustomerContacts(ids.slice(start, start + 200), options.correlationId);
      const deliveries = contacts.map((contact): Delivery => {
        const invoice = byCustomer.get(contact.id) as IxcDueInvoiceDto;
        return { kind: stage.kind, refId: invoice.id, contact, template: stage.template, params: [firstName(contact.name), formatMoney(invoice.value), formatDay(invoice.dueAt)] };
      });
      if (!await deliverAll(options, report, stage.kind, deliveries, budget)) { report.stoppedBy ??= "max_per_run"; return report; }
    }
  }
  return report;
}

const sameCity = (a: string, b: string) => !a || !b || a.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim() === b.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const region = (incident: NetworkIncidentRow) => `${incident.neighborhood}, ${incident.city}`;
const windowText = (startIso: string, endIso: string) => {
  const hour = (iso: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)).replace(":00", "h").replace(":", "h");
  return `das ${hour(startIso)} às ${hour(endIso)}`;
};

/**
 * Avisos de rede pelas massivas registradas no LZR: começo (enquanto está aberta), normalização
 * (nas 24 horas depois de resolvida, só para quem recebeu o começo) e manutenção programada
 * (nas 48 horas antes da janela). O público é o cadastro do IXC daquele bairro e cidade.
 */
export async function runNetworkNotices(options: OutboundRunOptions & { incidents: NetworkIncidentRow[] }): Promise<OutboundReport> {
  const at = (options.now ?? (() => new Date()))();
  const report: OutboundReport = { job: "network", dryRun: options.dryRun, stages: {}, sent: 0 };
  const budget = await budgetFor(options, report, at);
  if (!budget) return report;
  const audience = async (incident: NetworkIncidentRow) => {
    const people: IxcCustomerContactDto[] = [];
    for (let page = 1; page <= 10; page++) {
      const { items, total } = await options.provider.listCustomersInNeighborhood(incident.neighborhood, page, 500, options.correlationId);
      people.push(...items.filter((item) => sameCity(item.city, incident.city)));
      if (items.length < 500 || page * 500 >= total) break;
    }
    return people;
  };
  for (const incident of options.incidents) {
    if (incident.kind === "maintenance") {
      const start = incident.scheduledStart ? Date.parse(incident.scheduledStart) : NaN;
      if (!incident.scheduledEnd || !Number.isFinite(start) || incident.status === "resolved" || start < at.getTime() || start - at.getTime() > 48 * 3_600_000) continue;
      const deliveries = (await audience(incident)).map((contact): Delivery => ({ kind: "maintenance", refId: incident.id, contact, template: "maintenance",
        params: [firstName(contact.name), region(incident), formatDay(brasiliaDate(new Date(start))), windowText(incident.scheduledStart as string, incident.scheduledEnd as string)] }));
      if (!await deliverAll(options, report, "maintenance", deliveries, budget)) { report.stoppedBy ??= "max_per_run"; return report; }
      continue;
    }
    if (incident.status !== "resolved") {
      const deliveries = (await audience(incident)).map((contact): Delivery => ({ kind: "outage_start", refId: incident.id, contact, template: "outageStart", params: [firstName(contact.name), region(incident)] }));
      if (!await deliverAll(options, report, "outage_start", deliveries, budget)) { report.stoppedBy ??= "max_per_run"; return report; }
      continue;
    }
    if (!incident.endedAt || at.getTime() - Date.parse(incident.endedAt) > 24 * 3_600_000) continue;
    // Normalização só para quem foi avisado do começo: quem não soube do problema não precisa saber que acabou.
    const told = await options.repository.recipients("outage_start", incident.id);
    if (!told.length) continue;
    for (let start = 0; start < told.length; start += 200) {
      const contacts = await options.provider.listCustomerContacts(told.slice(start, start + 200).map((item) => item.customerId), options.correlationId);
      const deliveries = contacts.map((contact): Delivery => ({ kind: "outage_end", refId: incident.id, contact, template: "outageEnd", params: [firstName(contact.name), region(incident)] }));
      if (!await deliverAll(options, report, "outage_end", deliveries, budget)) { report.stoppedBy ??= "max_per_run"; return report; }
    }
  }
  return report;
}
