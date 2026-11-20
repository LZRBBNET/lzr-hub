import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { awaitingSinceFrom } from "../lib/platform/conversation-state-shared.ts";
import { conversationPage } from "../lib/platform/conversation-pages.ts";
import { initialConversationSelection } from "../lib/platform/conversation-selection.ts";

const customer = {role:"customer",createdAt:"2026-01-01T00:00:00.000Z"};
test("accepted reply becoming failed restores the unanswered customer; no proof of delivery inferred",()=>{
  for (const sentBy of ["local-operator","ia-agente"]) {
    const reply={role:"agent",sentBy,createdAt:"2026-01-01T00:01:00.000Z",deliveryStatus:"sent"};
    assert.equal(awaitingSinceFrom([reply,customer]),undefined);
    assert.equal(awaitingSinceFrom([{...reply,deliveryStatus:"failed"},customer]),customer.createdAt);
    for(const deliveryStatus of [null,undefined,"unknown","delivered","read"]) {
      // Preserve prior accepted/legacy boundary; an absent receipt is not a failure or delivered receipt.
      assert.equal(awaitingSinceFrom([{...reply,deliveryStatus},customer]),undefined);
    }
  }
  assert.equal(awaitingSinceFrom([{role:"agent",sentBy:"ia",deliveryStatus:"sent"},customer]),customer.createdAt);
});

test("failed latest reply cannot hide a newer pending question; earlier valid reply still bounds wait",()=>{
  const earlier={role:"agent",sentBy:"local",createdAt:"2026-01-01T00:00:30.000Z",deliveryStatus:"read"};
  const newer={...customer,createdAt:"2026-01-01T00:01:00.000Z"};
  const failed={...earlier,createdAt:"2026-01-01T00:02:00.000Z",deliveryStatus:"failed"};
  assert.equal(awaitingSinceFrom([failed,newer,earlier,customer]),newer.createdAt);
});

test("page SQL uses null-safe failure predicate and restores bounded scoped previews/author/handoff",async()=>{
  let query;
  await conversationPage({execute:async q=>{query=new PgDialect().sqlToQuery(q);return {rows:[{items:[],total:0,pendingCount:0,mineCount:0,oldestPendingAt:null}]};}},{view:"fila"});
  assert.match(query.sql,/m.delivery_status is distinct from 'failed'/);
  assert.match(query.sql,/'deliveryStatus', last_msg.delivery_status/);
  assert.match(query.sql,/'lastCustomerMessage', left\(customer_msg.content, 500\)/);
  assert.match(query.sql,/'lastSentByName', case when last_msg.sent_by in \('ia','ia-agente'\)/);
  assert.match(query.sql,/'handoff', case when p.stage = 'handoff'/);
  assert.match(query.sql,/o.channel = p.channel and o.external_conversation_id = p.id/);
  assert.match(query.sql,/m.channel = p.channel and m.external_conversation_id = p.id and m.role = 'customer'/);
  assert.match(query.sql,/select name from users u where u.email = last_msg.sent_by limit 1/);
});

test("explicit missing, wrong-channel or ambiguous target never selects another conversation",()=>{
  const list=[{channel:"local-a",externalConversationId:"case-a"},{channel:"local-b",externalConversationId:"case-b"}];
  assert.equal(initialConversationSelection(list,"local-a:missing"),undefined);
  assert.equal(initialConversationSelection(list,"local-b:case-a"),undefined);
  assert.equal(initialConversationSelection([],"local-a:case-a"),undefined);
  assert.equal(initialConversationSelection(list,""),undefined);
  assert.equal(initialConversationSelection(list,"local-b:case-b"),list[1]);
  assert.equal(initialConversationSelection(list),list[0]);
  assert.equal(initialConversationSelection([{channel:"a:b",externalConversationId:"c"},{channel:"a",externalConversationId:"b:c"}],"a:b:c"),undefined);
});

test("UI opens only a successfully selected target and visibly refuses missing deep links",()=>{
  const ui=readFileSync(new URL('../components/modules/attendance.tsx',import.meta.url),'utf8');
  assert.match(ui,/const wanted = initialConversationSelection\(list, initialRef.current\)/);
  assert.match(ui,/if \(wanted\) \{ open\(wanted\)/);
  assert.doesNotMatch(ui,/open\(wanted \?\? list\[0\]\)/);
  assert.match(ui,/else if \(initialRef.current !== undefined\) setInitialUnavailable\(true\)/);
  assert.match(ui,/Nenhum outro atendimento foi aberto/);
  assert.match(ui,/Falha de entrega/);
});
