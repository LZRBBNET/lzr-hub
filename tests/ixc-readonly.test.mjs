import test from "node:test";
import assert from "node:assert/strict";
import { ReadonlyIxcGuard, IxcCustomerNotAllowedError, IxcWriteBlockedError } from "../lib/integrations/ixc/guard.ts";
import { customerQuery } from "../lib/integrations/ixc/readonly-provider.ts";
import { IxcInvoiceMapper, IxcPlanMapper } from "../lib/integrations/ixc/mappers.ts";
import { IxcCustomerMapper, IxcContractMapper } from "../lib/integrations/ixc/mappers.ts";
import { sanitizeTelemetry } from "../lib/integrations/ixc/masking.ts";
import { CircuitBreaker, TtlCache } from "../lib/integrations/ixc/resilience.ts";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import { loadRuntimeConfig, parseAllowlist } from "../lib/runtime/environment.ts";
import { IxcSyncCoordinator, MemorySyncRepository } from "../lib/platform/ixc-sync.ts";
import { IxcReadonlySmokeRunner, MemorySmokeRepository } from "../lib/platform/ixc-smoke.ts";

const allowedId="IXC-AUTH-001";
const fixtures={
  cliente:{id:allowedId,razao:"Cliente Interno Um",cnpj_cpf:"DOC-01",telefone_celular:"(79) 90000-0001",email:"cliente.interno@exemplo.invalid",cidade:"3502",bairro:"Centro",endereco:"Rua Homologação",numero:"10",complemento:"Sala 2",cep:"49500-000",data_cadastro:"2020-01-15",ativo:"S"},
  cidade:{id:"3502",nome:"Itabaiana"},
  cliente_contrato:{id:"CTR-001",id_cliente:allowedId,id_vd_contrato:"PLAN-600",contrato:"600 Mega",status:"A",dia_vencimento:"10",valor_plano:"89,90"},
  vd_contratos:{id:"PLAN-600",nome:"600 Mega Homologado",velocidade:"600M",valor:"89,90"},
  fn_areceber:{id:"INV-001",id_cliente:allowedId,id_contrato:"CTR-001",status:"A",data_vencimento:"2026-07-20",valor:"89.90"},
  fn_movim_finan:{id:"PAY-001",id_receber:"INV-001",data:"2026-06-20",valor:"89.90",tipo_recebimento:"PIX"},
  su_oss_chamado:{id:"OS-001",id_cliente:allowedId,status:"A",assunto:"Suporte interno",data_abertura:"2026-07-10"},
  radusuarios:{id:"RAD-001",id_cliente:allowedId,login:"interno.001",online:"S",endereco:"Rua Homologação",numero:"10",bairro:"Centro",conexao:"101-2048-OLT-HOMOLOG-01",tipo_conexao:"Ethernet"},
};

test("ReadonlyIxcGuard limita allowlist e bloqueia toda escrita",()=>{
  const guard=new ReadonlyIxcGuard([allowedId]);
  assert.equal(guard.isAllowed(allowedId),true);
  assert.throws(()=>guard.assertCustomer("OUTRO"),IxcCustomerNotAllowedError);
  for(const operation of ["updateCustomer","unblock","generateInvoice","openServiceOrder","delete"]){assert.throws(()=>guard.assertOperation(operation),IxcWriteBlockedError);}
  assert.throws(()=>new ReadonlyIxcGuard(Array.from({length:11},(_,i)=>`ID-${i}`)));
});

test("mapper de cliente devolve dado completo (sem mascarar) e aceita campo inesperado",()=>{
  const customer=IxcCustomerMapper.map({...fixtures.cliente,campo_novo:"ignorado"});
  // Decisão: atendente autenticado vê dado completo -- a proteção é sessão + RBAC
  // (login obrigatório), não mais texto truncado. Ver docs do Customer 360.
  assert.equal(customer.name,"Cliente Interno Um");
  assert.equal(customer.document,"DOC-01");
  assert.equal(customer.phone,"(79) 90000-0001");
  assert.equal(customer.email,"cliente.interno@exemplo.invalid");
  assert.equal(customer.neighborhood,"Centro");
  assert.equal(customer.address,"Rua Homologação, 10 - Sala 2 - Bairro Centro - CEP 49500-000");
  assert.equal(customer.customerSince,"2020-01-15");
  assert.equal("campo_novo" in customer,false);
  assert.throws(()=>IxcContractMapper.map({id:"sem-cliente"}));
});

