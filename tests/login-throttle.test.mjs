import test from "node:test";
import assert from "node:assert/strict";
import { EMAIL_RULE, IP_RULE, LoginThrottle } from "../lib/platform/login-throttle.ts";
import { MemoryPasswordResetRepository, parseResetRequest } from "../lib/platform/password-reset.ts";

/** Relógio controlado: o freio depende de tempo e não pode ser testado com espera real. */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test("força bruta na mesma conta é travada depois de poucas tentativas", () => {
  const time = clock();
  const throttle = new LoginThrottle(time.now);

  for (let attempt = 0; attempt < EMAIL_RULE.max; attempt += 1) {
    assert.equal(throttle.retryAfterSeconds("ana@bbnet.com", "1.1.1.1"), 0, `tentativa ${attempt + 1} ainda passa`);
    throttle.recordFailure("ana@bbnet.com", "1.1.1.1");
  }
  assert.ok(throttle.retryAfterSeconds("ana@bbnet.com", "1.1.1.1") > 0, "a seguinte é barrada");
});

test("a trava solta sozinha quando a janela passa", () => {
  const time = clock();
  const throttle = new LoginThrottle(time.now);
  for (let attempt = 0; attempt < EMAIL_RULE.max; attempt += 1) throttle.recordFailure("ana@bbnet.com", "1.1.1.1");

  assert.ok(throttle.retryAfterSeconds("ana@bbnet.com", "1.1.1.1") > 0);
  time.advance(EMAIL_RULE.windowMs + 1000);
  assert.equal(throttle.retryAfterSeconds("ana@bbnet.com", "1.1.1.1"), 0, "ninguém fica bloqueado para sempre");
});

test("varredura de muitas contas do mesmo IP também é travada", () => {
  const time = clock();
  const throttle = new LoginThrottle(time.now);
  // Uma senha em cada e-mail nunca estoura o limite por conta — quem pega é o de IP.
  for (let index = 0; index < IP_RULE.max; index += 1) throttle.recordFailure(`pessoa${index}@bbnet.com`, "9.9.9.9");

  assert.ok(throttle.retryAfterSeconds("outra@bbnet.com", "9.9.9.9") > 0, "o IP esgotou a cota");
  assert.equal(throttle.retryAfterSeconds("outra@bbnet.com", "2.2.2.2"), 0, "outro IP não é punido junto");
});

test("acertar a senha devolve a cota da conta", () => {
  const time = clock();
  const throttle = new LoginThrottle(time.now);
  for (let attempt = 0; attempt < EMAIL_RULE.max; attempt += 1) throttle.recordFailure("ana@bbnet.com", "1.1.1.1");
  assert.ok(throttle.retryAfterSeconds("ana@bbnet.com", "1.1.1.1") > 0);

  throttle.clear("ana@bbnet.com");
  assert.equal(throttle.retryAfterSeconds("ana@bbnet.com", "1.1.1.1"), 0, "o dono que errou e acertou não fica travado");
});

test("o e-mail é normalizado: caixa alta não escapa do freio", () => {
  const time = clock();
  const throttle = new LoginThrottle(time.now);
  for (let attempt = 0; attempt < EMAIL_RULE.max; attempt += 1) throttle.recordFailure("ana@bbnet.com", "1.1.1.1");
  assert.ok(throttle.retryAfterSeconds("  ANA@BBNET.COM ", "1.1.1.1") > 0);
});

test("pedido de recuperação aceita e-mail sem conta, e não duplica o pendente", async () => {
  const repository = new MemoryPasswordResetRepository();
  // Aceitar só e-mail existente transformaria a tela num verificador de contas.
  await repository.create("ninguem@bbnet.com", null);
  assert.equal((await repository.listPending(10)).length, 1);

  await repository.create("ninguem@bbnet.com", "de novo");
  assert.equal((await repository.listPending(10)).length, 1, "clicar duas vezes não vira fila");
});

test("pedido resolvido sai da lista de pendentes", async () => {
  const repository = new MemoryPasswordResetRepository();
  await repository.create("ana@bbnet.com", null);
  const [pendente] = await repository.listPending(10);

  await repository.resolve(pendente.id, "vini@bbnet.com", "resolved");
  assert.deepEqual(await repository.listPending(10), []);
  assert.equal(repository.requests[0].resolvedBy, "vini@bbnet.com", "fica registrado quem resolveu");
});

test("entrada do pedido é validada sem revelar nada", () => {
  assert.equal(parseResetRequest({ email: "sem-arroba" }), undefined);
  assert.deepEqual(parseResetRequest({ email: " ANA@BBNET.COM " }), { email: "ana@bbnet.com", note: null });
  const longa = parseResetRequest({ email: "a@b.com", note: "x".repeat(500) });
  assert.equal(longa.note.length, 300, "recado é cortado, não recusado");
});
