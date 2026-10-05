import test from "node:test";
import assert from "node:assert/strict";
import { classifyAddressNumber, evaluateContact } from "../lib/platform/contract-audit-shared.ts";
import {
  BASELINE_CONTRACTS, MAX_IXC_CALLS_PER_RUN, MemoryContractAuditRepository, RECHECK_WINDOW_DAYS,
  contractFromRow, nextRecord, recheckContract, runContractAudit, stopReason,
} from "../lib/platform/contract-audit-service.ts";

/* ------------------------------------------------------------ regras --- */

test("Número do endereço: só SN ou um número de verdade", () => {
  assert.equal(classifyAddressNumber("SN"), "sn");
  assert.equal(classifyAddressNumber(" sn "), "sn");
  assert.equal(classifyAddressNumber("123"), "numero");
  assert.equal(classifyAddressNumber("12A"), "numero");
  assert.equal(classifyAddressNumber("KM 5"), "numero");
  assert.equal(classifyAddressNumber("10"), "numero", "zero no meio de um número é número");
  // Medido na base real: o zero aparece como "00" e "000", não só "0".
  for (const zero of ["0", "00", "000"]) assert.equal(classifyAddressNumber(zero), "zero", zero);
  assert.equal(classifyAddressNumber(""), "vazio");
  assert.equal(classifyAddressNumber(undefined), "vazio");
  for (const grafia of ["S/N", "s/n", "S.N.", "sem numero", "-"]) assert.equal(classifyAddressNumber(grafia), "fora_do_padrao", grafia);
});

const completo = { mobile: "(79) 99830-7232", whatsapp: "", email: "ana@bbnet.com.br", addressNumber: "120" };

test("cadastro completo não tem pendência", () => {
  assert.deepEqual(evaluateContact(completo), []);
  assert.deepEqual(evaluateContact({ ...completo, addressNumber: "SN" }), []);
});

test("celular ou WhatsApp: um dos dois basta", () => {
  assert.deepEqual(evaluateContact({ ...completo, mobile: "", whatsapp: "(79) 99830-7232" }), []);
  assert.deepEqual(evaluateContact({ ...completo, mobile: "", whatsapp: "" }).map((i) => i.code), ["sem_celular"]);
  assert.deepEqual(evaluateContact({ ...completo, mobile: "9983", whatsapp: "" }).map((i) => i.code), ["celular_invalido"], "sem DDD não alcança ninguém");
});

test("e-mail vazio e e-mail que não é e-mail são pendências diferentes", () => {
  assert.deepEqual(evaluateContact({ ...completo, email: "" }).map((i) => i.code), ["sem_email"]);
  assert.deepEqual(evaluateContact({ ...completo, email: "nao tem" }).map((i) => i.code), ["email_invalido"]);
  assert.deepEqual(evaluateContact({ ...completo, email: "ana@bbnet" }).map((i) => i.code), ["email_invalido"]);
});

test("o valor encontrado só é guardado para o Número, nunca para telefone ou e-mail", () => {
  const issues = evaluateContact({ mobile: "123", whatsapp: "", email: "invalido", addressNumber: "000" });
  assert.deepEqual(issues.map((i) => i.code), ["celular_invalido", "email_invalido", "numero_zero"]);
  assert.equal(issues.find((i) => i.code === "numero_zero").found, "000");
  assert.equal(issues.find((i) => i.code === "celular_invalido").found, undefined);
  assert.equal(issues.find((i) => i.code === "email_invalido").found, undefined);
});

test("contrato do IXC: data vazia do IXC e vendedor 0 viram ausência, não dado", () => {
  const contrato = contractFromRow({ id: "61268", id_cliente: "40123", contrato: "FIBRA 600MB ", status: "A", data_cadastro_sistema: "2026-10-05", data: "2026-10-05", id_vendedor: "0" });
  assert.deepEqual(contrato, { id: "61268", customerId: "40123", plan: "FIBRA 600MB", status: "A", createdAt: "2026-10-05", sellerId: null });
  assert.equal(contractFromRow({ id: "61268", id_cliente: "1", data_cadastro_sistema: "0000-00-00", data: "2026-10-04" }).createdAt, "2026-10-04");
  assert.equal(contractFromRow({ id: "abc", id_cliente: "1" }), undefined);
  assert.equal(contractFromRow({ id: "1", id_cliente: "" }), undefined);
});

/* ----------------------------------------------------- transições --- */

