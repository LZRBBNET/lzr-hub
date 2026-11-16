import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSyntheticHandoffFixture, SYNTHETIC_HANDOFF_ID } from '../lib/platform/synthetic-handoff-fixture.ts';
import { stagingDemoRequirements } from '../lib/runtime/staging-demo.ts';
import { isNonCustomerConversation } from '../lib/platform/conversation-scope.ts';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { channelMessages, channelContacts, conversationOutcomes } from '../db/schema.ts';

const config=()=>({...stagingDemoRequirements,...Object.fromEntries(['FEATURE_N8N_CHANNEL','FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(key=>[key,'false'])),FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1'});
const now=new Date('2026-11-05T15:00:00Z');
for(const override of [{LZR_ENV:'production'},{FEATURE_AUTH:'false'},{FEATURE_SYNTHETIC_INVOICES:'false'},{DEMO_DATASET:''},{FEATURE_N8N_CHANNEL:'true'},{SYNTHETIC_DATABASE_CONFIRMATION:''}])test(`fixture de handoff recusa contexto: ${Object.keys(override)[0]}`,()=>assert.throws(()=>prepareSyntheticHandoffFixture({...config(),...override},now)));
test('plano é aditivo, determinístico, sem executor e compatível com colunas atuais',()=>{
  const plan=prepareSyntheticHandoffFixture(config(),now);
  assert.deepEqual(plan,prepareSyntheticHandoffFixture(config(),now));
  assert.equal(plan.executionAuthorized,false);assert.equal(plan.externalDelivery,false);assert.equal(plan.databaseReset,false);
  assert.equal(isNonCustomerConversation(SYNTHETIC_HANDOFF_ID),false);
  assert.equal(plan.message.role,'customer');assert.equal(plan.outcome.intentSource,'synthetic-fixture');
  assert.equal(plan.message.externalMessageId,undefined);assert.equal(plan.message.sentBy,undefined);
  const tables=new Map([channelContacts,channelMessages,conversationOutcomes].map(t=>{const c=getTableConfig(t);return [c.name,new Set(c.columns.map(col=>col.name))];}));
  for(const stmt of plan.statements){
    assert.match(stmt.sql,/^INSERT INTO /);assert.match(stmt.sql,/ON CONFLICT .* DO NOTHING/);
    assert.doesNotMatch(stmt.sql,/\b(?:DELETE|UPDATE|TRUNCATE|DROP|ALTER|BEGIN|COMMIT)\b/i);
    assert.doesNotMatch(stmt.sql,/conversation_states|sessions|users|collection_dispatches/);
    const match=/INSERT INTO (\w+) \(([^)]+)\)/.exec(stmt.sql);assert.ok(match);
    const columns=match[2].split(',');assert.equal(columns.length,stmt.values.length);
    assert.ok(columns.every(col=>tables.get(match[1]).has(col)));
    assert.ok(!stmt.sql.includes(plan.message.content),'content is parameterized');
  }
  assert.throws(()=>prepareSyntheticHandoffFixture(config(),new Date('invalid')));
});

test('repetição usa as mesmas chaves de conflito respaldadas pelo schema, sem sobrescrever',()=>{
  const first=prepareSyntheticHandoffFixture(config(),now);
  const later=prepareSyntheticHandoffFixture(config(),new Date('2026-11-06T15:00:00Z'));
  assert.equal(first.message.id,later.message.id);assert.equal(first.outcome.id,later.outcome.id);
  assert.equal(first.contact.channel,later.contact.channel);assert.equal(first.contact.externalConversationId,later.contact.externalConversationId);
  assert.notEqual(first.message.createdAt,later.message.createdAt);
  assert.equal(getTableConfig(channelMessages).columns.find(c=>c.name==='id').primary,true);
  assert.equal(getTableConfig(conversationOutcomes).columns.find(c=>c.name==='id').primary,true);
  assert.ok(getTableConfig(channelContacts).primaryKeys.some(k=>k.columns.map(c=>c.name).join(',')==='channel,external_conversation_id'));
  for(const stmt of later.statements){assert.match(stmt.sql,/DO NOTHING/);assert.doesNotMatch(stmt.sql,/\bUPDATE\b/);}
});
