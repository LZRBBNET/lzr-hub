import { randomUUID } from "node:crypto";
import { asc, desc, eq, gte, inArray } from "drizzle-orm";
import { leadActivities, leads } from "../../db/schema.ts";
import {
  CLOSED_STAGES, LEAD_STAGES, OPEN_STAGES,
  type FunnelMetrics, type Lead, type LeadActivity, type LeadStage,
} from "./crm-shared.ts";

/**
 * Funil comercial (issue #17).
 *
 * A tabela `leads` existia desde o início do projeto e **nunca recebeu uma
 * linha**: o que havia era um `useState` com dados de demonstração, onde criar
 * lead e mover etapa funcionavam até recarregar a página. Este arquivo é o CRM
 * de verdade.
 *
 * O que ele mede e o que se recusa a medir está em `funnelMetrics`: conversão
 * só existe depois que algum lead encerrou, e ciclo médio só depois que algum
 * foi ganho. Antes disso a resposta é `null`, não zero.
 */

export class CrmValidationError extends Error {
  constructor(message: string) { super(message); this.name = "CrmValidationError"; }
}

const STAGE_IDS = new Set(LEAD_STAGES.map((stage) => stage.id));
export const isStage = (value: unknown): value is LeadStage => typeof value === "string" && STAGE_IDS.has(value as LeadStage);

/**
 * Esconde o miolo do número. O funil é lido por quem não está no atendimento, e
 * lista de telefone completo é lista de contato pronta para sair de casa.
 */
export function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return "número não informado";
  const local = digits.length > 11 && digits.startsWith("55") ? digits.slice(2) : digits;
  const ddd = local.length >= 10 ? local.slice(0, 2) : "";
  return `${ddd ? `(${ddd}) ` : ""}•••••-${local.slice(-4)}`;
}

export function parseLeadInput(body: Record<string, unknown>) {
  const text = (key: string) => typeof body[key] === "string" ? (body[key] as string).trim() : "";
  const name = text("name");
  if (name.length < 2) throw new CrmValidationError("Informe o nome de quem entrou em contato");
  const stage = isStage(body.stage) ? body.stage : "novo";
  // Nascer em "ganho" pularia o funil inteiro e estragaria conversão e ciclo:
  // um lead que já entra ganho tem ciclo zero e converte 100%.
  if (!OPEN_STAGES.includes(stage)) throw new CrmValidationError("Um lead novo começa em uma etapa em andamento");
  return {
    name, stage,
    phone: text("phone"),
    city: text("city") || "não informada",
    neighborhood: text("neighborhood") || "não informado",
    source: text("source") || "outro",
    note: text("note") || null,
  };
}

export interface CreateLeadInput { name: string; phone: string; city: string; neighborhood: string; source: string; stage: LeadStage; note: string | null; contactKey?: string | null; actorId: string }
export interface MoveLeadInput { leadId: string; toStage: LeadStage; detail: string; actorId: string }

export interface CrmRepository {
  list(limit: number): Promise<Lead[]>;
  get(id: string): Promise<Lead | undefined>;
  findByContactKey(contactKey: string): Promise<Lead | undefined>;
  create(input: CreateLeadInput): Promise<Lead>;
  move(input: MoveLeadInput): Promise<Lead | undefined>;
  addActivity(leadId: string, kind: LeadActivity["kind"], detail: string, actorId: string): Promise<LeadActivity | undefined>;
  activities(leadIds: string[]): Promise<LeadActivity[]>;
  createdSince(sinceIso: string): Promise<Lead[]>;
}

/**
 * Números do funil, do que está gravado.
 *
 * ⚠️ **Conversão é sobre leads encerrados, não sobre todos.** Dividir ganhos
 * pelo total incluiria no denominador quem ainda está negociando, e a taxa
 * pareceria despencar toda vez que entrasse contato novo — punindo a operação
 * por captar.
 */