test("mapper de cliente não inventa dado quando o campo vem vazio",()=>{
  const customer=IxcCustomerMapper.map({id:allowedId,razao:"",cnpj_cpf:""});
  assert.equal(customer.name,"não informado");
  assert.equal(customer.document,"não informado");
  assert.equal(customer.phone,"não informado");
  assert.equal(customer.email,"não informado");
  assert.equal(customer.address,"não informado");
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
  assert.equal(first.customer.document,"DOC-01");assert.equal(first.customer.city,"Itabaiana");assert.equal(first.contracts.length,1);assert.equal(first.plan.name,"600 Mega Homologado");assert.equal(first.invoices.length,1);assert.equal(first.serviceOrders.length,1);assert.equal(first.connection.login,"interno.001");assert.equal(first.connection.equipmentDescriptor,"101-2048-OLT-HOMOLOG-01");assert.equal(typeof first.metrics.blockLatencies.getPlan,"number");
  // Pagamento é buscado por fatura (id_receber), não por id_cliente direto -- é a
  // correção do bug em que fn_movim_finan sempre devolvia erro do IXC.
  assert.equal(first.payments.length,1);assert.equal(first.payments[0].invoiceId,"INV-001");
  const count=calls;const second=await provider.getSnapshot(allowedId,"corr-002");assert.equal(second.cache,"hit");assert.equal(second.metrics.totalLatencyMs,0);assert.equal(calls,count);assert.equal(traces.some((item)=>item.status==="cache-hit"),true);
  await assert.rejects(()=>provider.getSnapshot("NAO-AUTORIZADO","corr-003"),IxcCustomerNotAllowedError);
});

test("pagamentos são filtrados por fatura (id_receber), nunca por id_cliente",async()=>{
  // fn_movim_finan não tem coluna id_cliente no IXC real -- filtrar por ela sempre
  // devolvia uma página de erro (bug encontrado testando contra o IXC de verdade).
  const paymentQueries=[];
  const fetcher=async(url,init)=>{
    const resource=String(url).split("/").at(-1);
    if(resource==="fn_movim_finan"&&init?.body)paymentQueries.push(JSON.parse(init.body));
    return Response.json({registros:fixtures[resource]?[fixtures[resource]]:[]});
  };
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"secret",allowedCustomerIds:[allowedId],fetcher});
  await provider.getSnapshot(allowedId,"corr-payments-field");
  assert.equal(paymentQueries.length,1);
  assert.equal(paymentQueries[0].qtype,"id_receber");
  assert.equal(paymentQueries[0].query,"INV-001");
});

