import test from "node:test";
import assert from "node:assert/strict";
import {
  addressPartsFrom, addressSourceOf, bestTimeCode, isSaturdayInBrasilia, needsClimb, pickTechnician, renderAddress,
  technicianCandidates, vehicleFor, NO_CONNECTION_SUBJECT,
} from "../lib/platform/os-dispatch-shared.ts";
import { validateRoutes } from "../lib/platform/technician-routes-service.ts";

/** Regras medidas no IXC da BBNET e combinadas com a operação em 24/11/2026 (ver os-dispatch-shared.ts). */

const FORMATO = "#uf# #cidade# #cep# #bairro# - #endereco#, #numero#";

test("endereço: o login diz a fonte (S cliente, C contrato, N login) — a armadilha do SeeNet", () => {
  assert.equal(addressSourceOf("S"), "customer");
  assert.equal(addressSourceOf("C"), "contract");
  assert.equal(addressSourceOf("N"), "login");
  assert.equal(addressSourceOf(""), "login");
});

test("endereço: texto no molde do assunto, igual ao que a tela do IXC grava", () => {
  const parts = addressPartsFrom(
    { endereco: "Rua A", numero: "12", bairro: "Centro", cep: "49500-000", cidade: "1771", complemento: "Casa 2", referencia: "Perto da praça", latitude: "", longitude: "" },
    { latitude: "-10.7", longitude: "-37.4" },
    { name: "Campo do Brito", state: "SE" },
  );
  assert.equal(renderAddress(FORMATO, parts), "SE Campo do Brito 49500-000 Centro - Rua A, 12");
  assert.equal(parts.cityId, "1771");
  assert.deepEqual([parts.latitude, parts.longitude], ["-10.7", "-37.4"], "coordenadas do login, onde está a ONU");
  // Sem número não sobra vírgula no fim.
  assert.equal(renderAddress(FORMATO, { ...parts, number: "" }), "SE Campo do Brito 49500-000 Centro - Rua A");
  assert.equal(addressPartsFrom({ numero: "0" }, undefined, undefined).number, "", "zero do IXC é vazio");
});

test("horário: M manhã, T tarde, Q qualquer", () => {
  assert.equal(bestTimeCode("Melhor período: manhã"), "M");
  assert.equal(bestTimeCode("visita à tarde"), "T");
  assert.equal(bestTimeCode("pode ser de manhã ou de tarde"), "Q");
  assert.equal(bestTimeCode("sem preferência"), "Q");
});

test("poste ou telhado: a linha da ficha manda; 'não sei' cai nos sinais", () => {
  assert.equal(needsClimb("Precisa subir em poste ou telhado: sim"), true);
  assert.equal(needsClimb("Precisa subir em poste ou telhado: não\nroteador travado"), false);
  assert.equal(needsClimb("Precisa subir em poste ou telhado: não sei"), undefined, "a própria linha não conta como sinal");
  assert.equal(needsClimb("O fio caiu na frente de casa"), true);
  assert.equal(needsClimb("Luz LOS vermelha desde ontem"), true);
  assert.equal(needsClimb("Sem internet", -30.5), true, "sinal crítico é rede, não casa");
  assert.equal(needsClimb("Wi-Fi não pega no quarto"), false);
  assert.equal(needsClimb("Sem internet desde ontem"), undefined);
});

test("veículo e assunto: sem saber vai carro (faz tudo); 9 moto, 14 carro", () => {
  assert.equal(vehicleFor(true), "carro");
  assert.equal(vehicleFor(undefined), "carro");
  assert.equal(vehicleFor(false), "moto");
  assert.deepEqual(NO_CONNECTION_SUBJECT, { moto: "9", carro: "14" });
});

const R = (cityId, vehicle, technicianId, active = true) => ({ cityId, vehicle, technicianId, active });
const ROTAS = [
  R("1771", "moto", "43"), R("1771", "moto", "49"), R("1771", "carro", "6"),
  R("1800", "carro", "19"), // cidade só de carro (Dores)
  R("1900", "moto", "97"), // cidade só de moto (Frei Paulo)
  R("1771", "moto", "99", false),
];

test("quem pode receber: poste só carro; dentro de casa moto; cidade sem o tipo manda para o outro", () => {
  assert.deepEqual(technicianCandidates(ROTAS, "1771", true, false), ["6"]);
  assert.deepEqual(technicianCandidates(ROTAS, "1771", false, false), ["43", "49"], "inativo fica de fora");
  assert.deepEqual(technicianCandidates(ROTAS, "1800", false, false), ["19"], "só tem carro: é só mandar");
  assert.deepEqual(technicianCandidates(ROTAS, "1900", true, false), [], "poste sem carro na cidade: o setor distribui");
  assert.deepEqual(technicianCandidates(ROTAS, "9999", false, false), [], "cidade sem rota (Itabaiana): o setor distribui");
  assert.deepEqual(technicianCandidates(ROTAS, "1771", undefined, false), ["6"], "sem saber, carro");
});

test("sábado: o que não precisa de poste vai para moto e carro; poste continua só carro", () => {
  assert.deepEqual(technicianCandidates(ROTAS, "1771", false, true).sort(), ["43", "49", "6"]);
  assert.deepEqual(technicianCandidates(ROTAS, "1771", true, true), ["6"]);
  assert.equal(isSaturdayInBrasilia(new Date("2026-11-28T15:00:00Z")), true);
  assert.equal(isSaturdayInBrasilia(new Date("2026-11-29T02:00:00Z")), true, "23h de sábado em Brasília");
  assert.equal(isSaturdayInBrasilia(new Date("2026-11-27T15:00:00Z")), false);
});

test("escolha: menos OS aberta primeiro; empate alterna a partir do último", () => {
  assert.equal(pickTechnician(["43", "49"], new Map([["43", 3], ["49", 1]])), "49");
  const empate = new Map([["43", 2], ["49", 2], ["55", 2]]);
  assert.equal(pickTechnician(["43", "49", "55"], empate, null), "43");
  assert.equal(pickTechnician(["43", "49", "55"], empate, "43"), "49");
  assert.equal(pickTechnician(["43", "49", "55"], empate, "55"), "43", "volta ao começo");
  assert.equal(pickTechnician(["43", "49"], new Map([["49", 0]])), "49", "sem carga conhecida fica de fora");
  assert.equal(pickTechnician(["43"], new Map()), undefined);
});

test("tabela de técnicos: recusa a lista inteira se uma linha estiver errada", () => {
  const ok = validateRoutes([{ cityId: "1771", cityName: "Campo do Brito", vehicle: "moto", technicianId: "43", technicianName: "Técnico A" }]);
  assert.equal(ok.ok, true);
  assert.equal(validateRoutes([{ cityId: "1771", cityName: "X", vehicle: "bicicleta", technicianId: "43", technicianName: "A" }]).ok, false);
  assert.equal(validateRoutes([{ cityId: "abc", cityName: "X", vehicle: "moto", technicianId: "43", technicianName: "A" }]).ok, false);
  assert.equal(validateRoutes("não é lista").ok, false);
});