export function funnelMetrics(all: Lead[], period: Lead[]): FunnelMetrics {
  const byStage: Record<string, number> = {};
  for (const stage of LEAD_STAGES) byStage[stage.id] = 0;
  for (const lead of all) byStage[lead.stage] = (byStage[lead.stage] ?? 0) + 1;

  const won = period.filter((lead) => lead.stage === "ganho");
  const lost = period.filter((lead) => lead.stage === "perdido");
  const closed = won.length + lost.length;

  const cycles = won
    .filter((lead) => lead.closedAt)
    .map((lead) => (new Date(lead.closedAt as string).getTime() - new Date(lead.createdAt).getTime()) / 86_400_000)
    .filter((days) => Number.isFinite(days) && days >= 0);

  const sources = new Map<string, number>();
  for (const lead of period) sources.set(lead.source, (sources.get(lead.source) ?? 0) + 1);

  return {
    byStage,
    created: period.length,
    won: won.length,
    lost: lost.length,
    open: all.filter((lead) => OPEN_STAGES.includes(lead.stage)).length,
    conversionRate: closed === 0 ? null : won.length / closed,
    averageCycleDays: cycles.length === 0 ? null : cycles.reduce((sum, days) => sum + days, 0) / cycles.length,
    bySource: [...sources.entries()].map(([source, count]) => ({ source, leads: count })).sort((a, b) => b.leads - a.leads),
  };
}

const toLead = (row: Record<string, unknown>): Lead => ({
  id: String(row.id), name: String(row.name), maskedPhone: String(row.maskedPhone),
  city: String(row.city), neighborhood: String(row.neighborhood), source: String(row.source),
  stage: (isStage(row.stage) ? row.stage : "novo"),
  ownerId: row.ownerId ? String(row.ownerId) : null,
  contactKey: row.contactKey ? String(row.contactKey) : null,
  note: row.note ? String(row.note) : null,
  closedAt: row.closedAt ? String(row.closedAt) : null,
  lostReason: row.lostReason ? String(row.lostReason) : null,
  createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
});

export class DbCrmRepository implements CrmRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async list(limit: number): Promise<Lead[]> {
    const rows = await this.db.select().from(leads).orderBy(desc(leads.updatedAt)).limit(limit);
    return rows.map(toLead);
  }
  async get(id: string) {
    const rows = await this.db.select().from(leads).where(eq(leads.id, id)).limit(1);
    return rows[0] ? toLead(rows[0]) : undefined;
  }
  async findByContactKey(contactKey: string) {
    const rows = await this.db.select().from(leads).where(eq(leads.contactKey, contactKey)).limit(1);
    return rows[0] ? toLead(rows[0]) : undefined;
  }
  async create(input: CreateLeadInput): Promise<Lead> {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(), name: input.name, maskedPhone: maskPhone(input.phone),
      city: input.city, neighborhood: input.neighborhood, source: input.source,
      stage: input.stage, score: 0, ownerId: null, contactKey: input.contactKey ?? null,
      note: input.note, closedAt: null, lostReason: null, createdAt: now, updatedAt: now,
    };
    await this.db.insert(leads).values(row);
    await this.db.insert(leadActivities).values({
      id: randomUUID(), leadId: row.id, kind: "stage_change", fromStage: null, toStage: input.stage,
      detail: `Lead criado em "${input.stage}" (origem: ${input.source})`, actorId: input.actorId, createdAt: now,
    });
    return toLead(row);
  }
  async move(input: MoveLeadInput): Promise<Lead | undefined> {
    const current = await this.get(input.leadId);
    if (!current) return undefined;
    const now = new Date().toISOString();
    const closing = CLOSED_STAGES.includes(input.toStage);
    const changes: Record<string, unknown> = {
      stage: input.toStage, updatedAt: now,
      // Reabrir um lead encerrado limpa a data de fechamento: deixá-la para trás
      // faria o ciclo médio contar um tempo que não terminou.
      closedAt: closing ? now : null,
      lostReason: input.toStage === "perdido" ? input.detail : null,
    };
    await this.db.update(leads).set(changes).where(eq(leads.id, input.leadId));
    await this.db.insert(leadActivities).values({
      id: randomUUID(), leadId: input.leadId, kind: "stage_change",
      fromStage: current.stage, toStage: input.toStage, detail: input.detail, actorId: input.actorId, createdAt: now,
    });
    return { ...current, ...changes } as Lead;
  }
  async addActivity(leadId: string, kind: LeadActivity["kind"], detail: string, actorId: string) {
    const current = await this.get(leadId);
    if (!current) return undefined;
    const now = new Date().toISOString();
    const row = { id: randomUUID(), leadId, kind, fromStage: null, toStage: null, detail, actorId, createdAt: now };
    await this.db.insert(leadActivities).values(row);
    await this.db.update(leads).set({ updatedAt: now }).where(eq(leads.id, leadId));
    return row as LeadActivity;
  }
  async activities(leadIds: string[]): Promise<LeadActivity[]> {
    if (leadIds.length === 0) return [];
    return this.db.select().from(leadActivities)
      .where(inArray(leadActivities.leadId, leadIds))
      .orderBy(asc(leadActivities.createdAt));
  }
  async createdSince(sinceIso: string): Promise<Lead[]> {
    const rows = await this.db.select().from(leads).where(gte(leads.createdAt, sinceIso)).orderBy(desc(leads.createdAt));
    return rows.map(toLead);
  }
}

