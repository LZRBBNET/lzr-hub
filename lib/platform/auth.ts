import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import { sessions, users } from "../../db/schema.ts";
import { roles, type Role } from "./rbac.ts";

const scryptAsync = promisify(scrypt);

export const SESSION_COOKIE = "lzr_session";
export const SESSION_TTL_HOURS = 12;
const KEY_LENGTH = 64;

export interface AuthenticatedUser { id: string; email: string; name: string; role: Role }
/** Marca que a senha atual foi gerada pelo sistema e precisa ser trocada. */
export interface WithPasswordFlag { mustChangePassword: boolean }

export function isRole(value: string): value is Role {
  return (roles as readonly string[]).includes(value);
}

/** scrypt vem do Node — evita dependência nativa (bcrypt/argon2) que complica o build. */
export async function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return { hash: derived.toString("hex"), salt };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  // Comparação de tempo constante: não vaza quanto do hash bateu.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<{ id: string; email: string; name: string; role: string; passwordHash: string; passwordSalt: string; active: boolean; mustChangePassword?: boolean } | undefined>;
  createSession(tokenHash: string, userId: string, expiresAtIso: string): Promise<void>;
  findSession(tokenHash: string): Promise<{ userId: string; expiresAt: string } | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteExpiredSessions(nowIso: string): Promise<void>;
  /** Encerra as outras sessões da pessoa, preservando a atual. */
  deleteOtherSessions(userId: string, keepTokenHash: string): Promise<void>;
  updatePassword(userId: string, hash: string, salt: string, mustChangePassword?: boolean): Promise<void>;
  findUserById(id: string): Promise<{ id: string; email: string; name: string; role: string; active: boolean; mustChangePassword?: boolean } | undefined>;
  markLogin(userId: string, atIso: string): Promise<void>;
}

export interface LoginResult { token: string; expiresAt: string; user: AuthenticatedUser; mustChangePassword: boolean }

/**
 * Autentica e abre sessão. Retorna undefined para qualquer falha (e-mail
 * inexistente, senha errada, conta inativa) — quem chama não deve distinguir
 * os casos na resposta, para não revelar quais e-mails existem.
 */
export async function login(
  repository: AuthRepository,
  email: string,
  password: string,
): Promise<LoginResult | undefined> {
  const user = await repository.findUserByEmail(email.trim().toLowerCase());
  if (!user || !user.active) {
    // Gasta o mesmo tempo de um login válido para não vazar existência por timing.
    await hashPassword(password);
    return undefined;
  }
  if (!await verifyPassword(password, user.passwordHash, user.passwordSalt)) return undefined;
  if (!isRole(user.role)) return undefined;

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
  await repository.createSession(hashToken(token), user.id, expiresAt);
  await repository.markLogin(user.id, new Date().toISOString());

  return { token, expiresAt, user: { id: user.id, email: user.email, name: user.name, role: user.role }, mustChangePassword: user.mustChangePassword === true };
}

export async function resolveSession(
  repository: AuthRepository,
  token: string | undefined,
): Promise<AuthenticatedUser | undefined> {
  if (!token) return undefined;
  const tokenHash = hashToken(token);
  const session = await repository.findSession(tokenHash);
  if (!session) return undefined;
  if (session.expiresAt <= new Date().toISOString()) {
    await repository.deleteSession(tokenHash);
    return undefined;
  }
  const user = await repository.findUserById(session.userId);
  if (!user || !user.active || !isRole(user.role)) return undefined;
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export async function logout(repository: AuthRepository, token: string | undefined): Promise<void> {
  if (token) await repository.deleteSession(hashToken(token));
}

export class DbAuthRepository implements AuthRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async findUserByEmail(email: string) {
    const rows = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    return rows[0];
  }
  async findUserById(id: string) {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0];
  }
  async createSession(tokenHash: string, userId: string, expiresAtIso: string) {
    await this.db.insert(sessions).values({ tokenHash, userId, expiresAt: expiresAtIso, createdAt: new Date().toISOString() });
  }
  async findSession(tokenHash: string) {
    const rows = await this.db.select().from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date().toISOString()))).limit(1);
    return rows[0];
  }
  async deleteSession(tokenHash: string) {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }
  async deleteOtherSessions(userId: string, keepTokenHash: string) {
    await this.db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, keepTokenHash)));
  }
  async updatePassword(userId: string, hash: string, salt: string, mustChangePassword = false) {
    await this.db.update(users).set({ passwordHash: hash, passwordSalt: salt, mustChangePassword, updatedAt: new Date().toISOString() }).where(eq(users.id, userId));
  }
  async deleteExpiredSessions(nowIso: string) {
    await this.db.delete(sessions).where(lt(sessions.expiresAt, nowIso));
  }
  async markLogin(userId: string, atIso: string) {
    await this.db.update(users).set({ lastLoginAt: atIso, updatedAt: atIso }).where(eq(users.id, userId));
  }
}

