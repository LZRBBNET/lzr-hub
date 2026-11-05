import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSyntheticBootstrap } from '../lib/platform/synthetic-bootstrap-reconciliation.ts';
const off=['FEATURE_IXC_WRITE','IXC_WRITE_ENABLED','FEATURE_QUEUES','FEATURE_META_WHATSAPP','FEATURE_N8N_CHANNEL','FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_EVOLUTION','FEATURE_CHATWOOT','FEATURE_LANGFUSE','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'];
const source={...Object.fromEntries(off.map(key=>[key,'false'])),FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',LZR_ENV:'staging',NEXT_PUBLIC_LZR_ENV:'staging',LZR_RUNTIME_MODE:'mock',FEATURE_AUTH:'true',PILOT_MODE:'disabled',IXC_MODE:'disabled',IXC_TRANSPORT:'disabled',FEATURE_IXC_FULL_BASE:'false',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1'};
const expected=[{id:'synthetic-id',email:'operator@example.invalid',role:'Supervisor'}];
for(const [rows,state]of [[[],'absent'],[[{...expected[0],name:'DEMO Operator',active:true}],'matching'],[[{...expected[0],id:'other',name:'DEMO Operator',active:true}],'conflict']])test(`reconciliação somente leitura: ${state}`,async()=>{
  let reads=0;const result=await inspectSyntheticBootstrap({async query(sql,values){reads++;assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/password|salt|hash|INSERT|DELETE|UPDATE|BEGIN/i);assert.deepEqual(values,[['operator@example.invalid']]);return {rows};}},expected,source);
  assert.equal(reads,1);assert.equal(result.accounts[0].state,state);assert.equal(result.retryAllowed,false);assert.equal(result.credentialsVerified,false);
});
test('falha de leitura é desconhecida, sanitizada e não permite replay',async()=>{
  const result=await inspectSyntheticBootstrap({async query(){throw Error('synthetic-private-error');}},expected,source);
  assert.equal(result.state,'unknown');assert.equal(result.retryAllowed,false);assert.doesNotMatch(JSON.stringify(result),/private/);
});
test('produção e escopo não sintético negados antes de leitura',async()=>{
  const client={async query(){assert.fail('No query permitted');}};
  await assert.rejects(inspectSyntheticBootstrap(client,expected,{...source,LZR_ENV:'production'}));
  await assert.rejects(inspectSyntheticBootstrap(client,[{...expected[0],email:'other@example.com'}],source));
});

for(const [label,rows]of [
  ['duplicate',[{...expected[0],name:'DEMO A',active:true},{...expected[0],name:'DEMO A',active:true}]],
  ['out-of-scope',[{...expected[0],email:'outside@example.invalid',name:'DEMO A',active:true}]],
  ['missing-fields',[{email:expected[0].email}]],
  ['invalid-type',[{...expected[0],name:'DEMO A',active:'true'}]],
  ['null-row',[null]],['non-array',null],
])test(`resposta ambígua ${label} nunca confirma conta ou retry`,async()=>{
  let reads=0;const result=await inspectSyntheticBootstrap({async query(){reads++;return {rows};}},expected,source);
  assert.equal(reads,1);assert.equal(result.state,'unknown');assert.deepEqual(result.accounts,[]);assert.equal(result.retryAllowed,false);
});
for(const invalid of [null,{},[],[null],[{...expected[0],id:10}],[expected[0],{...expected[0],email:'other@example.invalid'}]])test(`escopo malformado não consulta banco: ${JSON.stringify(invalid)}`,async()=>{
  await assert.rejects(inspectSyntheticBootstrap({async query(){assert.fail('No query permitted');}},invalid,source),/SCOPE_INVALID/);
});
