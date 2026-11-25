import test from "node:test";
import assert from "node:assert/strict";
import { evaluateInstallationEvidence as evaluate } from "../lib/platform/installation-audit-evidence.mjs";
const consultedAt = "2026-11-25T13:00:00Z";
const expected = {orderId:"1",contractId:"2",customerId:"3"};
const order = {id:"1",contractId:"2",customerId:"3",subjectId:"4",status:"F",closureMethod:"seenet"};
const policy = {subjectId:"4",kind:"installation",method:"seenet",requirements:[{type:"anexos",sources:["ixc","seenet"],minimum:2}]};
const row = (source, recordIds, overrides={}) => ({...expected,type:"anexos",source,coverage:"complete",readAt:consultedAt,recordIds,...overrides});
const cases = [
  ["IXC vazio e SeeNet desconhecido", [row("ixc",[])], {}, "review"],
  ["as duas fontes comprovadamente vazias", [row("ixc",[]),row("seenet",[])], {}, "confirmed"],
  ["não soma cópias entre sistemas", [row("ixc",["10"]),row("seenet",["10"])], {}, "review"],
  ["evidência completa no SeeNet", [row("ixc",[]),row("seenet",["10","11"])], {}, "clear"],
  ["O.S. vinculada a outro contrato", [],{order:{...order,contractId:"8"}},"unverified"],
  ["modo de finalização divergente", [],{order:{...order,closureMethod:"ixc_wizard"}},"unverified"],
  ["prova de outro titular", [row("ixc",["10","11"],{customerId:"9"})],{},"unverified"],
  ["O.S. aberta", [],{order:{...order,status:"A"}},"unverified"],
  ["não duplica o mesmo registro", [row("ixc",["10","10"]),row("seenet",[])],{},"review"],
  ["cobertura parcial não comprova o mínimo", [row("ixc",["10","11"],{coverage:"partial"})],{},"unverified"],
  ["sem política vigente não dá baixa", [row("ixc",[])],{policy:null},"unverified"],
  ["data posterior à consulta não vale", [row("ixc",["10","11"],{readAt:"2026-11-25T14:00:00Z"})],{},"unverified"]
];
for (const [title,evidence,overrides,want] of cases) test(title,()=> {
  const result = evaluate({expected,order,policy,consultedAt,evidence,...overrides});
  assert.equal(result.status,want);
  if (want === "confirmed") assert.equal(result.reason,"documentary_gap_only");
  if (want === "clear") assert.deepEqual(result.checks[0].sources[1].recordIds,["10","11"]);
});
