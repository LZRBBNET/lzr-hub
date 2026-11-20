import {parseMetaMessages} from "../lib/integrations/meta/webhook-parser.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {requestsHuman,explicitHumanHandoff} from '../lib/platform/explicit-human-handoff.ts';
import {MemoryTicketRepository,openOrContinueTicket} from '../lib/platform/triage-service.ts';
import {MemoryChannelRepository,CHANNEL_NAME} from '../lib/platform/n8n-channel-service.ts';
const states={get:async()=>({status:"open",assigneeId:null})};
const input={conversationId:'local-explicit',text:'Quero falar com um atendente',inboundMessageId:'local-explicit-inbound',correlationId:'local-correlation'};
test('explicit request is conservative and recognizes the official list option',()=>{
 for(const text of ['quero atendente. não quero mais boleto','quero atendente','quero um atendente','sem internet. quero atendente','não funciona, quero um atendente','quero atendente, estou sem internet','não quero boleto, quero atendente','quero falar com um atendente','Falar com atendente','Olá, quero falar com uma pessoa!','por favor, me transfira para um atendente','quero falar com um atendente. CPF 000.000.000-00'])assert.equal(requestsHuman(text),true,text);
 for(const text of ['não quero atendente','não quero um atendente','quero atendente, mas não quero mais','não preciso de atendente','sem atendente','não quero falar com atendente','não preciso de atendente','o atendente disse isso','atendimento ruim','9','opção 9','menu-9','meu CPF 000.000.000-00','"quero falar com um atendente"','quero falar com um atendente? não, resolvi'])assert.equal(requestsHuman(text),false,text);
 assert.equal(requestsHuman('Falar com atendente','menu-9'),true);
});
test('first contact without account identification persists handoff before confirmation; duplicate does not resend',async()=>{
 const channel=new MemoryChannelRepository(),tickets=new MemoryTicketRepository();let sends=0;
 const deps={channel,tickets,states,confirmationEnabled:true,send:async()=>{sends++;const t=await tickets.findOpen(CHANNEL_NAME,input.conversationId);assert.equal(t.stage,'handoff');assert.equal(t.queue,'atendimento');assert.equal(t.ixcCustomerId,null);return {sent:true,messageId:'local-confirmation'};}};
 const result=await explicitHumanHandoff(deps,input);assert.equal(result.handoff,true);assert.ok((await tickets.findOpen(CHANNEL_NAME,input.conversationId)).protocol);
 assert.deepEqual(await explicitHumanHandoff(deps,input),result);assert.equal(sends,1);
});
test('context survives notification failure and retry; unavailable integrations are not dependencies',async()=>{
 const channel=new MemoryChannelRepository(),tickets=new MemoryTicketRepository();
 const {ticket}=await openOrContinueTicket(tickets,{channel:CHANNEL_NAME,conversationId:input.conversationId});
 await tickets.update(ticket.id,{queue:'financeiro',intent:'financial_invoice',intake:{summary:'Local existing context',intent:'financial_invoice',at:new Date().toISOString()}});
 const result=await explicitHumanHandoff({channel,tickets,states,confirmationEnabled:true,send:async()=>({sent:false,outcome:'unknown'})},input);
 const after=await tickets.findOpen(CHANNEL_NAME,input.conversationId);assert.equal(result.autoReply,false);assert.equal(after.stage,'handoff');assert.equal(after.queue,'financeiro');assert.equal(after.protocol,ticket.protocol);assert.equal(after.intake.summary,'Local existing context');
 assert.equal((await channel.getHistory(CHANNEL_NAME,input.conversationId)).filter(x=>x.role==='customer').length,1);
});
test('failed durable transition does not send or complete idempotency; route short-circuits before integrations',async()=>{
 const channel=new MemoryChannelRepository(),tickets=new MemoryTicketRepository();let sends=0;tickets.updateTriage=async()=>false;
 await assert.rejects(explicitHumanHandoff({channel,tickets,states,confirmationEnabled:true,send:async()=>{sends++;return {sent:true};}},input));assert.equal(sends,0);assert.equal(await channel.findIdempotent(input.inboundMessageId),undefined);
 const route=readFileSync(new URL('../app/api/channels/meta/route.ts',import.meta.url),'utf8');
 const start=route.indexOf('if (message.kind === "text" && message.text.length <=');
 assert.ok(start>0&&start<route.indexOf('const lookupCustomer'));
 assert.ok(route.slice(start,route.indexOf('const lookupCustomer')).includes('return;'));
});

test('official interactive ID survives parsing; text numeral has no button authority',()=>{
 const value={messages:[{from:'0000000000000',id:'local-interactive',type:'interactive',interactive:{type:'list_reply',list_reply:{id:'menu-9',title:'9'}}},{from:'0000000000000',id:'local-numeral',type:'text',text:{body:'9'}}]};
 const messages=parseMetaMessages({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value}]}]});
 assert.equal(messages.length,2);assert.equal(requestsHuman(messages[0].text,messages[0].interactiveReplyId),true);assert.equal(requestsHuman(messages[1].text,messages[1].interactiveReplyId),false);
});

test('assigned human without handoff stage preserves inbound and department without transition or dispatch',async()=>{
 const channel=new MemoryChannelRepository(),tickets=new MemoryTicketRepository();
 const {ticket}=await openOrContinueTicket(tickets,{channel:CHANNEL_NAME,conversationId:input.conversationId});
 await tickets.update(ticket.id,{queue:'financeiro'});
 tickets.updateTriage=async()=>{throw Error('must not transition');};
 const assigned={get:async()=>({status:'open',assigneeId:'local-operator'})};
 const deps={channel,tickets,states:assigned,send:async()=>{throw Error('must not dispatch');}};
 const result=await explicitHumanHandoff(deps,input);assert.equal(result.handoff,true);assert.equal(result.autoReply,false);
 assert.deepEqual(await explicitHumanHandoff(deps,input),result);
 const saved=await tickets.findOpen(CHANNEL_NAME,input.conversationId);assert.equal(saved.stage,'new');assert.equal(saved.queue,'financeiro');assert.equal(saved.protocol,ticket.protocol);
 assert.equal((await channel.getHistory(CHANNEL_NAME,input.conversationId)).filter(x=>x.role==='customer').length,1);
});

test('confirmation flag off still records the human request without calling sender',async()=>{
 const channel=new MemoryChannelRepository(),tickets=new MemoryTicketRepository();
 const result=await explicitHumanHandoff({channel,tickets,states,confirmationEnabled:false,send:async()=>{throw Error('must not dispatch');}},input);
 assert.equal(result.handoff,true);assert.equal(result.autoReply,false);assert.equal((await tickets.findOpen(CHANNEL_NAME,input.conversationId)).stage,'handoff');
 const route=readFileSync(new URL('../app/api/channels/meta/route.ts',import.meta.url),'utf8');
 assert.match(route,/confirmationEnabled:autoReplyEnabled\(\)/);
 assert.match(route,/const autoReplyEnabled = \(\) => process.env.FEATURE_N8N_AUTOREPLY === "true"/);
});
