import test from "node:test";
import assert from "node:assert/strict";
import { verifyPassword } from "../lib/platform/auth.ts";
import {
  MemoryUserAdminRepository, UserAdminError, createUser, parseNewUser, resetPassword, setActive, setRole,
} from "../lib/platform/user-admin.ts";

const actor = (id, role = "Administrador") => ({ id, email: `${id}@bbnet.com`, name: id, role });

async function repositoryWith(...people) {
  const repository = new MemoryUserAdminRepository();
  for (const [name, role] of people) await createUser(repository, { name, email: `${name}@bbnet.com`, role });
  return repository;
}
const idOf = async (repository, name) => (await repository.findByEmail(`${name}@bbnet.com`)).id;

test("conta nova recebe senha gerada, guardada só como hash", async () => {
  const repository = new MemoryUserAdminRepository();
  const { user, password } = await createUser(repository, { name: "Ana", email: "ana@bbnet.com", role: "Atendente" });

  assert.ok(password.length >= 12, "a senha é gerada pelo sistema, não escolhida às pressas");
  assert.equal(user.active, true);
  const stored = repository.rows.find((row) => row.id === user.id);
  assert.ok(!Object.values(stored).includes(password), "a senha em texto puro não é persistida");
  assert.equal(await verifyPassword(password, stored.passwordHash, stored.passwordSalt), true);
});

test("e-mail repetido é recusado em vez de criar conta sombra", async () => {
  const repository = await repositoryWith(["ana", "Atendente"]);
  await assert.rejects(() => createUser(repository, { name: "Outra", email: "ana@bbnet.com", role: "Suporte" }), UserAdminError);
});

test("entrada inválida não chega ao banco", () => {
  assert.throws(() => parseNewUser({ name: "Jo", email: "a@b.com", role: "Atendente" }), UserAdminError);
  assert.throws(() => parseNewUser({ name: "Ana Lima", email: "sem-arroba", role: "Atendente" }), UserAdminError);
  assert.throws(() => parseNewUser({ name: "Ana Lima", email: "a@b.com", role: "Chefe Supremo" }), UserAdminError);
  assert.deepEqual(parseNewUser({ name: " Ana Lima ", email: " ANA@BBNET.COM ", role: "Atendente" }), { name: "Ana Lima", email: "ana@bbnet.com", role: "Atendente" });
});

test("ninguém desativa nem rebaixa a própria conta", async () => {
  const repository = await repositoryWith(["vini", "Administrador"], ["breno", "Administrador"]);
  const vini = await idOf(repository, "vini");

  await assert.rejects(() => setActive(repository, actor(vini), vini, false), /própria conta/);
  await assert.rejects(() => setRole(repository, actor(vini), vini, "Atendente"), /própria permissão/);
  // Rebaixar para outro perfil que ainda gerencia usuários continua permitido.
  assert.equal((await setRole(repository, actor(vini), vini, "Administrador")).role, "Administrador");
});

test("a última conta que gerencia usuários não pode perder o acesso", async () => {
  const repository = await repositoryWith(["vini", "Administrador"], ["ana", "Atendente"]);
  const vini = await idOf(repository, "vini");
  const ana = await idOf(repository, "ana");

  // Ana age sobre Vini: mesmo sendo outra pessoa, o sistema ficaria sem administrador.
  await assert.rejects(() => setActive(repository, actor(ana, "Atendente"), vini, false), /sem administrador/);
  await assert.rejects(() => setRole(repository, actor(ana, "Atendente"), vini, "Suporte"), /sem administrador/);

  // Com um segundo administrador, a mesma ação passa a ser permitida.
  await createUser(repository, { name: "breno", email: "breno@bbnet.com", role: "Administrador" });
  assert.equal((await setActive(repository, actor(ana, "Atendente"), vini, false)).active, false);
});

test("conta desativada não conta como administrador restante", async () => {
  const repository = await repositoryWith(["vini", "Administrador"], ["breno", "Administrador"]);
  const vini = await idOf(repository, "vini");
  const breno = await idOf(repository, "breno");
  await setActive(repository, actor(breno), vini, false);

  await assert.rejects(() => setActive(repository, actor(vini), breno, false), /sem administrador/);
});

test("resetar senha gera outra e invalida a anterior", async () => {
  const repository = new MemoryUserAdminRepository();
  const { user, password } = await createUser(repository, { name: "Ana", email: "ana@bbnet.com", role: "Atendente" });
  const { password: novaSenha } = await resetPassword(repository, user.id);

  assert.notEqual(novaSenha, password);
  const stored = repository.rows.find((row) => row.id === user.id);
  assert.equal(await verifyPassword(novaSenha, stored.passwordHash, stored.passwordSalt), true);
  assert.equal(await verifyPassword(password, stored.passwordHash, stored.passwordSalt), false, "a senha antiga precisa parar de valer");
});

test("agir sobre conta inexistente falha com 404, não em silêncio", async () => {
  const repository = new MemoryUserAdminRepository();
  await assert.rejects(() => resetPassword(repository, "nao-existe"), (error) => error.status === 404);
  await assert.rejects(() => setActive(repository, actor("x"), "nao-existe", false), (error) => error.status === 404);
});

test("senha definida por terceiro nasce provisória", async () => {
  const repository = new MemoryUserAdminRepository();
  const { user } = await createUser(repository, { name: "Ana", email: "ana@bbnet.com", role: "Atendente" });
  assert.equal(repository.rows.find((row) => row.id === user.id).mustChangePassword, true, "conta nova exige definir a senha no primeiro acesso");

  // Marca o contrário para provar que o reset volta a exigir a troca.
  await repository.update(user.id, {});
  repository.rows.find((row) => row.id === user.id).mustChangePassword = false;

  await resetPassword(repository, user.id);
  assert.equal(repository.rows.find((row) => row.id === user.id).mustChangePassword, true, "senha que o admin conhece não pode ficar valendo");
});
