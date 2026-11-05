import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLocalFirstAccess } from './executor.mjs';
import { initializationAccess } from '../../lib/platform/synthetic-initialization-access.ts';
import { stagingDemoRequirements } from '../../lib/runtime/staging-demo.ts';
const at=Date.parse('2026-11-05T22:00:00.000Z');
const token='ab'.repeat(32); // Invented bytes, never real entropy or credential generation.
const source=()=>({...stagingDemoRequirements,...Object.fromEntries(['FEATURE_N8N_CHANNEL','FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])),NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_WEB_DEMO:'true',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1',SYNTHETIC_DEMO_ORIGIN:'https://synthetic-test-fixture.onrender.com',SYNTHETIC_INIT_ENABLED:'true',SYNTHETIC_INIT_CAPABILITY_SHA256:createHash('sha256').update(token).digest('hex'),SYNTHETIC_INIT_EXPIRES_AT:new Date(at+900000).toISOString()});
const request=key=>new Request('https://synthetic-test-fixture.onrender.com/api/demo/initialize',{headers:{'x-synthetic-init-capability':key}});
test('servidor aceita chave bruta somente com verificador e prazo válidos; verificador não autentica',()=>{
  assert.equal(initializationAccess(request(token),source(),at),true);
  for(const key of [source().SYNTHETIC_INIT_CAPABILITY_SHA256,'cd'.repeat(32),'',token.toUpperCase()])assert.equal(initializationAccess(request(key),source(),at),false);
  for(const expiry of [undefined,'bad',new Date(at).toISOString(),new Date(at-1).toISOString(),new Date(at+1800001).toISOString(),'2026-11-05T22:15:00Z'])assert.equal(initializationAccess(request(token),{...source(),SYNTHETIC_INIT_EXPIRES_AT:expiry},at),false);
  assert.equal(initializationAccess(request(token),source(),at+900000),false);
  assert.equal(initializationAccess(request(token),source(),Number.NaN),false);
  assert.equal(initializationAccess(request(token),{...source(),SYNTHETIC_INIT_ENABLED:'false'},at),false);
});
test('sessão local expõe somente verificador/prazo e recusa uso expirado/segunda tentativa',async()=>{
  let clock=at,calls=0;const bytes=Buffer.alloc(32,0xab);
  const session=createLocalFirstAccess({random:n=>{assert.equal(n,32);return bytes;},now:()=>clock,prompt:async()=>{throw new Error('test cancellation');},derive:async()=>{throw new Error('unused');},transport:async()=>{calls++;}});
  assert.deepEqual(Object.keys(session).sort(),['configuration','observeTarget','run']);
  assert.equal(session.configuration.SYNTHETIC_INIT_CAPABILITY_SHA256,source().SYNTHETIC_INIT_CAPABILITY_SHA256);
  assert.equal(bytes.every(x=>x===0),true);assert.doesNotMatch(JSON.stringify(session),new RegExp(token));
  clock=at+900000;assert.equal((await session.run({})).state,'expired');assert.equal((await session.run({})).state,'blocked');assert.equal(calls,0);
});
test('sem canal de chave: sessão injeta chave apenas no header e não pede capability',async()=>{
  let prompts=0;const keys=[];
  const session=createLocalFirstAccess({random:()=>Buffer.alloc(32,0xab),now:()=>at,
    prompt:async label=>{keys.push(label);prompts++;return prompts===1?'APROVO_ALVO_DESCARTAVEL':'unused';},
    derive:async()=>{throw new Error('unused');},transport:async(url,options)=>{assert.equal(options.headers['x-synthetic-init-capability'],token);throw new Error('offline refusal');}});
  const target={origin:source().SYNTHETIC_DEMO_ORIGIN,databaseOid:'12345',attempt:'synthetic-init-local-review'};
  assert.equal((await session.run(target)).state,'refused');assert.equal((await session.run(target)).state,'blocked');
  assert.equal(keys.some(x=>/capability/i.test(x)),false);
});

test('OID pode ser observado por GET autenticado antes da aprovação; leitura não executa POST',async()=>{
  const calls=[];const session=createLocalFirstAccess({random:()=>Buffer.alloc(32,0xab),now:()=>at,prompt:async()=>{throw new Error('not approved');},derive:async()=>{throw new Error('unused');},
    transport:async(url,req)=>{calls.push(req);return {status:200,body:{processId:'synthetic-process-123',databaseOid:'12345',available:true,freshManualApprovalRequired:true,retryAllowed:false}};}});
  assert.deepEqual(await session.observeTarget({origin:source().SYNTHETIC_DEMO_ORIGIN,attempt:'synthetic-init-local-review'}),{databaseOid:'12345',processId:'synthetic-process-123'});
  await assert.rejects(session.observeTarget({origin:source().SYNTHETIC_DEMO_ORIGIN,attempt:'synthetic-init-local-review'}));
  assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(calls[0].headers['x-synthetic-init-capability'],token);
  assert.equal((await session.run({origin:source().SYNTHETIC_DEMO_ORIGIN,databaseOid:'12345',attempt:'synthetic-init-local-review'})).state,'refused');
  assert.equal(calls.length,1,'without approval there is no subsequent network or POST');
});
