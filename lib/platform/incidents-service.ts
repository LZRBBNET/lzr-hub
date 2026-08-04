import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { networkIncidents } from "../../db/schema.ts";

/**
 * Massivas (incidentes de rede) registradas pela própria operação.
 *
 * Não existe integração de monitoramento alimentando isso: quem registra é uma
 * pessoa, aqui. Por isso a lista começa vazia e a tela diz que está vazia, em
 * vez de exibir incidente de exemplo como já fez.
 *
 * Registrar uma massiva não comunica ninguém — nenhuma mensagem sai daqui. É
 * só o registro operacional, auditado, para acompanhar e encerrar.
 */
export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const INCIDENT_STATUSES = ["investigating", "monitoring", "resolved"] as const;
export type IncidentSeverity = typeof INCIDENT_SEVERITIES[number];
export type IncidentStatus = typeof INCIDENT_STATUSES[number];

export interface NetworkIncidentRow {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  city: string;
  neighborhood: string;
  equipment: string | null;
  affectedCustomers: number;
  startedAt: string;
  endedAt: string | null;
}

export interface IncidentInput {
  title: string;
  severity: IncidentSeverity;
  city: string;
  neighborhood: string;
  equipment?: string;
  affectedCustomers: number;
}

export interface IncidentsRepository {
  list(limit: number): Promise<NetworkIncidentRow[]>;
  create(input: IncidentInput): Promise<NetworkIncidentRow>;
  close(id: string): Promise<NetworkIncidentRow | undefined>;
}

export class IncidentValidationError extends Error {
  constructor(message: string) { super(message); this.name = "IncidentValidationError"; }
}

/** Valida antes de gravar: severidade e cidade erradas viram registro inútil no acompanhamento. */
export function parseIncidentInput(body: Record<string, unknown>): IncidentInput {
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const title = text(body.title);
  const city = text(body.city);
  const neighborhood = text(body.neighborhood);
  const severity = text(body.severity) as IncidentSeverity;
  const affected = Number(body.affectedCustomers ?? 0);

  if (title.length < 3) throw new IncidentValidationError("Descreva a massiva em pelo menos 3 caracteres");
  if (!city) throw new IncidentValidationError("Informe a cidade afetada");
  if (!neighborhood) throw new IncidentValidationError("Informe o bairro ou região afetada");
  if (!INCIDENT_SEVERITIES.includes(severity)) throw new IncidentValidationError("Severidade inválida");
  if (!Number.isInteger(affected) || affected < 0) throw new IncidentValidationError("Quantidade de clientes afetados inválida");

  return { title, severity, city, neighborhood, equipment: text(body.equipment) || undefined, affectedCustomers: affected };
}

export class DbIncidentsRepository implements IncidentsRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async list(limit: number): Promise<NetworkIncidentRow[]> {
    return this.db.select({
      id: networkIncidents.id, title: networkIncidents.title, severity: networkIncidents.severity,
      status: networkIncidents.status, city: networkIncidents.city, neighborhood: networkIncidents.neighborhood,
      equipment: networkIncidents.equipment, affectedCustomers: networkIncidents.affectedCustomers,
      startedAt: networkIncidents.startedAt, endedAt: networkIncidents.endedAt,
    }).from(networkIncidents).orderBy(desc(networkIncidents.startedAt)).limit(limit);
  }

  async create(input: IncidentInput): Promise<NetworkIncidentRow> {
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(), title: input.title, severity: input.severity, status: "investigating" as const,
      city: input.city, neighborhood: input.neighborhood, equipment: input.equipment ?? null,
      affectedCustomers: input.affectedCustomers, startedAt: now, endedAt: null,
    };
    await this.db.insert(networkIncidents).values({ ...row, createdAt: now, updatedAt: now });
    return row;
  }

  async close(id: string): Promise<NetworkIncidentRow | undefined> {
    const now = new Date().toISOString();
    const updated = await this.db.update(networkIncidents)
      .set({ status: "resolved", endedAt: now, updatedAt: now })
      .where(eq(networkIncidents.id, id))
      .returning();
    return updated[0];
  }
}

export class MemoryIncidentsRepository implements IncidentsRepository {
  readonly rows: NetworkIncidentRow[] = [];
  async list(limit: number) { return [...this.rows].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit); }
  async create(input: IncidentInput) {
    const row: NetworkIncidentRow = {
      id: randomUUID(), title: input.title, severity: input.severity, status: "investigating",
      city: input.city, neighborhood: input.neighborhood, equipment: input.equipment ?? null,
      affectedCustomers: input.affectedCustomers, startedAt: new Date().toISOString(), endedAt: null,
    };
    this.rows.push(row);
    return row;
  }
  async close(id: string) {
    const row = this.rows.find((item) => item.id === id);
    if (!row) return undefined;
    row.status = "resolved"; row.endedAt = new Date().toISOString();
    return row;
  }
}