const contrato = { id: "100", customerId: "7", plan: "FIBRA", status: "A", createdAt: "2026-10-05", sellerId: null };
const cliente = (over = {}) => ({ id: "7", razao: "ANA LIMA", telefone_celular: "(79) 99830-7232", whatsapp: "", email: "ana@bbnet.com.br", numero: "120", ...over });

test("contrato certo desde o primeiro dia fica 'ok'", () => {
  const record = nextRecord(undefined, contrato, cliente(), "2026-10-05T10:00:00.000Z");
  assert.equal(record.status, "ok");
  assert.equal(record.customerName, "ANA LIMA");
  assert.equal(record.checks, 1);
});

test("contrato que nasce incompleto: pendente, e a falha original fica registrada", () => {
  const primeira = nextRecord(undefined, contrato, cliente({ email: "", numero: "0" }), "2026-10-05T10:00:00.000Z");
  assert.equal(primeira.status, "pending");
  assert.deepEqual(primeira.issues.map((i) => i.code), ["sem_email", "numero_zero"]);
  assert.deepEqual(primeira.firstIssues, primeira.issues);

  const parcial = nextRecord(primeira, contrato, cliente({ email: "", numero: "SN" }), "2026-10-05T11:00:00.000Z");
  assert.equal(parcial.status, "pending");
  assert.deepEqual(parcial.issues.map((i) => i.code), ["sem_email"]);
  assert.deepEqual(parcial.firstIssues.map((i) => i.code), ["sem_email", "numero_zero"], "corrigir depois não apaga o que estava errado");

  const corrigido = nextRecord(parcial, contrato, cliente({ numero: "SN" }), "2026-10-05T12:00:00.000Z");
  assert.equal(corrigido.status, "resolved");
  assert.equal(corrigido.resolvedAt, "2026-10-05T12:00:00.000Z");
  assert.equal(corrigido.checks, 3);
  assert.equal(corrigido.firstCheckedAt, "2026-10-05T10:00:00.000Z");

  const deNovo = nextRecord(corrigido, contrato, cliente({ numero: "SN" }), "2026-10-06T09:00:00.000Z");
  assert.equal(deNovo.resolvedAt, "2026-10-05T12:00:00.000Z", "a data da correção é a primeira vez que ficou certo");

  const regrediu = nextRecord(corrigido, contrato, cliente({ email: "" }), "2026-10-07T09:00:00.000Z");
  assert.equal(regrediu.status, "pending", "alguém apagou o e-mail depois: volta a pendente");
  assert.equal(regrediu.resolvedAt, null);
});

test("cadastro não encontrado não vira pendência inventada", () => {
  const record = nextRecord(undefined, contrato, undefined, "2026-10-05T10:00:00.000Z");
  assert.equal(record.status, "unverified");
  assert.deepEqual(record.issues, []);
  const achado = nextRecord(record, contrato, cliente({ email: "" }), "2026-10-05T11:00:00.000Z");
  assert.deepEqual(achado.firstIssues.map((i) => i.code), ["sem_email"], "a primeira conferência de verdade é a que viu o cadastro");
});

test("o registro não guarda telefone nem e-mail do cliente", () => {
  const record = nextRecord(undefined, contrato, cliente({ email: "invalido@", numero: "0" }), "2026-10-05T10:00:00.000Z");
  const json = JSON.stringify(record);
  assert.doesNotMatch(json, /99830/);
  assert.doesNotMatch(json, /invalido@/);
});

/* ------------------------------------------------------------ passada --- */