test("sem fatura, não dispara nenhuma chamada de pagamento",async()=>{
  let paymentCalls=0;
  const fetcher=async(url)=>{
    const resource=String(url).split("/").at(-1);
    if(resource==="fn_movim_finan")paymentCalls+=1;
    if(resource==="fn_areceber")return Response.json({registros:[]});
    return Response.json({registros:fixtures[resource]?[fixtures[resource]]:[]});
  };
  const provider=new IxcReadonlyProvider({baseUrl:"https://ixc.invalid",token:"secret",allowedCustomerIds:[allowedId],fetcher});
  const snapshot=await provider.getSnapshot(allowedId,"corr-no-invoices");
  assert.equal(snapshot.invoices.length,0);
  assert.equal(snapshot.payments.length,0);
  assert.equal(paymentCalls,0);
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

test("base inteira só abre com decisão explícita e com login exigido",()=>{
  const base={LZR_ENV:"staging",IXC_MODE:"staging-readonly",IXC_BASE_URL:"https://ixc.invalid",IXC_API_TOKEN:"secret",IXC_WRITE_ENABLED:"false"};

  // Sem a flag, nada muda: allowlist continua obrigatória.
  assert.throws(()=>loadRuntimeConfig({...base,IXC_ALLOWED_CUSTOMER_IDS:""}),/allowlist/);
  assert.equal(loadRuntimeConfig({...base,IXC_ALLOWED_CUSTOMER_IDS:allowedId}).ixcFullBase,false,"a flag nasce desligada");

  // Ler a base inteira sem saber quem lê exporia todo cliente da BBNET.
  assert.throws(()=>loadRuntimeConfig({...base,IXC_ALLOWED_CUSTOMER_IDS:"",FEATURE_IXC_FULL_BASE:"true"}),/FEATURE_AUTH/);

  const full=loadRuntimeConfig({...base,IXC_ALLOWED_CUSTOMER_IDS:"",FEATURE_IXC_FULL_BASE:"true",FEATURE_AUTH:"true"});
  assert.equal(full.ixcFullBase,true);
  assert.deepEqual(full.ixcAllowlist,[],"sem allowlist obrigatória quando a base está liberada");
});

test("guard com base liberada aceita qualquer cadastro, mas continua bloqueando escrita",()=>{
  const guard=new ReadonlyIxcGuard([],true);
  assert.doesNotThrow(()=>guard.assertCustomer("99999"));
  assert.equal(guard.isAllowed("qualquer-id"),true);
  assert.equal(guard.scope(),"full-base");
  assert.deepEqual(guard.listMasked(),[],"não faz sentido listar allowlist quando não há allowlist");
  assert.throws(()=>guard.assertOperation("updateCustomer"),IxcWriteBlockedError,"leitura liberada não é escrita liberada");
  assert.throws(()=>guard.assertOperation("desbloquear"),IxcWriteBlockedError);
});

test("busca traduz o que foi digitado para o filtro certo do IXC",()=>{
  assert.deepEqual(customerQuery(""),{qtype:"cliente.id",query:"0",oper:">"},"vazio lista a base");
  assert.deepEqual(customerQuery("  "),{qtype:"cliente.id",query:"0",oper:">"});
  assert.deepEqual(customerQuery("21857"),{qtype:"cliente.id",query:"21857",oper:"="});
  assert.deepEqual(customerQuery("123.456.789-01"),{qtype:"cliente.cnpj_cpf",query:"12345678901",oper:"="},"CPF vai sem pontuação");
  assert.deepEqual(customerQuery("12.345.678/0001-95"),{qtype:"cliente.cnpj_cpf",query:"12345678000195",oper:"="});
  assert.deepEqual(customerQuery("Wendel"),{qtype:"cliente.razao",query:"Wendel",oper:"L"});
});

test("valor do plano vem de valor_contrato, e o contrato não finge ter valor",()=>{
  // cliente_contrato realmente não tem campo de valor: verificado listando os
  // 150+ campos que o IXC devolve. Antes o mapper procurava "valor_plano" e
  // devolvia undefined em silêncio, o que zerava toda soma de receita.
  const contract=IxcContractMapper.map({id:"1",id_cliente:"9",contrato:"FIBRA COMBO 300MB - 69,90 - BBNET",status:"A",id_vd_contrato:"394"});
  assert.equal(contract.monthlyValue,undefined,"o valor precisa vir do plano, não ser inventado a partir do nome");
  assert.equal(contract.planId,"394","é por este id que o plano é resolvido");

  const plan=IxcPlanMapper.map({id:"394",nome:"FIBRA COMBO 300MB",valor_contrato:"69.900000000"});
  assert.equal(plan.value,69.9,"valor_contrato vem com 9 casas decimais");

  assert.equal(IxcPlanMapper.map({id:"1",nome:"X"}).value,undefined,"sem valor legível continua ausente, nunca zero");
});

test("valor da fatura usa o que está em aberto, não o valor cheio",()=>{
  const parcial=IxcInvoiceMapper.map({id:"1",id_cliente:"9",status:"A",valor:"100.00",valor_aberto:"40.00"});
  assert.equal(parcial.value,40,"fatura paga pela metade não deve entrar como dívida cheia");
  const semAberto=IxcInvoiceMapper.map({id:"2",id_cliente:"9",status:"A",valor:"59.90"});
  assert.equal(semAberto.value,59.9,"sem valor_aberto, o valor cheio serve de reserva");
});
