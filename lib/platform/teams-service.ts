import { randomUUID } from "node:crypto";
import { and, asc, eq, gte } from "drizzle-orm";
import { conversationOutcomes, teamMembers, teams, users } from "../../db/schema.ts";
import {
  HANDOFF_REASONS, MAX_TEAM_DESCRIPTION, MAX_TEAM_NAME,
  type Team, type TeamInput, type TeamLoad, type TeamMember,
} from "./teams-shared.ts";

/**
 * Equipes de atendimento.
 *
 * A tela "Equipes e Filas" mostrava as filas técnicas do BullMQ
 * (`message-inbound`, `ixc-sync`) — que são jobs de infraestrutura, não gente.
 * Equipe de atendimento nunca existiu em lugar nenhum.
 *
 * O que este serviço registra é **quem atende o quê**: uma equipe declara os
 * motivos de transbordo que assume, e a tela cruza isso com os desfechos reais
 * gravados em `conversation_outcomes`.
 *
 * ⚠️ Isto **não roteia** conversa nenhuma. Nada no sistema entrega um
 * atendimento a uma equipe — quem responde é o fluxo do n8n. É um registro
 * organizacional mais um relatório de carga medida. A tela diz isso; prometer
 * roteamento que não existe seria a mesma ficção que a gente passou a semana
 * tirando daqui.
 */
export class TeamValidationError extends Error {
  constructor(message: string) { super(message); this.name = "TeamValidationError"; }
}

export interface TeamsRepository {
  list(): Promise<Team[]>;
  create(input: TeamInput): Promise<Team>;
  update(id: string, input: TeamInput): Promise<Team | undefined>;
  setActive(id: string, active: boolean): Promise<boolean>;
  addMember(teamId: string, userId: string): Promise<boolean>;
  removeMember(teamId: string, userId: string): Promise<boolean>;
  loadSince(sinceIso: string): Promise<Array<{ reason: string; count: number }>>;
}

/** Fila com espaço ou acento vira identificador que ninguém consegue casar depois. */
const QUEUE_PATTERN = /^[a-z0-9][a-z0-9-]{1,29}$/;

export function parseTeamInput(body: Record<string, unknown>): TeamInput {
  const name = String(body.name ?? "").trim();
  if (name.length < 2) throw new TeamValidationError("O nome da equipe precisa ter ao menos 2 caracteres.");
  if (name.length > MAX_TEAM_NAME) throw new TeamValidationError(`O nome passa de ${MAX_TEAM_NAME} caracteres.`);

  const queue = String(body.queue ?? "").trim().toLowerCase();
  if (!QUEUE_PATTERN.test(queue)) throw new TeamValidationError("A fila aceita letras minúsculas, números e hífen (ex.: suporte-tecnico).");

  const description = String(body.description ?? "").trim();
  if (description.length > MAX_TEAM_DESCRIPTION) throw new TeamValidationError(`A descrição passa de ${MAX_TEAM_DESCRIPTION} caracteres.`);

  const raw = Array.isArray(body.handoffReasons) ? body.handoffReasons : [];
  const reasons = [...new Set(raw.map((value) => String(value)))];
  // Motivo fora da lista viraria uma equipe esperando trabalho que nunca chega.
  for (const reason of reasons) {
    if (!(HANDOFF_REASONS as readonly string[]).includes(reason)) throw new TeamValidationError(`Motivo de transbordo desconhecido: ${reason}`);
  }

  return { name, queue, description: description || null, handoffReasons: reasons };
}

/**
 * Cruza os motivos que cada equipe assume com os transbordos medidos.
 *
 * Um motivo pode ser reivindicado por mais de uma equipe — nesse caso ele conta
 * para as duas. Não é erro: sem roteamento, "assumir" é declaração, não posse.
 */
export function summarizeTeamLoad(list: Team[], counts: Array<{ reason: string; count: number }>): TeamLoad[] {
  const byReason = new Map(counts.map((row) => [row.reason, row.count]));
  return list.map((team) => {
    const detail: Record<string, number> = {};
    let total = 0;
    for (const reason of team.handoffReasons) {
      const value = byReason.get(reason) ?? 0;
      detail[reason] = value;
      total += value;
    }
    return { teamId: team.id, handoffs: total, byReason: detail };
  });
}

/** Motivos que nenhuma equipe assumiu: é o buraco que a tela precisa mostrar. */
export function unclaimedReasons(list: Team[], counts: Array<{ reason: string; count: number }>): Array<{ reason: string; count: number }> {
  const claimed = new Set(list.filter((team) => team.active).flatMap((team) => team.handoffReasons));
  return counts.filter((row) => row.count > 0 && !claimed.has(row.reason)).sort((a, b) => b.count - a.count);
}

const asReasons = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];

export class DbTeamsRepository implements TeamsRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async list(): Promise<Team[]> {
    const rows = await this.db.select().from(teams).orderBy(asc(teams.name));
    if (rows.length === 0) return [];
    // Uma consulta para todos os vínculos, em vez de uma por equipe.
    const links = await this.db.select({
      teamId: teamMembers.teamId, userId: teamMembers.userId,
      name: users.name, email: users.email, role: users.role, active: users.active,
    }).from(teamMembers).innerJoin(users, eq(users.id, teamMembers.userId));

