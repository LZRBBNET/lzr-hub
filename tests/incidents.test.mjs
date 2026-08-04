import assert from "node:assert/strict";
import test from "node:test";
import {
  IncidentValidationError,
  MemoryIncidentsRepository,
  parseIncidentInput,
} from "../lib/platform/incidents-service.ts";

const VALID = { title:"Rompimento de fibra no anel norte", severity:"high", city:"Itabaiana", neighborhood:"Centro", equipment:"OLT-ITA-02 / PON 4", affectedCustomers:93 };

test("massiva registrada nasce em investigação e sem data de encerramento", async () => {
  const repository = new MemoryIncidentsRepository();
  const created = await repository.create(parseIncidentInput(VALID));

  assert.equal(created.status, "investigating");
  assert.equal(created.endedAt, null);
  assert.equal(created.affectedCustomers, 93);
  assert.ok(created.startedAt, "a abertura é datada no registro, não pelo cliente");
});

test("encerrar marca a massiva como resolvida e data o encerramento", async () => {
  const repository = new MemoryIncidentsRepository();
  const created = await repository.create(parseIncidentInput(VALID));
  const closed = await repository.close(created.id);

  assert.equal(closed.status, "resolved");
  assert.ok(closed.endedAt);
  assert.equal(await repository.close("não-existe"), undefined);
});

test("lista devolve a massiva mais recente primeiro", async () => {
  const repository = new MemoryIncidentsRepository();
  await repository.create(parseIncidentInput({ ...VALID, title:"Primeira massiva" }));
  await new Promise((resolve) => setTimeout(resolve, 2));
  await repository.create(parseIncidentInput({ ...VALID, title:"Segunda massiva" }));

  const items = await repository.list(10);
  assert.equal(items[0].title, "Segunda massiva");
});

test("sem massiva registrada a lista volta vazia, nunca com incidente de exemplo", async () => {
  assert.deepEqual(await new MemoryIncidentsRepository().list(10), []);
});

test("entrada inválida é recusada em vez de virar registro sem sentido", () => {
  const reject = (patch) => assert.throws(() => parseIncidentInput({ ...VALID, ...patch }), IncidentValidationError);
  reject({ title:"ab" });
  reject({ city:"" });
  reject({ neighborhood:"  " });
  reject({ severity:"urgentíssima" });
  reject({ affectedCustomers:-1 });
  reject({ affectedCustomers:"muitos" });
});

test("equipamento é opcional e some quando vem vazio", () => {
  assert.equal(parseIncidentInput({ ...VALID, equipment:"   " }).equipment, undefined);
});
