import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { users } from "../../db/schema.ts";
import type { IxcSystemUser } from "../integrations/ixc/system-users.ts";
import { hashPassword, isRole } from "./auth.ts";
import type { Role } from "./rbac.ts";

/**
 * Papel dado a quem vem de um grupo do IXC que ninguém mapeou ainda.
 * Fail-closed: na dúvida, o mínimo de privilégio.
 */
export const DEFAULT_ROLE: Role = "Somente leitura";

export interface ProvisionedUserRow {
  id: string; email: string; name: string; role: string; active: boolean;
}

export interface UserProvisioningRepository {
  findByEmail(email: string): Promise<ProvisionedUserRow | undefined>;
  createUser(row: { email: string; name: string; role: Role; passwordHash: string; passwordSalt: string }): Promise<void>;
  updateUser(id: string, changes: { name: string; role: Role; active: boolean }): Promise<void>;
}

export interface SyncOptions {
  /** Mapa id_grupo do IXC → papel do LZR HUB. */
  groupRoles: Record<string, Role>;
  /** Contas que a sincronização nunca altera — evita rebaixar o administrador local. */
  protectedEmails?: string[];
}

export interface SyncSummary {
  processed: number;
  created: number;
  updated: number;
  deactivated: number;
  skippedProtected: number;
  /** Grupos encontrados que ninguém mapeou; viraram DEFAULT_ROLE. */
  unmappedGroups: string[];
}

export function parseGroupRoleMap(raw: string | undefined): Record<string, Role> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const map: Record<string, Role> = {};
  for (const [group, role] of Object.entries(parsed as Record<string, unknown>)) {
    // Papel inválido é ignorado em vez de virar acesso amplo por engano.
    if (typeof role === "string" && isRole(role)) map[String(group).trim()] = role;
  }
  return map;
}

export function resolveRole(groupId: string, groupRoles: Record<string, Role>): Role {
  return groupRoles[groupId] ?? DEFAULT_ROLE;
}

/**
 * Senha impossível de acertar, para contas recém-provisionadas.
 * A pessoa só entra depois que um administrador definir uma senha de verdade
 * (scripts/create-user.mjs) — provisionar não pode, sozinho, conceder acesso.
 */
async function unusablePassword() {
  return hashPassword(randomBytes(32).toString("hex"));
}

export async function syncIxcUsers(
  ixcUsers: IxcSystemUser[],
  repository: UserProvisioningRepository,
  options: SyncOptions,
): Promise<SyncSummary> {
  const protectedEmails = new Set((options.protectedEmails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean));
  const summary: SyncSummary = { processed: 0, created: 0, updated: 0, deactivated: 0, skippedProtected: 0, unmappedGroups: [] };
  const unmapped = new Set<string>();

  for (const ixcUser of ixcUsers) {
    summary.processed += 1;

    if (protectedEmails.has(ixcUser.email)) { summary.skippedProtected += 1; continue; }

    if (ixcUser.groupId && !(ixcUser.groupId in options.groupRoles)) unmapped.add(ixcUser.groupId);
    const role = resolveRole(ixcUser.groupId, options.groupRoles);

    const existing = await repository.findByEmail(ixcUser.email);
    if (!existing) {
      // Conta inativa no IXC não gera conta nova aqui.
      if (!ixcUser.active) continue;
      const { hash, salt } = await unusablePassword();
      await repository.createUser({ email: ixcUser.email, name: ixcUser.name, role, passwordHash: hash, passwordSalt: salt });
      summary.created += 1;
      continue;
    }

    // Lido antes do update: o repositório pode devolver a própria linha por
    // referência, e aí o valor anterior se perderia depois de gravar.
    const wasActive = existing.active;
    const changed = existing.name !== ixcUser.name || existing.role !== role || wasActive !== ixcUser.active;
    if (!changed) continue;
    await repository.updateUser(existing.id, { name: ixcUser.name, role, active: ixcUser.active });
    if (wasActive && !ixcUser.active) summary.deactivated += 1; else summary.updated += 1;
  }

  summary.unmappedGroups = [...unmapped].sort();
  return summary;
}

export class DbUserProvisioningRepository implements UserProvisioningRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async findByEmail(email: string) {
    const rows = await this.db.select({ id: users.id, email: users.email, name: users.name, role: users.role, active: users.active })
      .from(users).where(eq(users.email, email)).limit(1);
    return rows[0];
  }
  async createUser(row: { email: string; name: string; role: Role; passwordHash: string; passwordSalt: string }) {
    const now = new Date().toISOString();
    await this.db.insert(users).values({
      id: randomUUID(), email: row.email, name: row.name, role: row.role,
      passwordHash: row.passwordHash, passwordSalt: row.passwordSalt,
      active: true, createdAt: now, updatedAt: now,
    }).onConflictDoNothing();
  }
  async updateUser(id: string, changes: { name: string; role: Role; active: boolean }) {
    await this.db.update(users)
      .set({ name: changes.name, role: changes.role, active: changes.active, updatedAt: new Date().toISOString() })
      .where(eq(users.id, id));
  }
}

export class MemoryUserProvisioningRepository implements UserProvisioningRepository {
  readonly rows: ProvisionedUserRow[] = [];
  async findByEmail(email: string) { return this.rows.find((row) => row.email === email); }
  async createUser(row: { email: string; name: string; role: Role }) {
    this.rows.push({ id: randomUUID(), email: row.email, name: row.name, role: row.role, active: true });
  }
  async updateUser(id: string, changes: { name: string; role: Role; active: boolean }) {
    const row = this.rows.find((item) => item.id === id);
    if (row) { row.name = changes.name; row.role = changes.role; row.active = changes.active; }
  }
}
