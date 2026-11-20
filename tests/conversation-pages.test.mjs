import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { conversationPage, encodeConversationCursor, decodeConversationCursor, InvalidConversationCursor } from "../lib/platform/conversation-pages.ts";

const scope = {view:"fila", sector:"todos", actorId:"local-operator"};
const key = (id, channel="local-channel") => ({at:"2026-01-01T00:00:00.000Z", channel, id});
const row = (id, channel="local-channel") => ({firstAt:key(id).at,channel,externalConversationId:id,lastCustomerAt:key(id).at,
  stateRow:{status:"open",assigneeId:null,assigneeName:null,assignedAt:null,resolvedAt:null,resolvedBy:null}});
const database = (items, count=items.length) => {
  const calls=[];
  return {calls, execute: async query => {calls.push(new PgDialect().sqlToQuery(query));return {rows:[{items,total:count,pendingCount:count,mineCount:0,oldestPendingAt:key("x").at}]};}};

};

test("page has bounded output, total independent of length, and cursor for next page", async () => {
  const db=database([row("a"),row("b"),row("c")],100);
  const result=await conversationPage(db,{...scope,limit:2});
  assert.equal(result.items.length,2);assert.equal(result.total,100);assert.equal(result.pendingCount,100);
  assert.equal(result.hasMore,true);assert.deepEqual(decodeConversationCursor(result.nextCursor,scope).id,"b");
  assert.equal(result.items[0].firstAt,undefined);assert.equal(result.items[0].stateRow,undefined);
  assert.match(db.calls[0].sql,/order by first_at, channel, id limit \$/);
  assert.ok(db.calls[0].params.includes(3));
});

test("cursor retains channel tie breaker and rejects changed filters/identity", () => {
  const encoded=encodeConversationCursor(key("same-id","channel-b"),scope);
  assert.equal(decodeConversationCursor(encoded,scope).channel,"channel-b");
  for(const changed of [{sector:"tecnico"},{view:"minhas"},{actorId:"other"},{channel:"other"},{search:"different"}]) {
    assert.throws(()=>decodeConversationCursor(encoded,{...scope,...changed}),InvalidConversationCursor);
  }
  for(const value of ["invalid!",Buffer.from('{}').toString('base64url'),"x".repeat(2049)]) assert.throws(()=>decodeConversationCursor(value,scope),InvalidConversationCursor);
});

test("empty next page is explicit, refresh remains possible and failures propagate", async () => {
  const cursor=encodeConversationCursor(key("last"),scope);
  const db=database([],42);
  const result=await conversationPage(db,{...scope,cursor});
  assert.equal(result.hasMore,false);assert.equal(result.nextCursor,null);assert.equal(result.total,42);
  assert.match(db.calls[0].sql,/\(first_at, channel, id\) > \(/);
  assert.ok(db.calls[0].params.includes("last"));
  await assert.rejects(conversationPage({execute:async()=>{throw Error("offline failure");}},scope),/offline failure/);
});

test("SQL filters resolved cases before paging and preserves channel, owner, search and sector scope", async () => {
  const db=database([]);
  await conversationPage(db,{view:"minhas",actorId:"local-operator",channel:"local-channel",sector:"tecnico",search:"local%name"});
  const {sql,params}=db.calls[0];
  assert.match(sql,/g.customer_at <= s.resolved_at/);
  assert.match(sql,/not coalesce\(resolved,false\) and owner =/);
  assert.match(sql,/m.channel = \$/);
  assert.match(sql,/t.channel = g.channel and t.external_conversation_id = g.id/);
  assert.match(sql,/from filtered[\s\S]*order by first_at, channel, id limit/);
  assert.ok(params.includes("local-operator"));assert.ok(params.includes("tecnico"));assert.ok(params.includes("%local\\%name%"));
  assert.doesNotMatch(sql,/local-operator|local%name/);
  assert.doesNotMatch(sql,/24 hours|interval/);
});

test("page only retrieves one bounded preview per selected conversation; no histories in response",async()=>{
  const db=database([]);await conversationPage(db,scope);
  assert.match(db.calls[0].sql,/from page p left join lateral/);
  assert.match(db.calls[0].sql,/left\(last_msg.content, 500\)/);
  assert.match(db.calls[0].sql,/order by created_at desc, id desc limit 1/);
  assert.doesNotMatch(db.calls[0].sql,/jsonb_agg\(m\.|select \* from channel_messages/);
});

test("Minhas cannot be selected anonymously; server clamps volume",async()=>{
  await assert.rejects(conversationPage(database([]),{view:"minhas"}),InvalidConversationCursor);
  const db=database([]);await conversationPage(db,{...scope,limit:999});assert.ok(db.calls[0].params.includes(41));
});

test("UI exposes next/previous/refresh, server filtering, stale-response guard and failure warning",()=>{
  const ui=readFileSync(new URL('../components/modules/attendance.tsx',import.meta.url),'utf8');
  assert.match(ui,/aria-label="Páginas da fila"/);assert.match(ui,/changePage\("next"\)/);assert.match(ui,/changePage\("previous"\)/);assert.match(ui,/changePage\("first"\)/);
  assert.match(ui,/version!==requestVersion.current/);assert.match(ui,/setQueueCount\(payload.pendingCount\)/);
  assert.match(ui,/Página não atualizada/);assert.match(ui,/confirmed.scope===scope/);
  const route=readFileSync(new URL('../app/api/conversations/route.ts',import.meta.url),'utf8');
  assert.ok(route.indexOf('authorize(request, "customer.read")')<route.indexOf('await conversationPage'));
  assert.match(route,/repository.getMessages\(channel, id, MESSAGE_LIMIT\)/);
  assert.doesNotMatch(route,/repository.listConversations/);
});

test("sentinel is not skipped across pages sharing timestamp and external ID across channels", async()=>{
  const first=await conversationPage(database([row("same","a"),row("same","b"),row("same","c")],3),{...scope,limit:2});
  const boundary=decodeConversationCursor(first.nextCursor,scope);
  assert.equal(boundary.channel,"b");assert.equal(boundary.id,"same");
  const secondDb=database([row("same","c")],3);
  const second=await conversationPage(secondDb,{...scope,limit:2,cursor:first.nextCursor});
  assert.equal(second.items[0].channel,"c");assert.equal(second.hasMore,false);
  assert.equal(new Set([...first.items,...second.items].map(i=>JSON.stringify([i.channel,i.externalConversationId]))).size,3);
  assert.ok(secondDb.calls[0].params.includes("b"));
});
