import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFirstAccessExecutor, createLocalFirstAccess } from './executor.mjs';
import { createInitializationController } from '../../lib/platform/synthetic-initialization-controller.ts';
import { stagingDemoRequirements } from '../../lib/runtime/staging-demo.ts';
import { loadSyntheticSchema } from '../../scripts/prepare-synthetic-initialization.mjs';
import { Simulator, fresh } from '../../tests/helpers/synthetic-init-simulator.mjs';

for (const mode of ['provided-key','local-key','expired-before-post']) test(`executor → handlers reais, simulado: ${mode}`,async()=>{
  const origin='https://synthetic-test-fixture.onrender.com',token='c'.repeat(64);
  const config={...stagingDemoRequirements,...Object.fromEntries(['FEATURE_N8N_CHANNEL','FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])),NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',
    FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_WEB_DEMO:'true',
    SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1',SYNTHETIC_DEMO_ORIGIN:origin,
    SYNTHETIC_INIT_EXPIRES_AT:new Date(Date.now()+15*60*1000).toISOString(),SYNTHETIC_INIT_ENABLED:'true',SYNTHETIC_INIT_CAPABILITY_SHA256:createHash('sha256').update(token).digest('hex'),
    SYNTHETIC_INIT_DATABASE_HOST:'db.example.invalid',DATABASE_URL:'postgresql://lzr_synthetic_demo:invented@db.example.invalid/lzr_synthetic_demo'};
  const store=fresh(),clients=[],calls=[];
  const handle=createInitializationController({source:()=>config,processId:'synthetic-process-123',schema:loadSyntheticSchema,
    now:()=>new Date('2026-11-05T15:00:00Z'),connect:async()=>{const client=new Simulator(store);clients.push(client);return client;}});
  let clock=Date.now();
  const inputs=['APROVO_ALVO_DESCARTAVEL',...(mode==='provided-key'?[token]:[]),'invented-offline-password','invented-offline-password','INICIALIZAR_UMA_VEZ'];
  const dependencies={prompt:async()=>{const answer=inputs.shift();if(mode==='expired-before-post'&&answer==='INICIALIZAR_UMA_VEZ')clock+=900000;return answer;},derive:async()=>({hash:'a'.repeat(128),salt:'b'.repeat(32)}),
    transport:async(url,request)=>{calls.push(request.method);const response=await handle(new Request(url,request));return{status:response.status,body:await response.json()};}};
  const session=mode==='provided-key'?null:createLocalFirstAccess({...dependencies,random:()=>Buffer.alloc(32,0xcc),now:()=>clock});
  if(session)Object.assign(config,session.configuration);
  const run=session?session.run:createFirstAccessExecutor(dependencies);
  assert.deepEqual(await run({origin,databaseOid:'12345',attempt:'synthetic-init-executor-review'}),{state:mode==='expired-before-post'?'not-confirmed':'completion-confirmed',retryAllowed:false});
  assert.deepEqual(calls,mode==='expired-before-post'?['GET','GET']:['GET','GET','POST']);assert.equal(store.completed,mode!=='expired-before-post');assert.equal(clients.length,mode==='expired-before-post'?2:3);
  assert.equal((await run({origin,databaseOid:'12345',attempt:'synthetic-init-executor-review'})).state,'blocked');
  assert.equal(clients.length,mode==='expired-before-post'?2:3);assert.ok(clients.every(c=>c.destroyed===1));
});
