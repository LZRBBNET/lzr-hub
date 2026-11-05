import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootstrapSyntheticAccounts } from '../lib/platform/synthetic-account-bootstrap.ts';
import { createSyntheticInvoiceDemo } from '../lib/integrations/ixc/synthetic-demo.ts';
import { verifyPassword } from '../lib/platform/auth.ts';

const source=()=>({...Object.fromEntries(['FEATURE_IXC_WRITE','IXC_WRITE_ENABLED','FEATURE_QUEUES','FEATURE_META_WHATSAPP','FEATURE_N8N_CHANNEL','FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_EVOLUTION','FEATURE_CHATWOOT','FEATURE_LANGFUSE','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(key=>[key,'false'])),LZR_ENV:'staging',NEXT_PUBLIC_LZR_ENV:'staging',LZR_RUNTIME_MODE:'mock',PILOT_MODE:'disabled',IXC_MODE:'disabled',IXC_TRANSPORT:'disabled',FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1'});
const account=()=>({email:'operator@example.invalid',name:'DEMO Operador',role:'Supervisor',password:randomUUID()});
function transport(fail) {
  const calls=[];return {calls,async query(sql,values){calls.push({sql,values});if(fail?.(sql,values,calls))throw Error('synthetic-private-connection-detail');return {rows:values?[{id:values[0]}]:[]};}};
}
test('bootstrap só insere, parametriza e armazena hash, sem devolver credenciais',async()=>{
  const client=transport();const input=account();const result=await bootstrapSyntheticAccounts(client,[input],source());
  assert.equal(client.calls[0].sql,'BEGIN');assert.equal(client.calls.at(-1).sql,'COMMIT');
  const insert=client.calls[1];assert.match(insert.sql,/ON CONFLICT \(email\) DO NOTHING RETURNING id/);assert.doesNotMatch(insert.sql,/\b(?:DELETE|TRUNCATE|UPDATE)\b/i);
  assert.ok(!JSON.stringify(client.calls).includes(input.password));assert.ok(!JSON.stringify(result).includes(input.password));
  assert.equal(await verifyPassword(input.password,insert.values[4],insert.values[5]),true);
  assert.equal(result.created.length,1);assert.equal(result.credentialsReturned,false);
});
for(const over of [{LZR_ENV:'production'},{FEATURE_AUTH:'false'},{SYNTHETIC_DATABASE_CONFIRMATION:''},{FEATURE_SYNTHETIC_INVOICES:'false'}])test(`bootstrap recusa contexto inseguro ${Object.keys(over)[0]}`,async()=>{
  const client=transport();await assert.rejects(bootstrapSyntheticAccounts(client,[account()],{...source(),...over}));assert.equal(client.calls.length,0);
});
test('bootstrap recusa conta real, papel administrador, duplicata e senha curta antes de SQL',async()=>{
  for(const inputs of [[{...account(),email:'real@example.com'}],[{...account(),role:'Administrador'}],[account(),account()],[{...account(),password:'short'}]]){
    const client=transport();await assert.rejects(bootstrapSyntheticAccounts(client,inputs,source()));assert.equal(client.calls.length,0);
  }
});
test('conflito de conta nunca sobrescreve existente e aborta transação',async()=>{
  const calls=[];const client={async query(sql){calls.push(sql);return {rows:[]};}};
  await assert.rejects(bootstrapSyntheticAccounts(client,[account()],source()),/NOT_CONFIRMED/);
  assert.equal(calls.at(-1),'ROLLBACK');assert.ok(!calls.includes('COMMIT'));
});
for(const phase of ['BEGIN','INSERT','COMMIT','ROLLBACK'])test(`falha ${phase} não expõe erro bruto nem repete escrita`,async()=>{
  const client=transport(sql=>sql.startsWith(phase)||(phase==='ROLLBACK'&&sql.startsWith('INSERT')));
  await assert.rejects(bootstrapSyntheticAccounts(client,[account()],source()),error=>!error.message.includes('private')&&/SYNTHETIC_BOOTSTRAP/.test(error.message));
  assert.ok(client.calls.filter(c=>c.sql.startsWith('INSERT')).length<=1);
});
test('reset exige confirmação, reabre só memória, invalida cache e continua bloqueado em produção',async()=>{
  const env=source();const demo=createSyntheticInvoiceDemo(()=>env);demo.markPaid();
  assert.equal((await demo.provider.getSnapshot('10','synthetic')).invoices[0].status,'R');
  assert.throws(()=>demo.reset('wrong'));assert.equal((await demo.provider.getInvoiceForCustomer('10','901','synthetic')).status,'R');
  const result=demo.reset('RESET_SYNTHETIC_INVOICE_901');assert.equal(result.databaseReset,false);assert.equal(result.delivered,false);
  assert.equal((await demo.provider.getSnapshot('10','synthetic')).invoices[0].status,'A');
  assert.equal(demo.reset('RESET_SYNTHETIC_INVOICE_901').status,'A');
  env.LZR_ENV='production';assert.throws(()=>demo.reset('RESET_SYNTHETIC_INVOICE_901'));
});
