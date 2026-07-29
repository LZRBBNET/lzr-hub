import assert from "node:assert/strict";
import test from "node:test";
import { fetchIxcSystemUsers } from "../lib/integrations/ixc/system-users.ts";
import {
  DEFAULT_ROLE,
  MemoryUserProvisioningRepository,
  parseGroupRoleMap,
  resolveRole,
  syncIxcUsers,
} from "../lib/platform/ixc-user-sync.ts";

const user = (over = {}) => ({ ixcId: "1", name: "Fulano", email: "fulano@bbnet.com.br", groupId: "4", active: true, ...over });

function fakeIxc(registros, total = registros.length) {
  return async () => new Response(JSON.stringify({ page: "1", total: String(total), registros }), { status: 200 });
}

test("o hash de senha do IXC nunca sai do cliente", async () => {
  const rows = [{ id: "1", nome: "Breno", email: "breno@bbnet.com.br", id_grupo: "13", status: "A", senha: "e987049e8dfac7fb", acesso_webservice: "N" }];
  const [result] = await fetchIxcSystemUsers({ baseUrl: "https://ponte", token: "t", fetcher: fakeIxc(rows) });
  assert.deepEqual(Object.keys(result).sort(), ["active", "email", "groupId", "ixcId", "name"]);
  assert.ok(!JSON.stringify(result).includes("e987049e8dfac7fb"), "hash de senha não pode vazar");
});

test("usuário sem e-mail válido é ignorado", async () => {
  const rows = [
    { id: "1", nome: "Sem email", email: "", id_grupo: "4", status: "A" },
    { id: "2", nome: "Invalido", email: "nao-e-email", id_grupo: "4", status: "A" },
    { id: "3", nome: "Ok", email: "ok@bbnet.com.br", id_grupo: "4", status: "A" },
  ];
  const result = await fetchIxcSystemUsers({ baseUrl: "https://ponte", token: "t", fetcher: fakeIxc(rows) });
  assert.equal(result.length, 1);
  assert.equal(result[0].email, "ok@bbnet.com.br");
});

test("status do IXC vira ativo/inativo", async () => {
  const rows = [
    { id: "1", nome: "Ativo", email: "a@bbnet.com.br", id_grupo: "4", status: "A" },
    { id: "2", nome: "Inativo", email: "i@bbnet.com.br", id_grupo: "4", status: "I" },
  ];
  const result = await fetchIxcSystemUsers({ baseUrl: "https://ponte", token: "t", fetcher: fakeIxc(rows) });
  assert.equal(result.find((item) => item.email === "a@bbnet.com.br").active, true);
  assert.equal(result.find((item) => item.email === "i@bbnet.com.br").active, false);
});

test("mapa de grupos ignora papel inválido em vez de conceder acesso amplo", () => {
  const map = parseGroupRoleMap('{"13":"Administrador","4":"Atendente","9":"PapelInventado"}');
  assert.deepEqual(map, { 13: "Administrador", 4: "Atendente" });
  assert.deepEqual(parseGroupRoleMap("nao é json"), {});
  assert.deepEqual(parseGroupRoleMap(undefined), {});
});

test("grupo não mapeado cai no papel mais restrito", () => {
  const map = { 13: "Administrador" };
  assert.equal(resolveRole("13", map), "Administrador");
  assert.equal(resolveRole("4", map), DEFAULT_ROLE);
  assert.equal(resolveRole("", map), DEFAULT_ROLE);
  assert.equal(DEFAULT_ROLE, "Somente leitura");
});

test("cria contas novas com o papel do grupo", async () => {
  const repository = new MemoryUserProvisioningRepository();
  const summary = await syncIxcUsers(
    [user({ email: "breno@bbnet.com.br", groupId: "13" }), user({ email: "atendente@bbnet.com.br", groupId: "4" })],
    repository,
    { groupRoles: { 13: "Administrador", 4: "Atendente" } },
  );
  assert.equal(summary.created, 2);
  assert.equal(repository.rows.find((row) => row.email === "breno@bbnet.com.br").role, "Administrador");
  assert.equal(repository.rows.find((row) => row.email === "atendente@bbnet.com.br").role, "Atendente");
});

test("conta inativa no IXC não vira conta nova", async () => {
  const repository = new MemoryUserProvisioningRepository();
  const summary = await syncIxcUsers([user({ active: false })], repository, { groupRoles: {} });
  assert.equal(summary.created, 0);
  assert.equal(repository.rows.length, 0);
});

test("desativar no IXC desativa aqui", async () => {
  const repository = new MemoryUserProvisioningRepository();
  await syncIxcUsers([user()], repository, { groupRoles: {} });
  assert.equal(repository.rows[0].active, true);

  const summary = await syncIxcUsers([user({ active: false })], repository, { groupRoles: {} });
  assert.equal(summary.deactivated, 1);
  assert.equal(repository.rows[0].active, false);
});

test("mudança de grupo no IXC muda o papel aqui", async () => {
  const repository = new MemoryUserProvisioningRepository();
  await syncIxcUsers([user({ groupId: "4" })], repository, { groupRoles: { 4: "Atendente", 7: "Cobrança" } });
  assert.equal(repository.rows[0].role, "Atendente");

  await syncIxcUsers([user({ groupId: "7" })], repository, { groupRoles: { 4: "Atendente", 7: "Cobrança" } });
  assert.equal(repository.rows[0].role, "Cobrança");
});

test("conta protegida não é alterada pela sincronização", async () => {
  const repository = new MemoryUserProvisioningRepository();
  await repository.createUser({ email: "admin@bbnet.com.br", name: "Admin Local", role: "Administrador" });

  const summary = await syncIxcUsers(
    [user({ email: "admin@bbnet.com.br", groupId: "4", name: "Nome do IXC" })],
    repository,
    { groupRoles: { 4: "Somente leitura" }, protectedEmails: ["ADMIN@bbnet.com.br"] },
  );
  assert.equal(summary.skippedProtected, 1);
  assert.equal(repository.rows[0].role, "Administrador", "o administrador local não pode ser rebaixado");
  assert.equal(repository.rows[0].name, "Admin Local");
});

test("sincronizar duas vezes não duplica nem marca mudança à toa", async () => {
  const repository = new MemoryUserProvisioningRepository();
  await syncIxcUsers([user()], repository, { groupRoles: {} });
  const summary = await syncIxcUsers([user()], repository, { groupRoles: {} });
  assert.equal(repository.rows.length, 1);
  assert.equal(summary.created, 0);
  assert.equal(summary.updated, 0);
});

test("grupos sem mapeamento são reportados para o administrador ajustar", async () => {
  const repository = new MemoryUserProvisioningRepository();
  const summary = await syncIxcUsers(
    [user({ email: "a@bbnet.com.br", groupId: "4" }), user({ email: "b@bbnet.com.br", groupId: "15" })],
    repository,
    { groupRoles: { 4: "Atendente" } },
  );
  assert.deepEqual(summary.unmappedGroups, ["15"]);
});
