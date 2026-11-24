import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { technicianRouteState, technicianRoutes } from "../../db/schema.ts";
import type { TechnicianRoute, Vehicle } from "./os-dispatch-shared.ts";

/**
 * Cidade → técnicos (moto/carro) para a OS aberta pela IA, e quem recebeu por último.
 * A tabela é da operação: quem administra troca a lista inteira de uma vez (`replaceAll`), com
 * autoria registrada. Ver `os-dispatch-shared.ts` para as regras de escolha.
 */
export interface StoredTechnicianRoute extends TechnicianRoute { cityName: string; technicianName: string }

export interface TechnicianRoutesRepository {
  list(): Promise<StoredTechnicianRoute[]>;
  replaceAll(routes: StoredTechnicianRoute[], updatedBy: string): Promise<void>;
  lastAssigned(cityId: string, vehicle: Vehicle): Promise<string | null>;
  setLastAssigned(cityId: string, vehicle: Vehicle, technicianId: string): Promise<void>;
}

const VEHICLES: ReadonlySet<string> = new Set(["moto", "carro"]);
const ID = /^[1-9]\d{0,31}$/;

/** Recusa a lista inteira se uma linha estiver errada: meia tabela trocada mandaria OS para o lugar errado. */
export function validateRoutes(input: unknown): { ok: true; routes: StoredTechnicianRoute[] } | { ok: false; reason: string } {
  if (!Array.isArray(input)) return { ok: false, reason: "Envie a lista de rotas." };
  if (input.length > 500) return { ok: false, reason: "Lista grande demais (máximo 500 linhas)." };
  const routes: StoredTechnicianRoute[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of input.entries()) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const cityId = String(row.cityId ?? "").trim();
    const technicianId = String(row.technicianId ?? "").trim();
    const vehicle = String(row.vehicle ?? "").trim();
    const cityName = String(row.cityName ?? "").trim().slice(0, 80);
    const technicianName = String(row.technicianName ?? "").trim().slice(0, 120);
    if (!ID.test(cityId) || !ID.test(technicianId)) return { ok: false, reason: `Linha ${index + 1}: cidade e técnico são códigos do IXC.` };
    if (!VEHICLES.has(vehicle)) return { ok: false, reason: `Linha ${index + 1}: tipo é "moto" ou "carro".` };
    if (!cityName || !technicianName) return { ok: false, reason: `Linha ${index + 1}: falta o nome da cidade ou do técnico.` };
    const key = `${cityId}:${vehicle}:${technicianId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ cityId, cityName, vehicle: vehicle as Vehicle, technicianId, technicianName, active: row.active !== false });
  }
  return { ok: true, routes };
}

export class DbTechnicianRoutesRepository implements TechnicianRoutesRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }
  async list(): Promise<StoredTechnicianRoute[]> {
    const rows = await this.db.select().from(technicianRoutes);
    return rows.map((row: { cityId: string; cityName: string; vehicle: string; technicianId: string; technicianName: string; active: boolean }) => ({
      cityId: row.cityId, cityName: row.cityName, vehicle: row.vehicle as Vehicle, technicianId: row.technicianId, technicianName: row.technicianName, active: row.active,
    }));
  }
  async replaceAll(routes: StoredTechnicianRoute[], updatedBy: string) {
    const now = new Date().toISOString();
    // Numa transação: quem lê no meio nunca vê a tabela vazia.
    await this.db.transaction(async (tx: { delete: (t: unknown) => Promise<unknown>; insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } }) => {
      await tx.delete(technicianRoutes);
      if (routes.length) await tx.insert(technicianRoutes).values(routes.map((route) => ({ id: randomUUID(), ...route, updatedBy, createdAt: now, updatedAt: now })));
    });
  }
  async lastAssigned(cityId: string, vehicle: Vehicle) {
    const rows = await this.db.select({ id: technicianRouteState.lastTechnicianId }).from(technicianRouteState)
      .where(and(eq(technicianRouteState.cityId, cityId), eq(technicianRouteState.vehicle, vehicle))).limit(1);
    return rows[0]?.id ?? null;
  }
  async setLastAssigned(cityId: string, vehicle: Vehicle, technicianId: string) {
    const updatedAt = new Date().toISOString();
    await this.db.insert(technicianRouteState).values({ cityId, vehicle, lastTechnicianId: technicianId, updatedAt })
      .onConflictDoUpdate({ target: [technicianRouteState.cityId, technicianRouteState.vehicle], set: { lastTechnicianId: technicianId, updatedAt } });
  }
}

export class MemoryTechnicianRoutesRepository implements TechnicianRoutesRepository {
  routes: StoredTechnicianRoute[];
  readonly last = new Map<string, string>();
  constructor(routes: StoredTechnicianRoute[] = []) { this.routes = routes; }
  async list() { return [...this.routes]; }
  async replaceAll(routes: StoredTechnicianRoute[]) { this.routes = [...routes]; }
  async lastAssigned(cityId: string, vehicle: Vehicle) { return this.last.get(`${cityId}:${vehicle}`) ?? null; }
  async setLastAssigned(cityId: string, vehicle: Vehicle, technicianId: string) { this.last.set(`${cityId}:${vehicle}`, technicianId); }
}