export class MemoryCrmRepository implements CrmRepository {
  readonly rows: Lead[] = [];
  readonly log: LeadActivity[] = [];
  private tick = 0;
  /** Relógio monotônico: sem ele, lead e atividade nascem no mesmo milissegundo e a ordem some. */
  private now() { this.tick += 1; return new Date(Date.UTC(2026, 7, 13, 12, 0, 0, this.tick)).toISOString(); }

  async list(limit: number) { return [...this.rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit); }
  async get(id: string) { return this.rows.find((lead) => lead.id === id); }
  async findByContactKey(contactKey: string) { return this.rows.find((lead) => lead.contactKey === contactKey); }
  async create(input: CreateLeadInput) {
    const now = this.now();
    const lead: Lead = {
      id: randomUUID(), name: input.name, maskedPhone: maskPhone(input.phone), city: input.city,
      neighborhood: input.neighborhood, source: input.source, stage: input.stage, ownerId: null,
      contactKey: input.contactKey ?? null, note: input.note, closedAt: null, lostReason: null,
      createdAt: now, updatedAt: now,
    };
    this.rows.push(lead);
    this.log.push({ id: randomUUID(), leadId: lead.id, kind: "stage_change", fromStage: null, toStage: input.stage, detail: "Lead criado", actorId: input.actorId, createdAt: now });
    return lead;
  }
  async move(input: MoveLeadInput) {
    const lead = this.rows.find((item) => item.id === input.leadId);
    if (!lead) return undefined;
    const now = this.now();
    this.log.push({ id: randomUUID(), leadId: lead.id, kind: "stage_change", fromStage: lead.stage, toStage: input.toStage, detail: input.detail, actorId: input.actorId, createdAt: now });
    lead.stage = input.toStage;
    lead.closedAt = CLOSED_STAGES.includes(input.toStage) ? now : null;
    lead.lostReason = input.toStage === "perdido" ? input.detail : null;
    lead.updatedAt = now;
    return lead;
  }
  async addActivity(leadId: string, kind: LeadActivity["kind"], detail: string, actorId: string) {
    const lead = this.rows.find((item) => item.id === leadId);
    if (!lead) return undefined;
    const now = this.now();
    const activity: LeadActivity = { id: randomUUID(), leadId, kind, fromStage: null, toStage: null, detail, actorId, createdAt: now };
    this.log.push(activity); lead.updatedAt = now;
    return activity;
  }
  async activities(leadIds: string[]) { return this.log.filter((item) => leadIds.includes(item.leadId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  async createdSince(sinceIso: string) { return this.rows.filter((lead) => lead.createdAt >= sinceIso); }
}

/**
 * Captura de lead a partir de um contato do canal.
 *
 * Regra que faz esta função existir: **só vira lead quem não é cliente**. Quem
 * já tem cadastro no IXC escrevendo sobre a fatura não é oportunidade de venda,
 * e tratá-lo como tal encheria o funil de gente que já comprou.
 *
 * `resolveCustomer` devolve `undefined` tanto para "não é cliente" quanto para
 * "não deu para saber" (IXC fora do ar, número ambíguo). Os dois casos são
 * tratados igual **de propósito**: na dúvida, não cria lead. Um funil com gente
 * a mais mente sobre a conversão tanto quanto um com gente a menos, e o erro
 * silencioso aqui seria criar lead de cliente antigo toda vez que o ERP caísse.
 */
export async function captureLeadFromContact(
  repository: CrmRepository,
  input: { contactKey: string; text: string },
  resolveCustomer: (phone: string) => Promise<{ id: string } | undefined>,
): Promise<Lead | undefined> {
  const existing = await repository.findByContactKey(input.contactKey);
  if (existing) return undefined;

  let customer: { id: string } | undefined;
  try { customer = await resolveCustomer(input.contactKey); }
  catch { return undefined; }
  if (customer) return undefined;

  return repository.create({
    // O nome só se sabe perguntando; inventar a partir do número seria pior que
    // dizer que não se sabe, e quem atender vai preencher.
    name: `Contato ${maskPhone(input.contactKey)}`,
    phone: input.contactKey, city: "não informada", neighborhood: "não informado",
    source: "whatsapp", stage: "novo",
    note: null, contactKey: input.contactKey, actorId: "canal-whatsapp",
  });
}
