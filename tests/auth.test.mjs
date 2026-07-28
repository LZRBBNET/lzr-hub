import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryAuthRepository,
  SESSION_COOKIE,
  generateSessionToken,
  hashPassword,
  hashToken,
  login,
  logout,
  resolveSession,
  verifyPassword,
} from "../lib/platform/auth.ts";
import { can } from "../lib/platform/rbac.ts";

test("senha é verificada pelo hash e recusa a errada", async () => {
  const { hash, salt } = await hashPassword("senha-forte-123");
  assert.equal(await verifyPassword("senha-forte-123", hash, salt), true);
  assert.equal(await verifyPassword("senha-errada", hash, salt), false);
});

test("a mesma senha gera hashes diferentes (salt por usuário)", async () => {
  const a = await hashPassword("mesma-senha");
  const b = await hashPassword("mesma-senha");
  assert.notEqual(a.hash, b.hash);
  assert.notEqual(a.salt, b.salt);
});

test("o banco guarda só o hash do token, nunca o token da sessão", async () => {
  const repository = new MemoryAuthRepository();
  await repository.addUser("ana@bbnet.com", "senha-boa-1", "Administrador");
  const result = await login(repository, "ana@bbnet.com", "senha-boa-1");
  assert.ok(result);
  assert.ok(!repository.sessions.has(result.token), "token puro não pode estar no banco");
  assert.ok(repository.sessions.has(hashToken(result.token)), "o que fica guardado é o hash");
});

test("login recusa senha errada, e-mail inexistente e conta inativa", async () => {
  const repository = new MemoryAuthRepository();
  await repository.addUser("ana@bbnet.com", "senha-boa-1", "Atendente");
  await repository.addUser("inativo@bbnet.com", "senha-boa-1", "Atendente", "Inativo", false);

  assert.equal(await login(repository, "ana@bbnet.com", "errada"), undefined);
  assert.equal(await login(repository, "naoexiste@bbnet.com", "senha-boa-1"), undefined);
  assert.equal(await login(repository, "inativo@bbnet.com", "senha-boa-1"), undefined);
});

test("e-mail é tratado sem diferenciar maiúsculas", async () => {
  const repository = new MemoryAuthRepository();
  await repository.addUser("ana@bbnet.com", "senha-boa-1", "Atendente");
  assert.ok(await login(repository, "  ANA@BBnet.com  ", "senha-boa-1"));
});

test("sessão válida identifica o usuário e o papel", async () => {
  const repository = new MemoryAuthRepository();
  await repository.addUser("sup@bbnet.com", "senha-boa-1", "Supervisor", "Supervisora");
  const result = await login(repository, "sup@bbnet.com", "senha-boa-1");
  const user = await resolveSession(repository, result.token);
  assert.equal(user?.email, "sup@bbnet.com");
  assert.equal(user?.role, "Supervisor");
  assert.equal(user?.name, "Supervisora");
});

test("sessão expirada é recusada e removida", async () => {
  const repository = new MemoryAuthRepository();
  const user = await repository.addUser("ana@bbnet.com", "senha-boa-1", "Atendente");
  const token = generateSessionToken();
  await repository.createSession(hashToken(token), user.id, new Date(Date.now() - 1000).toISOString());

  assert.equal(await resolveSession(repository, token), undefined);
  assert.equal(repository.sessions.has(hashToken(token)), false, "sessão expirada não fica no banco");
});

test("token inválido ou ausente não abre sessão", async () => {
  const repository = new MemoryAuthRepository();
  assert.equal(await resolveSession(repository, undefined), undefined);
  assert.equal(await resolveSession(repository, "token-inventado"), undefined);
});

test("logout invalida a sessão imediatamente", async () => {
  const repository = new MemoryAuthRepository();
  await repository.addUser("ana@bbnet.com", "senha-boa-1", "Atendente");
  const result = await login(repository, "ana@bbnet.com", "senha-boa-1");
  assert.ok(await resolveSession(repository, result.token));

  await logout(repository, result.token);
  assert.equal(await resolveSession(repository, result.token), undefined);
});

test("usuário desativado depois do login perde a sessão", async () => {
  const repository = new MemoryAuthRepository();
  const user = await repository.addUser("ana@bbnet.com", "senha-boa-1", "Atendente");
  const result = await login(repository, "ana@bbnet.com", "senha-boa-1");
  user.active = false;
  assert.equal(await resolveSession(repository, result.token), undefined);
});

test("RBAC bloqueia ação fora do papel", () => {
  assert.equal(can("Atendente", "knowledge.publish"), false, "atendente não publica conhecimento");
  assert.equal(can("Analista", "knowledge.publish"), false);
  assert.equal(can("Supervisor", "knowledge.publish"), true);
  assert.equal(can("Administrador", "users.manage"), true);
  assert.equal(can("Somente leitura", "support.write"), false);
});

test("nome do cookie de sessão é estável", () => {
  assert.equal(SESSION_COOKIE, "lzr_session");
});
