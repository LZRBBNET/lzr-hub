import test from "node:test";
import assert from "node:assert/strict";
import { ReadonlyIxcGuard, IxcCustomerNotAllowedError, IxcWriteBlockedError } from "../lib/integrations/ixc/guard.ts";
import { IxcCustomerMapper, IxcContractMapper } from "../lib/integrations/ixc/mappers.ts";
import { sanitizeTelemetry } from "../lib/integrations/ixc/masking.ts";
import { CircuitBreaker, TtlCache } from "../lib/integrations/ixc/resilience.ts";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import { loadRuntimeConfig, parseAllowlist } from "../lib/runtime/environment.ts";
import { IxcSyncCoordinator, MemorySyncRepository } from "../lib/platform/ixc-sync.ts";
import { IxcReadonlySmokeRunner, MemorySmokeRepository } from "../lib/platform/ixc-smoke.ts";

const allowedId="IXC-AUTH-001";
const fixtures={
  cliente:{id:allowedId,razao:"Cliente Interno Um",cnpj_cpf:"DOC-01",cidade:"3502",bairro:"Centro",ativo:"S"},
  cidade:{id:"3502",nome:"Itabaiana"},
  cliente_contrato:{id:"CTR-001",id_cliente:allowedId,id_vd_contrato:"PLAN-600",contrato:"600 Mega",status:"A",dia_vencimento:"10",valor_plano:"89,90"},
  vd_contratos:{id:"PLAN-600",nome:"600 Mega Homologado",velocidade:"600M",valor:"89,90"},
  fn_areceber:{id:"INV-001",id_cliente:allowedId,id_contrato:"CTR-001",status:"A",data_vencimento:"2026-07-20",valor:"89.90"},
  fn_movim_finan:{id:"PAY-001",id_cliente:allowedId,id_receber:"INV-000",data:"2026-06-20",valor:"89.90",tipo_recebimento:"PIX"},
  su_oss_chamado:{id:"OS-001",id_cliente:allowedId,status:"A",assunto:"Suporte interno",data_abertura:"2026-07-10"},
  radusuarios:{id:"RAD-001",id_cliente:allowedId,login:"interno.001",online:"S",endereco:"não registrar"},
};

test("ReadonlyIxcGuard limita allowlist e bloqueia toda escrita",()=>{
  const guard=new ReadonlyIxcGuard([allowedId]);
  assert.equal(guard.isAllowed(allowedId),true);
  assert.throws(()=>guard.assertCustomer("OUTRO"),IxcCustomerNotAllowedError);
  for(const operation of ["updateCustomer","unblock","generateInvoice","openServiceOrder","delete"]){assert.throws(()=>guard.assertOperation(operation),IxcWriteBlockedError);}
  assert.throws(()=>new ReadonlyIxcGuard(Array.from({length:11},(_,i)=>`ID-${i}`)));
});

test("mappers mascaram PII, aceitam campo inesperado e rejeitam contrato inválido",()=>{
  const customer=IxcCustomerMapper.map({...fixtures.cliente,telefone:"PHONE-SYNTHETIC",campo_novo:"ignorado"});
  assert.equal(customer.nameMasked,"Cliente I. U.");
  assert.equal(customer.documentMasked,"***.***.***-01");
  assert.equal("telefone" in customer,false);
  assert.throws(()=>IxcContractMapper.map({id:"sem-cliente"}));
});

test("telemetria remove PII e segredos",()=>{
  const value=sanitizeTelemetry({cpf:"DOC-SYNTHETIC",token:"segredo",nested:{telefone:"PHONE-SYNTHETIC"},count:2});
  assert.deepEqual(value,{cpf:"[REDACTED]",token:"[REDACTED]",nested:{telefone:"[REDACTED]"},count:2});
});

test("cache respeita TTL e circuit breaker se recupera",()=>{
  let now=1000;const cache=new TtlCache(100,()=>now);cache.set("a",1);assert.equal(cache.get("a"),1);now=1100;assert.equal(cache.get("a"),undefined);
  const breaker=new CircuitBreaker(2,100,()=>now);breaker.failure();assert.equal(breaker.state(),"closed");breaker.failure();assert.equal(breaker.state(),"open");now+=101;assert.equal(breaker.state(),"closed");
});

