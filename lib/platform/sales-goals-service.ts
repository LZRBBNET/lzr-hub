import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { salesGoals } from "../../db/schema.ts";

/**
 * Meta comercial por mês.
 *
 * A tela antes mostrava "meta 380, realizado 241, projeção 104% da meta" — três
 * números fixos no código, que não vinham de lugar nenhum e nunca mudavam.
 *
 * Aqui a **meta** é registrada por uma pessoa e fica auditada; o **realizado**
 * vem do IXC na hora da consulta e não é guardado. Guardar o realizado seria
 * guardar uma cópia que envelhece: um contrato cancelado depois da gravação
 * deixaria a meta batida para sempre.
 */
export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Teto de sanidade: erro de digitação vira meta impossível e o painel inteiro perde sentido. */
export const MAX_TARGET_CONTRACTS = 100000;

export interface SalesGoal {
  id: string;
  period: string;
  targetContracts: number;
  /** Em reais. `null` quando a operação só define meta de volume. */
  targetRevenue: number | null;
  note: string | null;
  createdBy: string;
  updatedAt: string;
}

export interface GoalInput {
  period: string;
  targetContracts: number;
  targetRevenue: number | null;
  note: string | null;
}

export interface SalesGoalsRepository {
  list(limit: number): Promise<SalesGoal[]>;
  findByPeriod(period: string): Promise<SalesGoal | undefined>;
  upsert(input: GoalInput, actorId: string): Promise<SalesGoal>;
  remove(period: string): Promise<boolean>;
}

export class GoalValidationError extends Error {
  constructor(message: string) { super(message); this.name = "GoalValidationError"; }
}

/** Meta inválida é pior que meta nenhuma: o painel passa a comparar contra lixo. */
export function parseGoalInput(body: Record<string, unknown>): GoalInput {
  const period = String(body.period ?? "").trim();
  if (!PERIOD_PATTERN.test(period)) throw new GoalValidationError("Competência inválida. Use o formato AAAA-MM.");

  const target = Number(body.targetContracts);
  if (!Number.isInteger(target) || target < 1) throw new GoalValidationError("A meta de contratos precisa ser um número inteiro maior que zero.");
  if (target > MAX_TARGET_CONTRACTS) throw new GoalValidationError(`A meta de contratos não pode passar de ${MAX_TARGET_CONTRACTS.toLocaleString("pt-BR")}.`);

  // Receita é opcional: campo vazio significa "sem meta de receita", não zero.
  const rawRevenue = body.targetRevenue;
  let targetRevenue: number | null = null;
  if (rawRevenue !== undefined && rawRevenue !== null && String(rawRevenue).trim() !== "") {
    const value = Number(String(rawRevenue).replace(",", "."));
    if (!Number.isFinite(value) || value < 0) throw new GoalValidationError("A meta de receita precisa ser um valor válido.");
    targetRevenue = Math.round(value * 100) / 100;
  }

  const note = String(body.note ?? "").trim();
  if (note.length > 280) throw new GoalValidationError("A observação passa de 280 caracteres.");

  return { period, targetContracts: target, targetRevenue, note: note || null };
}

export interface GoalProgress {
  contractsPercent: number;
  revenuePercent: number | null;
  /** Fração do mês já decorrida, de 0 a 1. */
  elapsed: number;
  /** Projeção pelo ritmo atual. `null` fora do mês corrente — mês fechado não se projeta. */
  projectedContracts: number | null;
  /** `true` quando o ritmo atual não chega na meta até o fim do mês. */
  behind: boolean;
}

/**
 * Compara meta com realizado.
 *
 * A projeção é **ritmo linear** sobre dias corridos: realizado dividido pela
 * fração do mês que já passou. Não pondera dia útil nem sazonalidade — é uma
 * regra de três, e a tela diz isso. Só existe para o mês corrente: projetar um
 * mês fechado seria inventar futuro para um passado já conhecido.
 */
