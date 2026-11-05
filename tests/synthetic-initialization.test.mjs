import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSyntheticInitializer, verifySyntheticSchema, verifySyntheticJournal, EMPTY_SQL } from '../lib/platform/synthetic-initialization.ts';
import { loadSyntheticSchema } from '../scripts/prepare-synthetic-initialization.mjs';
import { Simulator, fresh } from './helpers/synthetic-init-simulator.mjs';
import { stagingDemoRequirements } from '../lib/runtime/staging-demo.ts';

const files=await loadSyntheticSchema();
const source=()=>({...stagingDemoRequirements,...Object.fromEntries(['FEATURE_N8N_CHANNEL','FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])),NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',
  FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_WEB_DEMO:'true',
  SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1',SYNTHETIC_DEMO_ORIGIN:'https://review.example.invalid'});
const approval=()=>({databaseOid:'12345',attempt:'synthetic-init-review-20261105',confirmation:'CREATE_EMPTY_SYNTHETIC_DATABASE_V1'});
// Invented bytes only; no password, account, random credential or hash is generated.
const login=()=>({hash:'a'.repeat(128),salt:'b'.repeat(32)});
const now=new Date('2026-11-05T15:00:00Z');
const run=(client,init=createSyntheticInitializer(),config=source(),permission=approval(),bundle=files,material=login())=>init(client,config,permission,bundle,material,now);
test('schema exato de 20 migrações; bundle alterado/reordenado/incompleto recusado sem query',async()=>{
  assert.equal(verifySyntheticSchema(files).length,20);
  const journal=JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json',import.meta.url)));
  verifySyntheticJournal(journal);
  assert.throws(()=>verifySyntheticJournal({...journal,entries:[...journal.entries,journal.entries[0]]}));
  assert.throws(()=>verifySyntheticJournal({...journal,entries:journal.entries.map((e,i)=>i===0?{...e,when:1}:e)}));
  for(const bundle of [files.slice(1),[...files].reverse(),files.map((f,i)=>i===0?{...f,sql:f.sql+'\nDROP TABLE users;'}:f)]){
    const client=new Simulator();await assert.rejects(run(client,undefined,undefined,undefined,bundle));assert.equal(client.calls.length,0);
  }
});
test('gates, confirmação, identidade e vazio explícitos antes de qualquer escrita',async()=>{
  for(const override of [{LZR_ENV:'production'},{FEATURE_AUTH:'false'},{SYNTHETIC_WEB_DEMO:'false'},{FEATURE_QUEUES:'true'}, {SYNTHETIC_DATABASE_CONFIRMATION:''}]){
    const client=new Simulator();await assert.rejects(run(client,undefined,{...source(),...override}));assert.equal(client.calls.length,0);
  }
  for(const permission of [{...approval(),databaseOid:''},{...approval(),confirmation:'yes'},{...approval(),attempt:'real-customer'}]){
    const client=new Simulator();await assert.rejects(run(client,undefined,undefined,permission));assert.equal(client.calls.length,0);
  }
  for(const change of [c=>c.identity={database:'production'},c=>c.identity={owner:'production'},c=>c.identity={oid:'54321'},c=>c.peers=1,c=>c.locked=false,c=>c.store.objects=1]){
    const client=new Simulator();change(client);await assert.rejects(run(client),/NO_RETRY/);assert.equal(client.calls.filter(c=>c.sql.startsWith('CREATE')).length,0);assert.equal(client.destroyed,1);
  }
});
test('reserva durável separada; schema/journal/conta/atendimento/régua aditivos na mesma transação',async()=>{
  const client=new Simulator(),init=createSyntheticInitializer();
  const result=await run(client,init);assert.deepEqual(result,{status:'confirmed',synthetic:true,retryAllowed:false,credentialsReturned:false,delivered:false});
  assert.equal(client.commits,2);assert.equal(client.destroyed,1);assert.equal(client.store.completed,true);
  const journal=client.store.rows.filter(r=>r.sql.startsWith('INSERT INTO drizzle.__drizzle_migrations'));assert.equal(journal.length,20);
  assert.deepEqual(journal.map(r=>r.values[1]),JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json',import.meta.url))).entries.map(e=>e.when));
  assert.equal(client.store.rows.filter(r=>r.sql.startsWith('INSERT INTO public.users')).length,1);
  assert.ok(client.store.rows.some(r=>r.sql.startsWith('INSERT INTO channel_messages')));
  assert.ok(client.store.rows.some(r=>r.sql.startsWith('INSERT INTO public.collection_rule_steps')));
  assert.ok(client.calls.every(c=>!c.sql.includes('ON CONFLICT')));
  assert.doesNotMatch(JSON.stringify(result),/aaaa|bbbb|example.invalid/);
  const before=client.calls.length;await assert.rejects(run(client,init));assert.equal(client.calls.length,before);
  const restarted=new Simulator(client.store);await assert.rejects(run(restarted),/NO_RETRY/);
  assert.equal(restarted.calls.some(c=>c.sql==='BEGIN'),false);
});
test('falha antes/depois de cada comando nunca dispara replay; reserva preserva bloqueio pós-restart',async t=>{
  const control=new Simulator();await run(control);
  for(let index=1;index<=control.calls.length;index++)for(const outcome of ['before','after']){
    const client=new Simulator(fresh(),at=>at===index?outcome:false),init=createSyntheticInitializer();
    await assert.rejects(run(client,init),/NO_RETRY/);assert.equal(client.destroyed,1);
    const before=client.calls.length;await assert.rejects(run(client,init));assert.equal(client.calls.length,before);
    if(client.store.reserved){const restarted=new Simulator(client.store);await assert.rejects(run(restarted),/NO_RETRY/);assert.equal(restarted.calls.some(c=>c.sql.startsWith('CREATE')),false);}
  }
  t.diagnostic(JSON.stringify({failureScenarios:control.calls.length*2,credentialsGenerated:false,realSqlExecuted:false}));
});
test('falhas de rollback/disposal e drift de configuração não produzem confirmação nem retry',async()=>{
  const client=new Simulator(fresh(),(at,sql)=>sql==='ROLLBACK'||sql==='CREATE SCHEMA drizzle'?'before':false);
  await assert.rejects(run(client),/NO_RETRY/);assert.equal(client.store.reserved,true);assert.equal(client.destroyed,1);
  const dispose=new Simulator();dispose.failDestroy=true;await assert.rejects(run(dispose),/DISPOSAL_NOT_CONFIRMED_NO_RETRY/);assert.equal(dispose.store.completed,true);
  const config=source(),drift=new Simulator();const query=drift.query.bind(drift);
  drift.query=async(...args)=>{const result=await query(...args);if(args[0]===EMPTY_SQL)config.FEATURE_AUTH='false';return result;};
  await assert.rejects(run(drift,undefined,config),/NO_RETRY/);assert.equal(drift.calls.some(c=>c.sql.startsWith('CREATE')),false);
  const raced=new Simulator(),queryRace=raced.query.bind(raced);
  raced.query=async(...args)=>{const result=await queryRace(...args);if(args[0]==='COMMIT'&&raced.commits===1)raced.store.objects=1;return result;};
  await assert.rejects(run(raced),/NO_RETRY/);assert.equal(raced.store.reserved,true);
  assert.equal(raced.calls.some(c=>c.sql==='CREATE SCHEMA drizzle'),false);
});