test("configuração exige staging, secrets e até 10 IDs",()=>{
  assert.throws(()=>parseAllowlist(Array.from({length:11},(_,i)=>`ID${i}`).join(",")));
  assert.throws(()=>loadRuntimeConfig({LZR_ENV:"production",IXC_MODE:"production-readonly"}));
  assert.throws(()=>loadRuntimeConfig({LZR_ENV:"staging",IXC_MODE:"staging-readonly"}));
  const config=loadRuntimeConfig({LZR_ENV:"staging",IXC_MODE:"staging-readonly",IXC_BASE_URL:"https://ixc.invalid",IXC_API_TOKEN:"secret",IXC_ALLOWED_CUSTOMER_IDS:allowedId,IXC_RETRY_LIMIT:"0",IXC_WRITE_ENABLED:"false"});
  assert.equal(config.writeEnabled,false);assert.deepEqual(config.ixcAllowlist,[allowedId]);assert.equal(config.ixcRetryLimit,0);
  assert.throws(()=>loadRuntimeConfig({LZR_ENV:"staging",IXC_MODE:"mock",IXC_RETRY_LIMIT:"2"}));
});

test("ID fora da allowlist é bloqueado antes de qualquer chamada de rede",async()=>{
  let networkCalls=0;const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"secret",allowedCustomerIds:[allowedId],fetcher:async()=>{networkCalls+=1;return Response.json({registros:[]})}});
  await assert.rejects(()=>provider.getSnapshot("IXC-BLOCKED-999","corr-pre-network"),IxcCustomerNotAllowedError);assert.equal(networkCalls,0);
});

test("provider monta Customer 360 somente para cadastro autorizado e usa cache",async()=>{
  let calls=0;const traces=[];
  const fetcher=async(url)=>{calls+=1;const resource=String(url).split("/").at(-1);return Response.json({registros:fixtures[resource]?[fixtures[resource]]:[]});};
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"secret",allowedCustomerIds:[allowedId],fetcher,trace:(trace)=>traces.push(trace)});
  const first=await provider.getSnapshot(allowedId,"corr-001");
  assert.equal(first.customer.documentMasked,"***.***.***-01");assert.equal(first.customer.city,"Itabaiana");assert.equal(first.contracts.length,1);assert.equal(first.plan.name,"600 Mega Homologado");assert.equal(first.invoices.length,1);assert.equal(first.serviceOrders.length,1);assert.equal(first.connection.addressMasked,"[ENDEREÇO MASCARADO]");assert.equal(typeof first.metrics.blockLatencies.getPlan,"number");
  const count=calls;const second=await provider.getSnapshot(allowedId,"corr-002");assert.equal(second.cache,"hit");assert.equal(second.metrics.totalLatencyMs,0);assert.equal(calls,count);assert.equal(traces.some((item)=>item.status==="cache-hit"),true);
  await assert.rejects(()=>provider.getSnapshot("NAO-AUTORIZADO","corr-003"),IxcCustomerNotAllowedError);
});

test("falha parcial preserva Customer 360 e identifica a fonte",async()=>{
  const fetcher=async(url)=>{const resource=String(url).split("/").at(-1);if(resource==="fn_areceber")return new Response("indisponível",{status:500});return Response.json({registros:fixtures[resource]?[fixtures[resource]]:[]});};
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"secret",allowedCustomerIds:[allowedId],fetcher});
  const snapshot=await provider.getSnapshot(allowedId,"corr-partial");
  assert.equal(snapshot.customer.id,allowedId);assert.deepEqual(snapshot.invoices,[]);assert.deepEqual(snapshot.partialSources,["invoices"]);
});

test("falha ao resolver cidade preserva o Customer 360 com o código bruto",async()=>{
  const fetcher=async(url)=>{const resource=String(url).split("/").at(-1);if(resource==="cidade")return new Response("indisponível",{status:500});return Response.json({registros:fixtures[resource]?[fixtures[resource]]:[]});};
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"secret",allowedCustomerIds:[allowedId],fetcher});
  const snapshot=await provider.getSnapshot(allowedId,"corr-city-fail");
  assert.equal(snapshot.customer.city,"3502");
});

test("nome da cidade fica em cache e não gera nova chamada de rede",async()=>{
  let cityCalls=0;
  const fetcher=async(url)=>{const resource=String(url).split("/").at(-1);if(resource==="cidade")cityCalls+=1;return Response.json({registros:fixtures[resource]?[fixtures[resource]]:[]});};
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"secret",allowedCustomerIds:[allowedId],fetcher});
  await provider.getSnapshot(allowedId,"corr-city-1");
  assert.equal(cityCalls,1);
  await provider.getSnapshot(allowedId,"corr-city-2",true);
  assert.equal(cityCalls,1);
});

