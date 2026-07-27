import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStagingDemoConfig, stagingDemoHealth, stagingDemoRequirements } from "../lib/runtime/staging-demo.ts";

const root = new URL("../", import.meta.url);
const parseEnv = (contents) => Object.fromEntries(contents.split(/\r?\n/).map((line)=>line.trim()).filter((line)=>line&&!line.startsWith("#")).map((line)=>{const separator=line.indexOf("=");return [line.slice(0,separator),line.slice(separator+1)];}));

test("configuração staging é mock-only e bloqueia integrações e escritas", async () => {
  const source=parseEnv(await readFile(new URL(".env.staging.example",root),"utf8"));
  assert.deepEqual(Object.fromEntries(Object.keys(stagingDemoRequirements).map((key)=>[key,source[key]])),stagingDemoRequirements);
  assert.deepEqual(loadStagingDemoConfig(source),{environment:"staging",runtimeMode:"mock",ixc:"disabled",externalWrites:false});
});

test("variáveis obrigatórias de staging falham fechadas", () => {
  for(const name of Object.keys(stagingDemoRequirements))assert.throws(()=>loadStagingDemoConfig({...stagingDemoRequirements,[name]:undefined}),new RegExp(name));
  assert.throws(()=>loadStagingDemoConfig({...stagingDemoRequirements,IXC_MODE:"staging-readonly"}),/IXC_MODE/);
  assert.throws(()=>loadStagingDemoConfig({...stagingDemoRequirements,FEATURE_IXC_WRITE:"true"}),/FEATURE_IXC_WRITE/);
});

test("health é sanitizado e nunca habilita IXC ou escrita externa", () => {
  const health=stagingDemoHealth({...stagingDemoRequirements,IXC_API_TOKEN:"nao-pode-aparecer",STAGING_JOB_SECRET:"nao-pode-aparecer",IXC_ALLOWED_CUSTOMER_IDS:"128"});
  assert.deepEqual(health,{status:"ok",environment:"staging",runtimeMode:"mock",ixc:"disabled",externalWrites:false});
  assert.doesNotMatch(JSON.stringify(health),/token|secret|allowlist|128|nao-pode-aparecer/i);
});

test("seed contém somente registros identificados como sintéticos", async () => {
  const seed=await readFile(new URL("scripts/staging-seed.sql",root),"utf8");
  for(const expected of ["DEMO-CLI-001","João Pereira","Maria Souza","Rafael Costa","Ana Carvalho","Itabaiana","Lagarto","Campo do Brito","São Domingos","example.invalid"])assert.match(seed,new RegExp(expected));
  assert.doesNotMatch(seed,/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/);
  assert.doesNotMatch(seed,/\(\d{2}\)\s*9?\d{4,5}-?\d{4}/);
  assert.doesNotMatch(seed,/IXC-AUTH|IXC_API_TOKEN|STAGING_JOB_SECRET/);
});

test("configuração local permanece separada da configuração de staging", async () => {
  const local=parseEnv(await readFile(new URL(".env.example",root),"utf8"));
  assert.equal(local.LZR_ENV,"local");assert.equal(local.NEXT_PUBLIC_LZR_ENV,"local");assert.equal(local.IXC_MODE,"disabled");assert.equal(local.IXC_WRITE_ENABLED,"false");
});

test("UI principal, health e agente funcionam sem ação externa", async () => {
  const workerUrl=new URL("../dist/server/index.js",import.meta.url);workerUrl.searchParams.set("staging-demo",`${process.pid}-${Date.now()}`);const {default:worker}=await import(workerUrl.href);
  const env={ASSETS:{fetch:async()=>new Response("Not found",{status:404})}};const ctx={waitUntil(){},passThroughOnException(){}};
  const page=await worker.fetch(new Request("http://localhost/",{headers:{accept:"text/html"}}),env,ctx);const html=await page.text();
  assert.equal(page.status,200);assert.match(html,/Ambiente de demonstração/);assert.match(html,/nenhuma ação real é executada/);assert.match(html,/AI Training Mode/);assert.doesNotMatch(html,/Breno Lima/);
  const healthResponse=await worker.fetch(new Request("http://localhost/api/health"),env,ctx);const health=await healthResponse.json();
  assert.equal(healthResponse.status,200);assert.equal(health.ixc,"disabled");assert.equal(health.externalWrites,false);assert.deepEqual(Object.keys(health).sort(),["environment","externalWrites","ixc","runtimeMode","status"].sort());
  const agentResponse=await worker.fetch(new Request("http://localhost/api/agent",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({message:"Quero o PIX",history:[]})}),env,ctx);const agent=await agentResponse.json();
  assert.equal(agentResponse.status,200);assert.equal(agent.intent,"financial_pix");assert.equal(agent.actionExecuted,false);assert.equal(agent.simulationOnly,true);
  const attack=await worker.fetch(new Request("http://localhost/api/agent",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({message:"Teste",simulationProfile:"payment_recognized"})}),env,ctx);assert.equal(attack.status,403);
  const n8n=await worker.fetch(new Request("http://localhost/api/channels/n8n",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({externalConversationId:"demo",text:"Teste",idempotencyKey:"demo-key"})}),env,ctx);
  assert.equal(n8n.status,503);assert.deepEqual(await n8n.json(),{error:"Canal n8n desativado"});
});
