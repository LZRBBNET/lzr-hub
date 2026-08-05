import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { users } from "../../db/schema.ts";
import { hashPassword, isRole, type AuthenticatedUser } from "./auth.ts";
import { can, type Role } from "./rbac.ts";

/**
 * Gestão de contas pela tela: criar, desativar, trocar perfil e resetar senha.
 *
 * Antes só existia `scripts/create-user.mjs`, o que significava que tirar o
 * acesso de alguém dependia de ter o banco à mão. Um sistema com login que não
 * permite revogar acesso rápido é pior que um sem login: dá a sensação de
 * controle sem o controle.
 *
 * A senha nunca é escolhida por quem administra. O sistema gera, devolve **uma
 * única vez** e guarda só o hash — o administrador não fica sabendo a senha
 * definitiva de ninguém, e uma senha fraca escolhida às pressas não entra.
 */
export const GENERATED_PASSWORD_BYTES = 12;

export interface AdminUser { id: string; name: string; email: string; role: string; active: boolean }

export interface UserAdminRepository {
  list(): Promise<AdminUser[]>;
  findById(id: string): Promise<AdminUser | undefined>;
  findByEmail(email: string): Promise<AdminUser | undefined>;
  insert(user: { id: string; name: string; email: string; role: string; passwordHash: string; passwordSalt: string }): Promise<void>;
  update(id: string, patch: { role?: string; active?: boolean; passwordHash?: string; passwordSalt?: string }): Promise<void>;
}

export class UserAdminError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) { super(message); this.name = "UserAdminError"; this.status = status; }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function parseNewUser(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = typeof body.role === "string" ? body.role.trim() : "";
  if (name.length < 3) throw new UserAdminError("Informe o nome completo");
  if (!EMAIL.test(email)) throw new UserAdminError("E-mail inválido");
  if (!isRole(role)) throw new UserAdminError("Perfil inválido");
  return { name, email, role };
}

/**
 * Impede que a administração se tranque para fora.
 *
 * Dois casos: alguém desativar ou rebaixar a própria conta (o botão está ali,
 * um clique distraído basta), e a última conta capaz de gerenciar usuários
 * perder essa capacidade — a partir daí ninguém mais consegue conceder acesso
 * a ninguém, e só restaria mexer no banco na mão.
 */
export async function assertNotLockout(
  repository: UserAdminRepository,
  actor: AuthenticatedUser,
  targetId: string,
  change: { role?: string; active?: boolean },
) {
  if (actor.id === targetId) {
    if (change.active === false) throw new UserAdminError("Você não pode desativar a própria conta", 403);
    if (change.role && !can(change.role as Role, "users.manage")) throw new UserAdminError("Você não pode remover a própria permissão de gerenciar usuários", 403);
  }
  const losingManage = change.active === false || (change.role !== undefined && !can(change.role as Role, "users.manage"));
  if (!losingManage) return;
  const remaining = (await repository.list()).filter((user) =>
    user.id !== targetId && user.active && isRole(user.role) && can(user.role, "users.manage"));
  if (remaining.length === 0) throw new UserAdminError("Esta é a última conta capaz de gerenciar usuários — deixaria o sistema sem administrador", 409);
}

/** Devolve a senha em texto puro **uma vez**. Nunca é persistida nem registrada. */
export async function createUser(repository: UserAdminRepository, input: { name: string; email: string; role: string }) {
  if (await repository.findByEmail(input.email)) throw new UserAdminError("Já existe uma conta com este e-mail", 409);
  const password = randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url");
  const { hash, salt } = await hashPassword(password);
  const id = randomUUID();
  await repository.insert({ id, ...input, passwordHash: hash, passwordSalt: salt });
  return { user: { id, ...input, active: true }, password };
}

export async function resetPassword(repository: UserAdminRepository, targetId: string) {
  const target = await repository.findById(targetId);
  if (!target) throw new UserAdminError("Conta não encontrada", 404);
  const password = randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url");
  const { hash, salt } = await hashPassword(password);
  await repository.update(targetId, { passwordHash: hash, passwordSalt: salt });
  return { user: target, password };
}

export async function setActive(repository: UserAdminRepository, actor: AuthenticatedUser, targetId: string, active: boolean) {
  const target = await repository.findById(targetId);
  if (!target) throw new UserAdminError("Conta não encontrada", 404);
  await assertNotLockout(repository, actor, targetId, { active });
  await repository.update(targetId, { active });
  return { ...target, active };
}

export async function setRole(repository: UserAdminRepository, actor: AuthenticatedUser, targetId: string, role: string) {
  if (!isRole(role)) throw new UserAdminError("Perfil inválido");
  const target = await repository.findById(targetId);
  if (!target) throw new UserAdminError("Conta não encontrada", 404);
  await assertNotLockout(repository, actor, targetId, { role });
  await repository.update(targetId, { role });
  return { ...target, role };
}

const toAdminUser = (row: Record<string, unknown>): AdminUser => ({
  id: String(row.id), name: String(row.name), email: String(row.email),
  role: String(row.role), active: row.active !== false,
});

export class DbUserAdminRepository implements UserAdminRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }
  private select() { return this.db.select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active }).from(users); }
  async list() { return (await this.select()).map(toAdminUser); }
  async findById(id: string) { const rows = await this.select().where(eq(users.id, id)).limit(1); return rows[0] ? toAdminUser(rows[0]) : undefined; }
  async findByEmail(email: string) { const rows = await this.select().where(eq(users.email, email)).limit(1); return rows[0] ? toAdminUser(rows[0]) : undefined; }
  async insert(user: { id: string; name: string; email: string; role: string; passwordHash: string; passwordSalt: string }) {
    const now = new Date().toISOString();
    await this.db.insert(users).values({ ...user, active: true, lastLoginAt: null, createdAt: now, updatedAt: now });
  }
  async update(id: string, patch: { role?: string; active?: boolean; passwordHash?: string; passwordSalt?: string }) {
    await this.db.update(users).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(users.id, id));
  }
}

export class MemoryUserAdminRepository implements UserAdminRepository {
  readonly rows: Array<AdminUser & { passwordHash: string; passwordSalt: string }> = [];
  async list() { return this.rows.map(({ id, name, email, role, active }) => ({ id, name, email, role, active })); }
  async findById(id: string) { return (await this.list()).find((user) => user.id === id); }
  async findByEmail(email: string) { return (await this.list()).find((user) => user.email === email); }
  async insert(user: { id: string; name: string; email: string; role: string; passwordHash: string; passwordSalt: string }) { this.rows.push({ ...user, active: true }); }
  async update(id: string, patch: { role?: string; active?: boolean; passwordHash?: string; passwordSalt?: string }) {
    const row = this.rows.find((item) => item.id === id);
    if (row) Object.assign(row, patch);
  }
}
