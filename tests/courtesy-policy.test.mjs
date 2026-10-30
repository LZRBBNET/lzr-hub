import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgentPipeline} from '../lib/agent/pipeline.ts';
import {resolveSupportReply} from '../lib/platform/support-reply.ts';
import {servicePreferences} from '../lib/agent/service-preferences.ts';
import {serviceOpening,hasPriorOutput} from '../lib/platform/service-opening.ts';
import {MemoryChannelRepository,processChannelMessage,CHANNEL_NAME} from '../lib/platform/n8n-channel-service.ts';
process.env.FEATURE_LLM_INTENT='false';process.env.FEATURE_LANGFUSE='false';process.env.FEATURE_COPILOT_LLM='false';
const reply=(message,history=[])=>{const p=runAgentPipeline(message,history);return {p,text:resolveSupportReply({intent:p.intent,message,history,handoffReason:p.handoff.reason})};};
for(const [hour,prefix] of [[14,'Bom dia!'],[15,'Boa tarde!'],[21,'Boa noite!']]) test(`opening local timezone ${hour} UTC`,()=>assert.match(serviceOpening('Como posso ajudar?',{now:Date.UTC(2026,9,30,hour),priorOutput:false,concise:false}),new RegExp('^'+prefix)));
for(const now of [NaN,Infinity,1e20]) test(`invalid clock ${now}`,()=>assert.match(serviceOpening('Como posso ajudar?',{now,priorOutput:false,concise:false}),/^Olá!/));
test('known or legacy output suppresses repeated greeting; suggestions are not output',()=>{
 assert.equal(hasPriorOutput([{role:'suggestion'}]),false);assert.equal(hasPriorOutput([{role:'agent'}]),true);
 assert.equal(hasPriorOutput([{role:'agent',deliveryStatus:'failed'}]),false);
 assert.equal(serviceOpening('Olá! Tudo bem? Próximo passo.',{now:0,priorOutput:true,concise:false}),'Próximo passo.');
});
for(const message of ['Vou bater um papo com o técnico sobre a internet','Vou matar a saudade de vocês','Não vou agredir o técnico','Minha internet está lenta, vou morrer de raiva']) test(`not physical threat: ${message}`,()=>{const s=servicePreferences(message);assert.equal(s.directThreat,false);assert.equal(s.ambiguousThreat,false);});
for(const message of ['Vou aí hoje agredir o técnico que vocês mandarem','Não tenho internet e vou agredir o técnico']) test(`explicit threat: ${message}`,()=>{const r=reply(message);assert.equal(r.p.handoff.reason,'explicit_physical_threat');assert.doesNotMatch(r.text,/\?|polícia|já encaminhei/);});
for(const message of ['Quero cancelar a visita técnica','Quero cancelar o boleto duplicado','Quero cancelar o pedido de cancelamento']) test(`specific item not contract: ${message}`,()=>{const r=reply(message);assert.notEqual(r.p.intent,'cancellation_risk');assert.doesNotMatch(r.text,/seu pedido de cancelamento|cancelamento concluído/);});
for(const message of ['Mande um técnico aqui','Quero um técnico aqui, não tenho tempo','mande alguem vim consertar essa merda se não eu vou cancelar']) test(`visit preserved: ${message}`,()=>{const r=reply(message);assert.match(r.text,/visita|avaliação técnica/);assert.doesNotMatch(r.text,/\?|vou encaminhar|vou solicitar|agendei/);assert.notEqual(r.p.intent,'cancellation_risk');});
for(const message of ['Não me faça mais perguntas, quero resolver','Estou no trabalho e não posso ficar conversando']) test(`pause respected: ${message}`,()=>{const r=reply(message);assert.doesNotMatch(r.text,/\?/);assert.match(r.text,/não vou insistir/);});
test('identity does not erase restart already done',()=>{const r=reply('Você é um robô? Já reiniciei o roteador, não vou reiniciar de novo');assert.match(r.text,/sou a assistente virtual/i);assert.match(r.text,/já reiniciou/);assert.doesNotMatch(r.text,/desligue|tire da tomada/);});
test('conditional churn is not cancellation request',()=>{const r=reply('Se não resolver vou cancelar');assert.notEqual(r.p.intent,'cancellation_risk');assert.equal(r.p.handoff.reason,'conditional_cancellation_risk');assert.equal(r.p.actionExecuted,false);});
test('quoted and negated cancellation preserve support',()=>{const r=reply('Meu vizinho disse "vou cancelar", eu não quero cancelar, só quero resolver a lentidão');assert.equal(r.p.intent,'technical_slow');});
test('profanity does not penalize customer',()=>{const r=reply('Essa merda de internet está lenta');assert.equal(r.p.handoff.required,false);assert.doesNotMatch(r.text,/ofensas|educação|acalme/);});
test('persistent direct insults get polite boundary without refusal',()=>{const r=reply('Você é um idiota',[{role:'customer',content:'Você é um incompetente'}]);assert.match(r.text,/sem ofensas pessoais/);assert.match(r.text,/atendimento continua disponível/);});
test('observation channel produces courtesy suggestion, zero send, no repeated greeting after recorded output',async()=>{
 const repo=new MemoryChannelRepository();let calls=0;
 const fetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('NETWORK_FORBIDDEN');};
 try {
 const options={autoReply:false,now:Date.parse('2026-10-30T18:00:00Z'),send:async()=>{calls++;throw Error('NO_SEND');}};
 const first=await processChannelMessage(repo,{externalConversationId:'synthetic-courtesy',text:'Essa merda de internet está lenta',idempotencyKey:'courtesy1',correlationId:'synthetic'},undefined,options);
 assert.match(first.suggestion,/^Boa tarde!/);assert.doesNotMatch(first.suggestion,/Tudo bem/);assert.equal(first.response,null);assert.equal(first.autoReply,false);
 await repo.saveMessages(CHANNEL_NAME,'synthetic-courtesy',[{role:'agent',content:'Boa tarde! Em quais aparelhos?'}]);
 const next=await processChannelMessage(repo,{externalConversationId:'synthetic-courtesy',text:'Em todos os aparelhos',idempotencyKey:'courtesy2',correlationId:'synthetic'},undefined,options);
 assert.doesNotMatch(next.suggestion,/^Bom dia|^Boa tarde|^Boa noite|^Olá/);assert.equal(next.response,null);assert.equal(calls,0);
 } finally {globalThis.fetch=fetch;}
});

for(const message of ['Não quero cancelar a visita','O atendente falou para cancelar a visita, mas não quero','Se não conseguir atender amanhã quero cancelar a visita']) test(`no item cancellation attributed: ${message}`,()=>{const r=reply(message);assert.doesNotMatch(r.text,/você quer|seu pedido de cancelamento/);assert.notEqual(r.p.handoff.reason,'conditional_cancellation_risk');});
