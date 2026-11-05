import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootstrapSyntheticAccounts } from '../lib/platform/synthetic-account-bootstrap.ts';
import { MemoryAuthRepository, login, resolveSession, changeOwnPassword } from '../lib/platform/auth.ts';

test('bootstrap aditivo → login → troca de senha revoga outra sessão, somente em memória',async()=>{
  const flags=['FEATURE_IXC_WRITE','IXC_WRITE_ENABLED','FEATURE_QUEUES','FEATURE_META_WHATSAPP','FEATURE_N8N_CHANNEL','FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_EVOLUTION','FEATURE_CHATWOOT','FEATURE_LANGFUSE','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'];
  const source={...Object.fromEntries(flags.map(key=>[key,'false'])),FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',LZR_ENV:'staging',NEXT_PUBLIC_LZR_ENV:'staging',LZR_RUNTIME_MODE:'mock',FEATURE_AUTH:'true',PILOT_MODE:'disabled',IXC_MODE:'disabled',IXC_TRANSPORT:'disabled',FEATURE_IXC_FULL_BASE:'false',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1'};
  const repository=new MemoryAuthRepository();const pending=[];let commits=0;
  // Transport maps the known INSERT contract into memory; does not execute SQL.
  const client={async query(sql,values){
    if(sql==='BEGIN'){pending.length=0;return {rows:[]};}
    if(sql==='ROLLBACK'){pending.length=0;return {rows:[]};}
    if(sql==='COMMIT'){repository.users.push(...pending);commits++;return {rows:[]};}
    assert.match(sql,/^INSERT INTO users/);
    const [id,email,name,role,passwordHash,passwordSalt]=values;
    pending.push({id,email,name,role,passwordHash,passwordSalt,active:true,mustChangePassword:true});return {rows:[{id}]};
  }};
  const password=randomUUID();const replacement=randomUUID();const email='bootstrap-bridge@example.invalid';
  const result=await bootstrapSyntheticAccounts(client,[{email,password,name:'DEMO Bridge',role:'Supervisor'}],source);
  assert.equal(commits,1);assert.equal(result.created.length,1);
  const current=await login(repository,email,password);const other=await login(repository,email,password);
  assert.ok(current&&other);assert.equal(current.mustChangePassword,true);
  await changeOwnPassword(repository,current.user.id,current.token,password,replacement);
  assert.equal((await resolveSession(repository,current.token)).id,current.user.id);
  assert.equal(await resolveSession(repository,other.token),undefined);
  assert.equal(await login(repository,email,password),undefined);
  const renewed=await login(repository,email,replacement);assert.equal(renewed.mustChangePassword,false);
});
