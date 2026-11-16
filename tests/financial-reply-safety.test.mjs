import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_REPLY_TEMPLATES,resolveReply,FINANCIAL_REPLY_LOCK_REASON,financialReplyOptions} from '../lib/platform/reply-templates-shared.ts';
import {resolveSupportReply} from '../lib/platform/support-reply.ts';
import {MemoryReplyTemplatesRepository,saveTemplate,templatesView,loadOverrides} from '../lib/platform/reply-templates-service.ts';
import {MemoryChannelRepository,processChannelMessage} from '../lib/platform/n8n-channel-service.ts';
process.env.FEATURE_LLM_INTENT='false';process.env.FEATURE_LANGFUSE='false';process.env.FEATURE_COPILOT_LLM='false';
const intents=['financial_invoice','financial_pix','financial_payment','financial_unlock','financial_discount_request'];
const unsafe=['Pagamento confirmado e baixa efetuada.','Seu contrato já foi desbloqueado.','Acordo aprovado em 6 parcelas de R$50.','PIX 123 para pagar agora.','Vou encaminhar e retornamos em 10 minutos.','Já enviei sua segunda via.'];
for(const intent of intents) for(const content of unsafe) test(`${intent} ignores unverified prose: ${content}`,()=>{
 assert.equal(resolveReply(intent,{[intent]:content}),DEFAULT_REPLY_TEMPLATES[intent]);
 assert.equal(resolveSupportReply({intent,message:'Preciso de ajuda',history:[],templates:{[intent]:content}}),DEFAULT_REPLY_TEMPLATES[intent]);
});
for(const intent of intents) test(`${intent} rejects editor save and preserves prior record`,async()=>{
 const r=new MemoryReplyTemplatesRepository();await r.upsert(intent,'Já foi aprovado.','synthetic');
 const before=await r.list();await assert.rejects(saveTemplate(r,{intent,content:'Vou encaminhar.'},'synthetic'),e=>e.message===FINANCIAL_REPLY_LOCK_REASON);assert.deepEqual(await r.list(),before);
 const row=(await templatesView(r)).find(x=>x.intent===intent);assert.equal(row.content,DEFAULT_REPLY_TEMPLATES[intent]);assert.equal(row.editable,true);assert.equal(row.options.length,2);assert.equal(row.edited,false);assert.equal(row.storedContent,'Já foi aprovado.');assert.equal(row.version,1);assert.equal(row.inactiveReason,FINANCIAL_REPLY_LOCK_REASON);
 assert.equal((await loadOverrides(r))[intent],'Já foi aprovado.','loading preserves legacy record; resolver enforces safety');
});
test('nonfinancial customization remains editable and effective',async()=>{
 const r=new MemoryReplyTemplatesRepository();await saveTemplate(r,{intent:'technical_wifi',content:'O sinal melhora perto do roteador?'},'synthetic');
 const row=(await templatesView(r)).find(x=>x.intent==='technical_wifi');assert.equal(row.editable,true);assert.equal(row.edited,true);assert.equal(row.inactiveReason,null);assert.equal(resolveReply('technical_wifi',await loadOverrides(r)),row.content);
});
for(const [intent,message] of [['financial_payment','Não paguei ainda'],['financial_payment','Já enviei o comprovante'],['financial_unlock','Minha conexão não está bloqueada'],['financial_invoice','Não tenho fatura vencida'],['financial_pix','Cadê meu PIX?'],['financial_discount_request','Não quero acordo ainda']]) test(`no invented financial facts for: ${message}`,()=>{
 const text=resolveSupportReply({intent,message,history:[{role:'agent',content:'Seu pagamento está confirmado'}]});
 assert.doesNotMatch(text,/já (?:foi|enviei|baixei|desbloqueei)|pagamento confirmado|acordo aprovado|vou encaminhar|retornamos|sua conexão está bloqueada|pode enviar|R\$|10 minutos/);
});
test('disputed bill and explicit human request retain precedence',()=>{
 assert.match(resolveSupportReply({intent:'financial_invoice',message:'Não reconheço essa cobrança',history:[]}),/não reconhece/);
 assert.match(resolveSupportReply({intent:'human_handoff',message:'quero um atendente',history:[]}),/atendente/);
});
test('channel observation stays silent and safe with stale financial overrides',async()=>{
 const r=new MemoryChannelRepository();let sends=0;const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('NETWORK_FORBIDDEN');};
 try {const result=await processChannelMessage(r,{externalConversationId:'synthetic-finance',text:'Já paguei a fatura',idempotencyKey:'financial-safety',correlationId:'synthetic'},undefined,{autoReply:false,templates:{financial_payment:'Pagamento confirmado, já liberei.'},send:async()=>{sends++;throw Error('NO_SEND');}});
 assert.equal(result.response,null);assert.equal(result.autoReply,false);assert.equal(sends,0);assert.match(result.suggestion,/não tenho confirmação de baixa/);assert.doesNotMatch(result.suggestion,/Pagamento confirmado|já liberei/);
 }finally{globalThis.fetch=original;}
});

for(const intent of intents) test(`${intent} preserves reviewed short customization`,async()=>{const r=new MemoryReplyTemplatesRepository();const short=financialReplyOptions(intent)[1];await saveTemplate(r,{intent,content:short},'synthetic');const overrides=await loadOverrides(r);assert.equal(resolveReply(intent,overrides),short);assert.equal(resolveSupportReply({intent,message:'Preciso de ajuda',history:[],templates:overrides}),short);const row=(await templatesView(r)).find(x=>x.intent===intent);assert.equal(row.edited,true);assert.equal(row.content,short);assert.equal(row.storedContent,null);});
