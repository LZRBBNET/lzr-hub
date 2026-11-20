import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {processConsentCommand} from '../lib/platform/consent-command-service.ts';
import {MemoryChannelRepository,CHANNEL_NAME} from '../lib/platform/n8n-channel-service.ts';
const input={conversationId:'0000000000000',inboundMessageId:'local-opt-out',text:'SAIR',out:true,correlationId:'local-correlation'};
function fixture(){const channel=new MemoryChannelRepository();let opted=false,calls=0,writes=0;
 const outbound={setOptOut:async(_phone,out)=>{opted=out;writes++;}};
 const deps={channel,confirmationEnabled:false,transaction:work=>work({channel,outbound}),send:async()=>{calls++;assert.equal(opted,true);return {sent:true,messageId:'local-accepted'};}};
 return {deps,outbound,opted:()=>opted,calls:()=>calls,writes:()=>writes};}
test('paused output preserves consent and inbound, audits suppression, never sends even on retry',async()=>{
 const f=fixture();const result=await processConsentCommand(f.deps,input);assert.equal(f.opted(),true);assert.equal(f.calls(),0);assert.equal(result.autoReply,false);
 assert.ok(f.deps.channel.audits.some(x=>x.action==='whatsapp.consent.confirmation'&&x.result==='suppressed'));
 assert.deepEqual(await processConsentCommand({...f.deps,confirmationEnabled:true},input),result);assert.equal(f.calls(),0);assert.equal(f.writes(),1);
 assert.equal((await f.deps.channel.getHistory(CHANNEL_NAME,input.conversationId)).length,1);
 await processConsentCommand(f.deps,{...input,inboundMessageId:'local-opt-in',text:'VOLTAR',out:false});assert.equal(f.opted(),false);
});
test('notification failure cannot undo consent; replay of old command cannot undo a later command',async()=>{
 const f=fixture();const deps={...f.deps,confirmationEnabled:true,send:async()=>{throw Error('local transport failure');}};
 await assert.rejects(processConsentCommand(deps,input));assert.equal(f.opted(),true);assert.equal(await f.deps.channel.findIdempotent(input.inboundMessageId),undefined);
 await processConsentCommand(f.deps,{...input,inboundMessageId:'local-newer',text:'VOLTAR',out:false});
 await processConsentCommand(f.deps,input);assert.equal(f.opted(),false);assert.equal(f.writes(),2);
});
test('failed consent persistence propagates without send or completion marker',async()=>{
 const f=fixture();f.outbound.setOptOut=async()=>{throw Error('local database unavailable');};
 await assert.rejects(processConsentCommand({...f.deps,confirmationEnabled:true},input));assert.equal(f.calls(),0);assert.equal(await f.deps.channel.findIdempotent(input.inboundMessageId),undefined);assert.equal(await f.deps.channel.findIdempotent('consent:'+input.inboundMessageId),undefined);
});
test('enabled notification follows persisted consent; real route uses DB transaction and output gate before lookup',async()=>{
 const f=fixture();assert.equal((await processConsentCommand({...f.deps,confirmationEnabled:true},input)).autoReply,true);assert.equal(f.calls(),1);
 const route=readFileSync(new URL('../app/api/channels/meta/route.ts',import.meta.url),'utf8');
 assert.ok(route.indexOf('results.push(await processConsentCommand')<route.indexOf('const lookupCustomer'));
 assert.match(route,/processConsentCommand\(\{channel,confirmationEnabled:autoReplyEnabled\(\)/);assert.match(route,/transaction:work=>db.transaction/);
});
test('suppression survives failed final audit and later flag enable',async()=>{
 const f=fixture(),audit=f.deps.channel.audit.bind(f.deps.channel);let fail=true;
 f.deps.channel.audit=async entry=>{if(entry.action==='whatsapp.consent.confirmation'&&fail){fail=false;throw Error('local audit unavailable');}return audit(entry);};
 await assert.rejects(processConsentCommand(f.deps,input));
 const retry=await processConsentCommand({...f.deps,confirmationEnabled:true},input);assert.equal(retry.autoReply,false);assert.equal(f.calls(),0);assert.equal(f.writes(),1);
});
