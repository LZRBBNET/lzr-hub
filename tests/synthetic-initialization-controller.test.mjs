import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createInitializationController } from '../lib/platform/synthetic-initialization-controller.ts';
import { initializationAccess } from '../lib/platform/synthetic-initialization-access.ts';
import { loadSyntheticSchema } from '../scripts/prepare-synthetic-initialization.mjs';
import { stagingDemoRequirements } from '../lib/runtime/staging-demo.ts';
import { Simulator, fresh } from './helpers/synthetic-init-simulator.mjs';
import { initializationTarget } from '../lib/platform/synthetic-initialization-target.ts';
import { Client } from 'pg';

const token='c'.repeat(64); // Fixed, invented test token; never an operator credential.
const source=()=>({...stagingDemoRequirements,...Object.fromEntries(['FEATURE_N8N_CHANNEL','FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])),NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',
  FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_WEB_DEMO:'true',
  SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1',SYNTHETIC_DEMO_ORIGIN:'https://review.example.invalid',
  SYNTHETIC_INIT_ENABLED:'true',SYNTHETIC_INIT_CAPABILITY_SHA256:createHash('sha256').update(token).digest('hex'),
  SYNTHETIC_INIT_DATABASE_HOST:'db.example.invalid',DATABASE_URL:'postgresql://lzr_synthetic_demo:invented@db.example.invalid/lzr_synthetic_demo'});
const request=(method='GET',body,headers={})=>new Request('https://review.example.invalid/api/demo/initialize',{
  method,headers:{'x-synthetic-init-capability':token,origin:'https://review.example.invalid',...headers},...(body?{body:JSON.stringify(body)}:{})});
const body=(processId='boot-one')=>({processId,databaseOid:'12345',attempt:'synthetic-init-review-20261105',
  confirmation:'CREATE_EMPTY_SYNTHETIC_DATABASE_V1',hash:'a'.repeat(128),salt:'b'.repeat(32)});
function fixture(processId='boot-one',store=fresh(),fail=()=>false){
  let connects=0;const clients=[];const config=source();
  const handle=createInitializationController({source:()=>config,processId,schema:loadSyntheticSchema,now:()=>new Date('2026-11-05T15:00:00Z'),
    connect:async snapshot=>{assert.equal(snapshot.DATABASE_URL,config.DATABASE_URL);connects++;const client=new Simulator(store,fail);clients.push(client);return client;}});
  return {handle,config,store,clients,connects:()=>connects};
}
test('controller não inicia DB no import/startup; autorização forte independente de cookie e target exato',async()=>{
  const f=fixture();assert.equal(f.connects(),0);
  for(const override of [{SYNTHETIC_INIT_ENABLED:undefined},{FEATURE_AUTH:'false'},{SYNTHETIC_INIT_CAPABILITY_SHA256:''}]){
    const g=fixture();Object.assign(g.config,override);assert.equal((await g.handle(request())).status,404);assert.equal(g.connects(),0);
  }
  assert.equal(initializationAccess(request('GET',undefined,{'x-synthetic-init-capability':'d'.repeat(64)}),f.config),false);
  assert.equal((await f.handle(request('GET',undefined,{'x-synthetic-init-capability':''}))).status,404);
  f.config.SYNTHETIC_INIT_DATABASE_HOST='other.example.invalid';assert.equal((await f.handle(request())).status,400);assert.equal(f.connects(),0);
});
test('GET só lê; POST exige novo consentimento vinculado ao processo e preflight vazio',async()=>{
  const f=fixture();assert.equal((await f.handle(request('POST',body()))).status,400);assert.equal(f.connects(),0);
  const preflight=await f.handle(request());assert.equal(preflight.status,200);assert.equal((await preflight.json()).databaseOid,'12345');
  assert.ok(f.clients[0].calls.every(c=>c.sql.startsWith('SELECT ')||c.sql==='SET search_path = pg_catalog'));assert.equal(f.clients[0].destroyed,1);
  for(const invalid of [{...body(),processId:'old-process'},{...body(),databaseOid:'54321'},{...body(),sql:'DROP TABLE users'},{...body(),hash:'bad'}]){
    assert.equal((await f.handle(request('POST',invalid))).status,400);assert.equal(f.connects(),1);
  }
  assert.equal((await f.handle(request('POST',body(),{origin:'https://other.example.invalid'}))).status,403);assert.equal(f.connects(),1);
  const old=f.config.DATABASE_URL;f.config.DATABASE_URL='postgresql://lzr_synthetic_demo:other-invented@db.example.invalid/lzr_synthetic_demo';
  assert.equal((await f.handle(request('POST',body()))).status,400);assert.equal(f.connects(),1);f.config.DATABASE_URL=old;
  const result=await f.handle(request('POST',body()));assert.equal(result.status,201);
  const text=await result.text();assert.doesNotMatch(text,/aaaa|bbbb|invented|example.invalid|postgres/);
  const prior=f.connects();assert.equal((await f.handle(request('POST',body()))).status,409);assert.equal(f.connects(),prior);
  assert.equal((await f.handle(request())).status,409);assert.equal(f.connects(),prior);
});
test('POST antigo após restart é recusado antes de conexão, mesmo se reserva incerta ficou ausente',async()=>{
  const old=fixture('boot-one',fresh(),(at,sql)=>sql==='BEGIN'?'before':false);
  assert.equal((await old.handle(request())).status,200);
  assert.equal((await old.handle(request('POST',body('boot-one')))).status,503);assert.equal(old.store.reserved,false);
  const f=fixture('boot-two',old.store);assert.equal((await f.handle(request('POST',body('boot-one')))).status,400);assert.equal(f.connects(),0);
  assert.equal((await f.handle(request())).status,200);
  assert.equal((await f.handle(request('POST',body('boot-one')))).status,400);assert.equal(f.connects(),1);
  assert.equal((await f.handle(request('POST',body('boot-two')))).status,201);
});
test('incerteza consome tentativa, sem retry; reserva bloqueia novo processo; rollback e erros sanitizados',async()=>{
  const f=fixture('boot-one',fresh(),(at,sql)=>sql==='CREATE SCHEMA drizzle'?'before':false);
  assert.equal((await f.handle(request())).status,200);
  const response=await f.handle(request('POST',body()));assert.equal(response.status,503);assert.equal(f.store.reserved,true);
  assert.doesNotMatch(await response.text(),/invented-private-error|aaaa|bbbb/);
  const prior=f.connects();assert.equal((await f.handle(request('POST',body()))).status,409);assert.equal(f.connects(),prior);
  const restarted=fixture('boot-two',f.store);assert.equal((await restarted.handle(request())).status,503);
  assert.equal((await restarted.handle(request('POST',body('boot-two')))).status,400);
  assert.ok(restarted.clients[0].calls.every(c=>c.sql.startsWith('SELECT ')||c.sql==='SET search_path = pg_catalog'));
});
test('revisão: POSTs concorrentes não abrem uma segunda conexão',async()=>{
  const f=fixture();assert.equal((await f.handle(request())).status,200);
  const results=await Promise.all([f.handle(request('POST',body())),f.handle(request('POST',body()))]);
  assert.equal(f.connects(),2,'one preflight + one initialization connection');
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
});
test('revisão: parâmetros de URL que mudam conexão são recusados antes de conectar',async()=>{
  for(const query of ['?port=6543','?host=other.example.invalid','?options=-c%20role%3Dother','#fragment',':invalid']){
    const f=fixture();f.config.DATABASE_URL+=query;
    assert.equal((await f.handle(request())).status,400);assert.equal(f.connects(),0);
  }
});
test('revisão: driver recebe alvo explícito, sem fallback de variáveis PG ou URI bruta',async()=>{
  const overrides={PGHOST:'other.example.invalid',PGPORT:'6543',PGUSER:'other',PGPASSWORD:'other-invented',PGDATABASE:'other',PGOPTIONS:'-c role=other',PGSSLMODE:'require'};
  const saved=Object.fromEntries(Object.keys(overrides).map(k=>[k,process.env[k]]));Object.assign(process.env,overrides);
  try {
    const config=initializationTarget(source());assert.equal(config.connectionString,undefined);
    const client=new Client(config),p=client.connectionParameters;
    assert.equal(p.host,'db.example.invalid');assert.equal(p.port,5432);assert.equal(p.user,'lzr_synthetic_demo');
    assert.equal(p.database,'lzr_synthetic_demo');assert.equal(p.password,'invented');assert.equal(p.options,'-c search_path=pg_catalog');assert.equal(p.ssl,false);
    await client.end(); // Constructor/parameters only: connect is never called.
  } finally {for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test('revisão: GET concorrente mantém exclusividade e não invalida consentimento em andamento',async()=>{
  let release;const wait=new Promise(resolve=>{release=resolve;});let connects=0;
  const config=source(),store=fresh();
  const handle=createInitializationController({source:()=>config,processId:'boot-one',schema:loadSyntheticSchema,now:()=>new Date('2026-11-05T15:00:00Z'),
    connect:async()=>{connects++;if(connects===1)await wait;return new Simulator(store);}});
  const pending=handle(request());
  assert.equal((await handle(request())).status,409);
  assert.equal((await handle(statusRequest())).status,409);
  assert.equal((await handle(request('POST',body()))).status,409);assert.equal(connects,1);
  release();assert.equal((await pending).status,200);
  assert.equal((await handle(request('POST',body()))).status,201);assert.equal(connects,2);
});

const statusRequest=(oid='12345',attempt='synthetic-init-review-20261105',headers={})=>new Request(
  `https://review.example.invalid/api/demo/initialize?status=1&databaseOid=${oid}&attempt=${attempt}`,
  {headers:{'x-synthetic-init-capability':token,...headers}});
const readOnlyCalls=client=>assert.ok(client.calls.every(({sql})=>sql.startsWith('SELECT ')||sql.startsWith('SET LOCAL ')||
  ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','COMMIT','ROLLBACK'].includes(sql)));
test('status autenticado observa ausência sem consentir escrita; configuração e escopo recusados antes de conectar',async()=>{
  const f=fixture();assert.equal((await f.handle(statusRequest('12345',undefined,{'x-synthetic-init-capability':''}))).status,404);
  assert.equal(f.connects(),0);
  for(const [oid,attempt] of [['bad','synthetic-init-review-20261105'],['12345','bad']])assert.equal((await f.handle(statusRequest(oid,attempt))).status,400);
  const response=await f.handle(statusRequest());assert.equal(response.status,200);
  const value=await response.json();assert.equal(value.state,'absence-observed');assert.equal(value.retryAllowed,false);
  readOnlyCalls(f.clients[0]);assert.equal((await f.handle(request('POST',body()))).status,400,'status never grants preflight');
  f.config.SYNTHETIC_INIT_DATABASE_HOST='wrong.example.invalid';assert.equal((await f.handle(statusRequest())).status,400);assert.equal(f.connects(),1);
});
test('status permite reconciliação após commit de resposta incerta e restart, sem liberar POST',async()=>{
  let lost=false;
  const f=fixture('boot-one',fresh(),(at,sql)=>{if(sql==='COMMIT'&&f.store.completed&&!lost){lost=true;return 'after';}return false;});
  assert.equal((await f.handle(request())).status,200);
  assert.equal((await f.handle(request('POST',body()))).status,503);assert.equal(f.store.completed,true);
  const response=await f.handle(statusRequest());assert.equal(response.status,200);
  const text=await response.text(),value=JSON.parse(text);assert.equal(value.state,'completion-observed');assert.equal(value.manifestMatches,true);
  assert.equal(value.retryAllowed,false);assert.equal(value.credentialsVerified,false);
  assert.doesNotMatch(text,/invented|aaaa|bbbb|password|postgresql|DATABASE_URL|db.example.invalid/);
  readOnlyCalls(f.clients.at(-1));assert.equal((await f.handle(request('POST',body()))).status,409);
  const restarted=fixture('boot-two',f.store);assert.equal((await restarted.handle(statusRequest())).status,200);
  assert.equal((await restarted.handle(request('POST',body('boot-two')))).status,400);
  f.store.rows.find(r=>r.sql.startsWith('INSERT INTO drizzle.__drizzle_migrations')).values[0]='wrong';
  assert.equal((await restarted.handle(statusRequest())).status,503,'journal drift never confirms completion');
});
test('status reconhece reserva e falha fechada para manifesto, duplicação, identidade, transação ou disposal ambíguos',async()=>{
  const f=fixture('boot-one',fresh(),(at,sql)=>sql==='CREATE SCHEMA drizzle'?'before':false);
  await f.handle(request());await f.handle(request('POST',body()));
  assert.equal((await (await f.handle(statusRequest())).json()).state,'reservation-observed');
  for(const mutate of [store=>store.rows[0].values[1]='wrong',store=>store.rows.push(structuredClone(store.rows[0])),store=>store.objects=1]){
    const store=structuredClone(f.store);mutate(store);const g=fixture('boot-two',store);
    assert.equal((await g.handle(statusRequest())).status,503);readOnlyCalls(g.clients[0]);
  }
  assert.equal((await f.handle(statusRequest('54321'))).status,503);
  for(const fail of [(at,sql)=>sql==='COMMIT'?'after':false,(at,sql)=>sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'?'before':false]){
    const g=fixture('boot-two',f.store,fail);assert.equal((await g.handle(statusRequest())).status,503);assert.equal(g.clients[0].destroyed,1);
  }
});

test('status não publica confirmação quando descarte do cliente é incerto',async()=>{
  const f=fixture('boot-one',fresh(),()=>{f.clients.at(-1).failDestroy=true;return false;});
  const response=await f.handle(statusRequest());assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{state:'unknown',retryAllowed:false,credentialsVerified:false});
  readOnlyCalls(f.clients[0]);assert.equal(f.clients[0].destroyed,1);
});