test("sincronização registra checkpoint, auditoria e DLQ sem payload bruto",async()=>{
  const repository=new MemorySyncRepository();
  const okProvider={getSnapshot:async()=>({partialSources:[]})};
  const completed=await new IxcSyncCoordinator(okProvider,repository).run(allowedId,"corr-sync-ok");
  assert.equal(completed.status,"completed");assert.equal(repository.checkpoints.get(allowedId),"completed");assert.equal(repository.audits.length,1);
  const failedProvider={getSnapshot:async()=>{throw new Error("IXC indisponível")}};
  const failed=await new IxcSyncCoordinator(failedProvider,repository).run("IXC-AUTH-002","corr-sync-fail");
  assert.equal(failed.status,"dlq");assert.equal(repository.jobs.at(-1).status,"dlq");assert.equal(repository.jobs.at(-1).attempts,2);
});

test("smoke runner registra apenas métricas sanitizadas e cache",async()=>{
  const fetcher=async(url)=>{const resource=String(url).split("/").at(-1);return Response.json({registros:fixtures[resource]?[fixtures[resource]]:[]});};const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"secret",allowedCustomerIds:[allowedId],fetcher});const repository=new MemorySmokeRepository();const run=await new IxcReadonlySmokeRunner(provider,repository).run(allowedId);
  assert.equal(run.status,"success");assert.ok(run.results.some((item)=>item.operation==="plan"&&item.recordCount===1));assert.ok(run.results.some((item)=>item.operation==="cache"&&item.cache==="hit"));assert.equal(repository.audits.length,1);assert.equal(JSON.stringify(repository.rows).includes("Cliente Interno"),false);
});

for(const status of [401,403,429,500])test(`contrato IXC trata HTTP ${status} sem vazar payload`,async()=>{
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"secret",allowedCustomerIds:[allowedId],fetcher:async()=>new Response("sensível",{status})});
  await assert.rejects(()=>provider.testConnection(`corr-${status}`),new RegExp(`IXC_HTTP_${status}`));
});

test("contrato IXC transforma erro HTTP 200 de IP em código sanitizado",async()=>{
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"secret",allowedCustomerIds:[allowedId],fetcher:async()=>Response.json({type:"error",message:"Seu IP não está liberado para efetuar login!"})});
  await assert.rejects(()=>provider.testConnection("corr-ip"),/IXC_IP_NOT_ALLOWED/);
});

test("token bruto do IXC é codificado uma única vez no header Basic",async()=>{
  const raw="128:"+"a".repeat(64);let authorization="";
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:raw,allowedCustomerIds:[allowedId],fetcher:async(_url,init)=>{authorization=new Headers(init.headers).get("Authorization")??"";return Response.json({registros:[]});}});
  await provider.testConnection("corr-basic");
  assert.equal(authorization,`Basic ${btoa(raw)}`);
});

test("token IXC já codificado não sofre dupla codificação",async()=>{
  const encoded=btoa("128:"+"a".repeat(64));let authorization="";
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:encoded,allowedCustomerIds:[allowedId],fetcher:async(_url,init)=>{authorization=new Headers(init.headers).get("Authorization")??"";return Response.json({registros:[]});}});
  await provider.testConnection("corr-basic-encoded");
  assert.equal(authorization,`Basic ${encoded}`);
});

test("smoke preserva somente o código seguro da falha",async()=>{
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"secret",allowedCustomerIds:[allowedId],fetcher:async()=>Response.json({type:"error",message:"Seu IP não está liberado para efetuar login!"})});
  const run=await new IxcReadonlySmokeRunner(provider,new MemorySmokeRepository()).run(allowedId);
  assert.equal(run.status,"partial");assert.deepEqual(run.results.map((item)=>item.errorCode),["IXC_IP_NOT_ALLOWED","IXC_IP_NOT_ALLOWED"]);
});

test("contrato IXC trata timeout",async()=>{
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"secret",allowedCustomerIds:[allowedId],fetcher:async()=>{throw new DOMException("timeout","AbortError")}});
  await assert.rejects(()=>provider.testConnection("corr-timeout"));
});
