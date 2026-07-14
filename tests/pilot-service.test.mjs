import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeConfig } from "../lib/runtime/environment.ts";
import { MemoryPilotRepository, PilotService, sanitizePilotText } from "../lib/platform/pilot-service.ts";

const users=["USER-INTERNAL-A","USER-INTERNAL-B","USER-INTERNAL-C"];

test("piloto exige 2 a 3 usuários e segredo administrativo",()=>{
  assert.throws(()=>loadRuntimeConfig({LZR_ENV:"staging",PILOT_MODE:"internal",PILOT_ALLOWED_USER_IDS:users[0],STAGING_JOB_SECRET:"secret"}));
  assert.throws(()=>loadRuntimeConfig({LZR_ENV:"staging",PILOT_MODE:"internal",PILOT_ALLOWED_USER_IDS:users.slice(0,2).join(",")}));
  const config=loadRuntimeConfig({LZR_ENV:"staging",PILOT_MODE:"internal",PILOT_ALLOWED_USER_IDS:users.join(","),STAGING_JOB_SECRET:"secret"});assert.equal(config.pilotAllowedUserIds.length,3);
});

test("participante não autorizado é bloqueado",async()=>{
  const service=new PilotService(new MemoryPilotRepository(),users.slice(0,2));await assert.rejects(()=>service.record("OUTSIDER",{eventType:"feedback",module:"customer360",description:"fluxo testado"}),/PILOT_USER_NOT_ALLOWED/);
});

test("feedback remove PII e persiste somente alias",async()=>{
  const repository=new MemoryPilotRepository();const service=new PilotService(repository,users.slice(0,2));const email="nome"+"@"+"example.invalid";const phone="1".repeat(11);const event=await service.record(users[0],{eventType:"bug",module:"customer360",severity:"medium",description:`Contato ${email} telefone ${phone} na Rua Alfa`,screenshotRef:"sanitized://bug-001"});
  assert.equal(event.participantAlias,"pilot-user-1");assert.match(event.description,/REDACTED/);assert.equal(event.description.includes(email),false);assert.equal(JSON.stringify(repository.events).includes(users[0]),false);
});

test("screenshot não sanitizado e métrica desconhecida são rejeitados",async()=>{
  const service=new PilotService(new MemoryPilotRepository(),users.slice(0,2));await assert.rejects(()=>service.record(users[0],{eventType:"bug",module:"customer360",description:"erro",screenshotRef:"https://arquivo.invalid/raw"}),/PILOT_SCREENSHOT_NOT_SANITIZED/);await assert.rejects(()=>service.record(users[0],{eventType:"metric",module:"ixc",description:"métrica",metricName:"cpf_count",metricValue:1}),/PILOT_METRIC_INVALID/);
});

test("métricas permitidas e resumo do piloto funcionam",async()=>{
  const repository=new MemoryPilotRepository();const service=new PilotService(repository,users.slice(0,2));await service.record(users[0],{eventType:"metric",module:"ixc",description:"latência sanitizada",metricName:"ixc_latency_ms",metricValue:120});await service.record(users[1],{eventType:"feedback",module:"customer360",description:"fluxo concluído"});assert.deepEqual(await service.summary(),{metric:1,feedback:1});assert.equal(sanitizePilotText("texto seguro"),"texto seguro");
});