export function goalProgress(goal: SalesGoal, realizedContracts: number, realizedRevenue: number | null, now: Date): GoalProgress {
  const [year, month] = goal.period.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const isCurrent = now.getUTCFullYear() === year && now.getUTCMonth() + 1 === month;
  const isFuture = Date.UTC(year, month - 1, 1) > now.getTime();
  const elapsed = isCurrent ? Math.min(now.getUTCDate() / daysInMonth, 1) : isFuture ? 0 : 1;

  const contractsPercent = goal.targetContracts ? realizedContracts / goal.targetContracts : 0;
  const revenuePercent = goal.targetRevenue && realizedRevenue !== null ? realizedRevenue / goal.targetRevenue : null;
  // Sem dia decorrido não há ritmo para projetar — no dia 1º qualquer projeção
  // seria multiplicar por trinta o que aconteceu em algumas horas.
  const projectedContracts = isCurrent && elapsed > 0 ? Math.round(realizedContracts / elapsed) : null;

  return {
    contractsPercent,
    revenuePercent,
    elapsed,
    projectedContracts,
    behind: projectedContracts !== null ? projectedContracts < goal.targetContracts : contractsPercent < 1,
  };
}

/** Competência do mês corrente, no fuso de São Paulo — o mês vira lá, não em UTC. */
export function currentPeriod(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).format(now).slice(0, 7);
}

/** Primeiro instante e último instante da competência, para filtrar no IXC. */
export function periodRange(period: string): { since: string; until: string } {
  const [year, month] = period.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { since: `${period}-01`, until: `${period}-${String(last).padStart(2, "0")}` };
}

const toGoal = (row: Record<string, unknown>): SalesGoal => ({
  id: String(row.id),
  period: String(row.period),
  targetContracts: Number(row.targetContracts),
  targetRevenue: row.targetRevenueCents === null || row.targetRevenueCents === undefined ? null : Number(row.targetRevenueCents) / 100,
  note: row.note === null || row.note === undefined ? null : String(row.note),
  createdBy: String(row.createdBy),
  updatedAt: String(row.updatedAt),
});

export class DbSalesGoalsRepository implements SalesGoalsRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async list(limit: number): Promise<SalesGoal[]> {
    const rows = await this.db.select().from(salesGoals).orderBy(desc(salesGoals.period)).limit(limit);
    return rows.map(toGoal);
  }
  async findByPeriod(period: string): Promise<SalesGoal | undefined> {
    const rows = await this.db.select().from(salesGoals).where(eq(salesGoals.period, period)).limit(1);
    return rows[0] ? toGoal(rows[0]) : undefined;
  }
  async upsert(input: GoalInput, actorId: string): Promise<SalesGoal> {
    const now = new Date().toISOString();
    const cents = input.targetRevenue === null ? null : Math.round(input.targetRevenue * 100);
    const existing = await this.findByPeriod(input.period);
    if (existing) {
      await this.db.update(salesGoals)
        .set({ targetContracts: input.targetContracts, targetRevenueCents: cents, note: input.note, updatedAt: now })
        .where(eq(salesGoals.period, input.period));
      return { ...existing, targetContracts: input.targetContracts, targetRevenue: input.targetRevenue, note: input.note, updatedAt: now };
    }
    const row = { id: randomUUID(), period: input.period, targetContracts: input.targetContracts, targetRevenueCents: cents, note: input.note, createdBy: actorId, createdAt: now, updatedAt: now };
    await this.db.insert(salesGoals).values(row);
    return toGoal(row);
  }
  async remove(period: string): Promise<boolean> {
    const existing = await this.findByPeriod(period);
    if (!existing) return false;
    await this.db.delete(salesGoals).where(eq(salesGoals.period, period));
    return true;
  }
}

export class MemorySalesGoalsRepository implements SalesGoalsRepository {
  private readonly store = new Map<string, SalesGoal>();
  async list(limit: number) { return [...this.store.values()].sort((a, b) => b.period.localeCompare(a.period)).slice(0, limit); }
  async findByPeriod(period: string) { return this.store.get(period); }
  async upsert(input: GoalInput, actorId: string) {
    const existing = this.store.get(input.period);
    const goal: SalesGoal = {
      id: existing?.id ?? randomUUID(),
      period: input.period,
      targetContracts: input.targetContracts,
      targetRevenue: input.targetRevenue,
      note: input.note,
      createdBy: existing?.createdBy ?? actorId,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(input.period, goal);
    return goal;
  }
  async remove(period: string) { return this.store.delete(period); }
}