    const byTeam = new Map<string, TeamMember[]>();
    for (const link of links) {
      const list = byTeam.get(link.teamId) ?? [];
      list.push({ userId: link.userId, name: link.name, email: link.email, role: link.role, active: link.active });
      byTeam.set(link.teamId, list);
    }
    return rows.map((row: Record<string, unknown>): Team => ({
      id: String(row.id), name: String(row.name), queue: String(row.queue),
      description: row.description === null || row.description === undefined ? null : String(row.description),
      active: Boolean(row.active), handoffReasons: asReasons(row.handoffReasons),
      members: byTeam.get(String(row.id)) ?? [], updatedAt: String(row.updatedAt),
    }));
  }

  async create(input: TeamInput): Promise<Team> {
    const now = new Date().toISOString();
    const row = { id: randomUUID(), name: input.name, queue: input.queue, description: input.description, active: true, handoffReasons: input.handoffReasons, createdAt: now, updatedAt: now };
    await this.db.insert(teams).values(row);
    return { ...row, members: [] };
  }

  async update(id: string, input: TeamInput): Promise<Team | undefined> {
    const now = new Date().toISOString();
    await this.db.update(teams)
      .set({ name: input.name, queue: input.queue, description: input.description, handoffReasons: input.handoffReasons, updatedAt: now })
      .where(eq(teams.id, id));
    return (await this.list()).find((team) => team.id === id);
  }

  async setActive(id: string, active: boolean): Promise<boolean> {
    const rows = await this.db.select().from(teams).where(eq(teams.id, id)).limit(1);
    if (!rows[0]) return false;
    await this.db.update(teams).set({ active, updatedAt: new Date().toISOString() }).where(eq(teams.id, id));
    return true;
  }

  async addMember(teamId: string, userId: string): Promise<boolean> {
    const existing = await this.db.select().from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))).limit(1);
    if (existing[0]) return false;
    await this.db.insert(teamMembers).values({ id: randomUUID(), teamId, userId, createdAt: new Date().toISOString() });
    return true;
  }

  async removeMember(teamId: string, userId: string): Promise<boolean> {
    const existing = await this.db.select().from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))).limit(1);
    if (!existing[0]) return false;
    await this.db.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    return true;
  }

  async loadSince(sinceIso: string): Promise<Array<{ reason: string; count: number }>> {
    const rows = await this.db.select({ reason: conversationOutcomes.handoffReason })
      .from(conversationOutcomes)
      .where(and(eq(conversationOutcomes.handoff, true), gte(conversationOutcomes.createdAt, sinceIso)));
    const tally = new Map<string, number>();
    for (const row of rows) {
      const reason = row.reason ?? "não informado";
      tally.set(reason, (tally.get(reason) ?? 0) + 1);
    }
    return [...tally.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  }
}

export class MemoryTeamsRepository implements TeamsRepository {
  private readonly store = new Map<string, Team>();
  private readonly outcomes: Array<{ reason: string; at: string }> = [];
  /** Usuários conhecidos, para o vínculo devolver nome e perfil como o banco faz. */
  readonly people = new Map<string, TeamMember>();

  async list() { return [...this.store.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  async create(input: TeamInput) {
    const team: Team = { id: randomUUID(), ...input, active: true, members: [], updatedAt: new Date().toISOString() };
    this.store.set(team.id, team);
    return team;
  }
  async update(id: string, input: TeamInput) {
    const team = this.store.get(id);
    if (!team) return undefined;
    const updated: Team = { ...team, ...input, updatedAt: new Date().toISOString() };
    this.store.set(id, updated);
    return updated;
  }
  async setActive(id: string, active: boolean) {
    const team = this.store.get(id);
    if (!team) return false;
    this.store.set(id, { ...team, active, updatedAt: new Date().toISOString() });
    return true;
  }
  async addMember(teamId: string, userId: string) {
    const team = this.store.get(teamId);
    if (!team || team.members.some((member) => member.userId === userId)) return false;
    const person = this.people.get(userId) ?? { userId, name: userId, email: userId, role: "Atendente", active: true };
    this.store.set(teamId, { ...team, members: [...team.members, person] });
    return true;
  }
  async removeMember(teamId: string, userId: string) {
    const team = this.store.get(teamId);
    if (!team || !team.members.some((member) => member.userId === userId)) return false;
    this.store.set(teamId, { ...team, members: team.members.filter((member) => member.userId !== userId) });
    return true;
  }
  /** Só para teste: registra um transbordo medido. */
  recordHandoff(reason: string, at = new Date().toISOString()) { this.outcomes.push({ reason, at }); }
  async loadSince(sinceIso: string) {
    const tally = new Map<string, number>();
    for (const row of this.outcomes) {
      if (row.at < sinceIso) continue;
      tally.set(row.reason, (tally.get(row.reason) ?? 0) + 1);
    }
    return [...tally.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  }
}