function ixcFalso({ contracts = [], customers = {}, creators = {} } = {}) {
  const calls = { latest: 0, after: [], customer: [], creator: [] };
  const provider = {
    async getRecordCreator(table, recordId, authorizedCustomerId) {
      calls.creator.push({ table, recordId, authorizedCustomerId });
      const value = creators[recordId];
      if (value instanceof Error) throw value;
      return value === undefined ? { operator: `Atendente ${recordId}`, at: "2026-10-05 10:00:00" } : value;
    },
    async listLatestContracts(limit) { calls.latest += 1; return [...contracts].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, limit); },
    async listContractsAfter(afterId, limit) { calls.after.push(afterId); return contracts.filter((c) => Number(c.id) > afterId).sort((a, b) => Number(a.id) - Number(b.id)).slice(0, limit); },
    async getCustomerRecord(id) {
      calls.customer.push(id);
      const value = customers[id];
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return { provider, calls, contracts, customers, creators };
}
const contratoIxc = (id, cliente) => ({ id: String(id), id_cliente: String(cliente), contrato: "FIBRA", status: "A", data_cadastro_sistema: "2026-10-05" });
const relogio = (iso) => { let now = Date.parse(iso); return () => new Date(now += 1000); };

test("primeira passada parte dos contratos mais recentes e grava o ponto de parada", async () => {
  const ixc = ixcFalso({
    contracts: Array.from({ length: 30 }, (_, i) => contratoIxc(1000 + i, 1)),
    customers: { 1: cliente() },
  });
  const repository = new MemoryContractAuditRepository();
  const resultado = await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T10:00:00Z") }, { trigger: "manual", actor: "ana@bbnet.com.br" });
  assert.equal(ixc.calls.latest, 1);
  assert.equal(resultado.newChecked, BASELINE_CONTRACTS);
  assert.equal(repository.cursor, 1029, "o ponto de parada é o maior id conferido");
  assert.equal(ixc.calls.customer.length, 1, "o mesmo cliente em vários contratos é uma consulta só");
  assert.equal(repository.runs[0].trigger, "manual");
  assert.ok(repository.runs[0].finishedAt);
});

test("as passadas seguintes só leem o que veio depois do ponto de parada", async () => {
  const ixc = ixcFalso({ contracts: [contratoIxc(10, 1), contratoIxc(11, 2)], customers: { 1: cliente(), 2: cliente({ email: "" }) } });
  const repository = new MemoryContractAuditRepository();
  repository.cursor = 10;
  const resultado = await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T10:00:00Z") }, { trigger: "agendado" });
  assert.deepEqual(ixc.calls.after, [10]);
  assert.equal(resultado.newChecked, 1);
  assert.equal(repository.records.get("11").status, "pending");
  assert.equal(repository.records.has("10"), false);
  assert.equal(repository.cursor, 11);
});

test("se o IXC trava no meio, o ponto para no último conferido e nada se perde", async () => {
  const ixc = ixcFalso({
    contracts: [contratoIxc(20, 1), contratoIxc(21, 2), contratoIxc(22, 3)],
    customers: { 1: cliente(), 2: new Error("IXC_RATE_LIMITED"), 3: cliente() },
  });
  const repository = new MemoryContractAuditRepository();
  repository.cursor = 19;
  const primeira = await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T10:00:00Z") }, { trigger: "tela" });
  assert.equal(primeira.newChecked, 1);
  assert.equal(repository.cursor, 20, "o 21 não foi conferido, então o ponto não passa dele");
  assert.match(primeira.stoppedReason, /Limite de consultas/);
  assert.match(repository.runs[0].stoppedReason, /continua de onde parou/);

  ixc.customers[2] = cliente();
  const segunda = await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T10:20:00Z") }, { trigger: "tela" });
  assert.equal(segunda.newChecked, 2);
  assert.equal(repository.cursor, 22);
  assert.deepEqual([...repository.records.keys()].sort(), ["20", "21", "22"]);
});

test("pendência é reconferida sozinha e vira 'corrigido' quando o cadastro é arrumado", async () => {
  const ixc = ixcFalso({ contracts: [contratoIxc(30, 5)], customers: { 5: cliente({ numero: "0" }) } });
  const repository = new MemoryContractAuditRepository();
  repository.cursor = 29;
  await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T10:00:00Z") }, { trigger: "tela" });
  assert.equal(repository.records.get("30").status, "pending");

  ixc.customers[5] = cliente({ numero: "SN" });
  const depois = await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T11:00:00Z") }, { trigger: "tela" });
  assert.equal(depois.rechecked, 1);
  assert.equal(depois.resolved, 1);
  assert.equal(repository.records.get("30").status, "resolved");
  assert.deepEqual(repository.records.get("30").firstIssues.map((i) => i.code), ["numero_zero"]);
});

test("contrato certo não é reconferido, e pendência velha só pelo botão", async () => {
  const ixc = ixcFalso({ customers: { 5: cliente({ email: "" }), 6: cliente() } });
  const repository = new MemoryContractAuditRepository();
  repository.cursor = 1;
  const velho = new Date(Date.parse("2026-10-05T10:00:00Z") - (RECHECK_WINDOW_DAYS + 1) * 86_400_000).toISOString();
  repository.records.set("40", nextRecord(undefined, { ...contrato, id: "40", customerId: "5" }, cliente({ email: "" }), velho));
  repository.records.set("41", nextRecord(undefined, { ...contrato, id: "41", customerId: "6" }, cliente(), "2026-10-05T09:00:00Z"));
  const resultado = await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T10:00:00Z") }, { trigger: "tela" });
  assert.equal(resultado.rechecked, 0);
  assert.deepEqual(ixc.calls.customer, []);

  const pelaMao = await recheckContract({ repository, provider: ixc.provider }, "40");
  assert.equal(pelaMao.checks, 2);
  assert.equal(await recheckContract({ repository, provider: ixc.provider }, "999"), undefined);
});

test("duas passadas ao mesmo tempo: a segunda não roda", async () => {
  const ixc = ixcFalso();
  const repository = new MemoryContractAuditRepository();
  await repository.startRun({ id: "r1", trigger: "agendado", actor: null, startedAt: new Date().toISOString(), correlationId: "c" });
  const resultado = await runContractAudit({ repository, provider: ixc.provider }, { trigger: "manual" });
  assert.equal(resultado.ran, false);
  assert.match(resultado.skipped, /em andamento/);
  assert.equal(ixc.calls.latest, 0);
});

test("motivos de parada em português, e o da allowlist aponta a flag", () => {
  assert.match(stopReason(Object.assign(new Error("Cadastro fora da allowlist"), { name: "IxcCustomerNotAllowedError" })), /FEATURE_IXC_FULL_BASE/);
  assert.match(stopReason(new Error("IXC_CIRCUIT_OPEN")), /instável/);
  assert.match(stopReason(Object.assign(new Error("IXC_TIMEOUT"), { code: "IXC_TIMEOUT" })), /demorou/);
  assert.match(stopReason(new Error("qualquer")), /não respondeu/);
});

/* ------------------------------------------------------- quem criou --- */

test("quem criou vem do log do IXC, pela inserção do contrato, e com o cliente como autorização", async () => {
  const ixc = ixcFalso({ contracts: [contratoIxc(50, 9)], customers: { 9: cliente() }, creators: { 50: { operator: "Maria Letycia", at: "2026-10-05 15:54:00" } } });
  const repository = new MemoryContractAuditRepository();
  repository.cursor = 49;
  await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T16:00:00Z") }, { trigger: "agendado" });
  const record = repository.records.get("50");
  assert.equal(record.createdBy, "Maria Letycia");
  assert.ok(record.creatorCheckedAt);
  assert.deepEqual(ixc.calls.creator, [{ table: "cliente_contrato", recordId: "50", authorizedCustomerId: "9" }]);
});

test("log sem a inserção: registra que procurou, sem inventar autor", async () => {
  const ixc = ixcFalso({ contracts: [contratoIxc(51, 9)], customers: { 9: cliente() }, creators: { 51: null } });
  const repository = new MemoryContractAuditRepository();
  repository.cursor = 50;
  await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T16:00:00Z") }, { trigger: "agendado" });
  const record = repository.records.get("51");
  assert.equal(record.createdBy, null);
  assert.ok(record.creatorCheckedAt, "procurado e não encontrado é diferente de não procurado");
});

test("reconferir não procura quem criou de novo: isso não muda", async () => {
  const ixc = ixcFalso({ contracts: [contratoIxc(52, 9)], customers: { 9: cliente({ email: "" }) } });
  const repository = new MemoryContractAuditRepository();
  repository.cursor = 51;
  await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T16:00:00Z") }, { trigger: "agendado" });
  await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T17:00:00Z") }, { trigger: "agendado" });
  await recheckContract({ repository, provider: ixc.provider }, "52");
  assert.equal(ixc.calls.creator.length, 1);
  assert.equal(repository.records.get("52").createdBy, "Atendente 52");
});

test("contratos auditados antes do log ganham quem criou nas passadas seguintes", async () => {
  const ixc = ixcFalso({ creators: { 60: { operator: "Adeilza", at: null }, 61: null } });
  const repository = new MemoryContractAuditRepository();
  repository.cursor = 100;
  repository.records.set("60", nextRecord(undefined, { ...contrato, id: "60" }, cliente(), "2026-10-05T09:00:00Z"));
  repository.records.set("61", nextRecord(undefined, { ...contrato, id: "61" }, cliente(), "2026-10-05T09:00:00Z"));
  const resultado = await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T16:00:00Z") }, { trigger: "agendado" });
  assert.equal(resultado.creatorsFilled, 1);
  assert.equal(repository.records.get("60").createdBy, "Adeilza");
  assert.ok(repository.records.get("61").creatorCheckedAt, "procurado; o log não tinha");
  const deNovo = await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T17:00:00Z") }, { trigger: "agendado" });
  assert.equal(deNovo.creatorsFilled, 0);
  assert.equal(ixc.calls.creator.length, 2, "cada um procurado uma vez só");
});

test("teto de consultas: a passada para antes de gravar pela metade, e a próxima continua", async () => {
  const ixc = ixcFalso({ contracts: [contratoIxc(70, 1), contratoIxc(71, 2)], customers: { 1: cliente(), 2: cliente() } });
  const repository = new MemoryContractAuditRepository();
  repository.cursor = 69;
  // 1 listagem + cadastro e log do 70 = 3; o cadastro do 71 seria a 4ª.
  const primeira = await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T16:00:00Z") }, { trigger: "agendado", maxCalls: 3 });
  assert.equal(primeira.newChecked, 1);
  assert.equal(repository.cursor, 70);
  assert.equal(repository.records.has("71"), false, "nada gravado pela metade");
  assert.match(primeira.stoppedReason, /máximo de consultas/);
  const segunda = await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T17:00:00Z") }, { trigger: "agendado" });
  assert.equal(segunda.newChecked, 1);
  assert.equal(repository.cursor, 71);
  assert.ok(MAX_IXC_CALLS_PER_RUN <= 20, "o teto padrão deixa folga para o atendimento no limite por minuto");
});

test("se o log falha, o contrato não é gravado sem autor: fica para a próxima", async () => {
  const ixc = ixcFalso({ contracts: [contratoIxc(80, 1)], customers: { 1: cliente() }, creators: { 80: new Error("IXC_RATE_LIMITED") } });
  const repository = new MemoryContractAuditRepository();
  repository.cursor = 79;
  const resultado = await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T16:00:00Z") }, { trigger: "agendado" });
  assert.equal(resultado.newChecked, 0);
  assert.equal(repository.cursor, 79);
  assert.match(resultado.stoppedReason, /Limite de consultas/);
});

test("pendências agrupadas por quem criou, quem tem mais primeiro", async () => {
  const repository = new MemoryContractAuditRepository();
  const pendente = (id, autor) => ({ ...nextRecord(undefined, { ...contrato, id }, cliente({ email: "" }), "2026-10-05T09:00:00Z", autor === undefined ? null : { operator: autor }) });
  repository.records.set("1", pendente("1", "Sabrina"));
  repository.records.set("2", pendente("2", "Sabrina"));
  repository.records.set("3", pendente("3", "Adeilza"));
  repository.records.set("4", pendente("4", undefined));
  repository.records.set("5", nextRecord(undefined, { ...contrato, id: "5" }, cliente(), "2026-10-05T09:00:00Z", { operator: "Adeilza" }));
  assert.deepEqual(await repository.pendingByCreator(), [{ createdBy: "Sabrina", total: 2 }, { createdBy: "Adeilza", total: 1 }, { createdBy: null, total: 1 }]);
});

test("a passada deixa folga no limite do IXC para o resto do sistema", async () => {
  const ixc = ixcFalso({ contracts: [contratoIxc(90, 1), contratoIxc(91, 2)], customers: { 1: cliente(), 2: cliente() } });
  // O painel já gastou quase tudo: sobram 13 consultas no minuto, e cada uma da auditoria tira uma.
  let restantes = 13;
  ixc.provider.rateLimitRemaining = () => restantes;
  const original = { ...ixc.provider };
  ixc.provider.getCustomerRecord = async (...args) => { restantes -= 1; return original.getCustomerRecord(...args); };
  ixc.provider.getRecordCreator = async (...args) => { restantes -= 1; return original.getRecordCreator(...args); };
  ixc.provider.listContractsAfter = async (...args) => { restantes -= 1; return original.listContractsAfter(...args); };
  const repository = new MemoryContractAuditRepository();
  repository.cursor = 89;
  const resultado = await runContractAudit({ repository, provider: ixc.provider, now: relogio("2026-10-05T16:00:00Z") }, { trigger: "tela" });
  // 13 → listagem (12) → cadastro e log do 90 (10) → parou: com 10, não consome mais.
  assert.equal(resultado.newChecked, 1);
  assert.equal(repository.cursor, 90);
  assert.equal(restantes, 10, "a folga fica para o atendimento");
  assert.match(resultado.stoppedReason, /não atrapalhar o atendimento/);
});

test("o limitador do IXC diz quanto sobra sem consumir", async () => {
  const { SlidingWindowRateLimiter } = await import("../lib/integrations/ixc/resilience.ts");
  let agora = 0;
  const limiter = new SlidingWindowRateLimiter(3, 60_000, () => agora);
  assert.equal(limiter.remaining(), 3);
  limiter.assert(); limiter.assert();
  assert.equal(limiter.remaining(), 1);
  assert.equal(limiter.remaining(), 1, "perguntar não gasta");
  agora = 61_000;
  assert.equal(limiter.remaining(), 3, "a janela anda e as consultas antigas saem");
});