export class MemoryAuthRepository implements AuthRepository {
  readonly users: Array<{ id: string; email: string; name: string; role: string; passwordHash: string; passwordSalt: string; active: boolean; mustChangePassword?: boolean; lastLoginAt?: string }> = [];
  readonly sessions = new Map<string, { userId: string; expiresAt: string }>();

  async addUser(email: string, password: string, role: Role, name = email, active = true, mustChangePassword = false) {
    const { hash, salt } = await hashPassword(password);
    const user = { id: randomUUID(), email: email.toLowerCase(), name, role, passwordHash: hash, passwordSalt: salt, active, mustChangePassword };
    this.users.push(user);
    return user;
  }
  async findUserByEmail(email: string) { return this.users.find((item) => item.email === email); }
  async findUserById(id: string) { return this.users.find((item) => item.id === id); }
  async createSession(tokenHash: string, userId: string, expiresAtIso: string) { this.sessions.set(tokenHash, { userId, expiresAt: expiresAtIso }); }
  async findSession(tokenHash: string) { return this.sessions.get(tokenHash); }
  async deleteSession(tokenHash: string) { this.sessions.delete(tokenHash); }
  async deleteExpiredSessions(nowIso: string) {
    for (const [key, value] of this.sessions) if (value.expiresAt < nowIso) this.sessions.delete(key);
  }
  async deleteOtherSessions(userId: string, keepTokenHash: string) {
    for (const [key, value] of this.sessions) if (value.userId === userId && key !== keepTokenHash) this.sessions.delete(key);
  }
  async updatePassword(userId: string, hash: string, salt: string, mustChangePassword = false) {
    const user = this.users.find((item) => item.id === userId);
    if (user) { user.passwordHash = hash; user.passwordSalt = salt; user.mustChangePassword = mustChangePassword; }
  }
  async markLogin(userId: string, atIso: string) {
    const user = this.users.find((item) => item.id === userId);
    if (user) user.lastLoginAt = atIso;
  }
}

export const MIN_PASSWORD_LENGTH = 10;

export class PasswordChangeError extends Error {
  constructor(message: string) { super(message); this.name = "PasswordChangeError"; }
}

/**
 * Troca de senha pela própria pessoa.
 *
 * Exige a senha atual: sem isso, um cookie roubado viraria posse permanente da
 * conta — o invasor trocaria a senha e trancaria o dono para fora. E ao trocar,
 * as **outras** sessões caem, preservando só a que fez a troca: se a conta
 * estava comprometida, trocar a senha precisa expulsar quem estava dentro.
 */
export async function changeOwnPassword(
  repository: AuthRepository,
  userId: string,
  currentToken: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) throw new PasswordChangeError(`A nova senha precisa de pelo menos ${MIN_PASSWORD_LENGTH} caracteres`);
  if (newPassword === currentPassword) throw new PasswordChangeError("A nova senha precisa ser diferente da atual");

  const user = await repository.findUserByEmail((await repository.findUserById(userId))?.email ?? "");
  if (!user || !user.active) throw new PasswordChangeError("Conta indisponível");
  if (!(await verifyPassword(currentPassword, user.passwordHash, user.passwordSalt))) {
    throw new PasswordChangeError("Senha atual incorreta");
  }

  const { hash, salt } = await hashPassword(newPassword);
  await repository.updatePassword(userId, hash, salt, false);
  await repository.deleteOtherSessions(userId, hashToken(currentToken));
}

/**
 * Lista de contas para a tela de Usuários. Nunca traz hash nem salt: a tela é
 * de leitura e não precisa deles, e o que não sai daqui não vaza num log.
 * Usuários são criados por `scripts/create-user.mjs` — não há cadastro na tela.
 */
export interface UserListItem { id: string; name: string; email: string; role: string; active: boolean; mustChangePassword: boolean; lastLoginAt: string | null; createdAt: string }

export async function listUsers(db: unknown): Promise<UserListItem[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (db as any).select({
    id: users.id, name: users.name, email: users.email, role: users.role,
    active: users.active, mustChangePassword: users.mustChangePassword, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt,
  }).from(users).orderBy(users.createdAt);
  return rows as UserListItem[];
}
