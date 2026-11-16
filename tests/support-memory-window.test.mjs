import test from 'node:test';
import assert from 'node:assert/strict';
import {contextForSupport,contextForClassifier,MemoryChannelRepository,processChannelMessage,CHANNEL_NAME} from '../lib/platform/n8n-channel-service.ts';
import {resolveSupportReply} from '../lib/platform/support-reply.ts';
import {troubleshootingContext,pendingSupportRequest} from '../lib/agent/troubleshooting-context.ts';
process.env.FEATURE_LLM_INTENT='false'; process.env.FEATURE_LANGFUSE='false'; process.env.FEATURE_COPILOT_LLM='false';
const c=content=>({role:'customer',content}); const a=content=>({role:'agent',content});
const latest='minha internet está lenta desde ontem, o instagram fica so carregando';
const history=[c('minha internet está lenta, já reiniciei'),a('Isso acontece em todos os aparelhos ou só em um?'),c('em todos os aparelhos, a tv está pelo cabo, o celular no wi-fi'),a('Acontece em todos os sites e aplicativos?'),c('em partidas online cai e no instagram trava'),a('Os demais aparelhos caem juntos?'),c('não prestei atenção'),a('Qual erro aparece?'),c('tem como mandar alguem vim aqui pra resolver?'),a('Ainda não há visita confirmada.'),c('não to com tempo, estou no trabalho'),a('Sem mais testes agora.')];
test('suporte40 separado do classificador6; sugestões não consomem memória',()=>{
 const rows=history.flatMap(row=>[row,{role:'suggestion',content:'reinicie outra vez'}]);
 assert.equal(contextForSupport(rows).length,12); assert.equal(contextForClassifier(rows).length,6);
 assert.equal(contextForSupport(Array.from({length:55},(_,i)=>c(`turno ${i}`))).length,40);
});
test('janela6h, autoria e compatibilidade de data ausente',()=>{
 const now=Date.parse('2026-10-30T18:00:00Z');
 assert.deepEqual(contextForSupport([{...c('antigo'),createdAt:'2026-10-30T11:59:59Z'},{...a('recente'),createdAt:'2026-10-30T12:00:00Z'},c('sem data')],now),[a('recente'),c('sem data')]);
});
test('12 turnos pelo serviço preservam técnico sem repetir diagnóstico',async()=>{
 const repository=new MemoryChannelRepository();
 await repository.saveMessages(CHANNEL_NAME,'synthetic-memory',history.flatMap(row=>[row,{role:'suggestion',content:'Pode reiniciar novamente?'}]));
 const before=globalThis.fetch; globalThis.fetch=async()=>{throw Error('NETWORK_FORBIDDEN');};
 try {const result=await processChannelMessage(repository,{externalConversationId:'synthetic-memory',text:latest,idempotencyKey:'synthetic-long',correlationId:'synthetic'});
 assert.match(result.suggestion,/pedido de avaliação técnica/); assert.doesNotMatch(result.suggestion,/todos os aparelhos ou|já agendei|encaminhei|\?/);
 assert.equal(result.autoReply,false); assert.equal(result.response,null);
 }finally{globalThis.fetch=before;}
});
for(const text of ['não precisa técnico','a conexão voltou a funcionar','mudando de assunto, tenho outra dúvida','quero continuar os testes']) test(`liberação explícita: ${text}`,()=>assert.equal(pendingSupportRequest(text,history),undefined));
for(const text of ['agora posso conversar','pode continuar']) test(`retorno libera pausa mas não cancela visita: ${text}`,()=>{
 assert.equal(pendingSupportRequest(text,[c('não posso conversar agora')]),undefined); assert.equal(pendingSupportRequest(text,history),'visit');
});
test('negação de chamado não cancela pedido distinto de visita',()=>assert.equal(pendingSupportRequest('não quero chamado',history),'visit'));
test('nova descrição não libera parada por inferência',()=>{
 assert.equal(pendingSupportRequest(latest,history),'visit'); assert.equal(pendingSupportRequest('internet lenta',[c('não posso conversar agora')]),'pause');
});
test('agente não cria fatos ou pedidos do cliente',()=>{
 assert.equal(pendingSupportRequest('internet lenta',[a('quero técnico')]),undefined); assert.equal(troubleshootingContext('internet lenta',[a('já reiniciei')]).restarted,false);
});
test('resolução e novo assunto descartam tentativas anteriores',()=>{
 assert.equal(troubleshootingContext('internet lenta',[c('já reiniciei'),c('a conexão voltou a funcionar')]).restarted,false);
 assert.equal(troubleshootingContext('outro problema, minha internet está lenta',[c('já reiniciei')]).restarted,false);
});
test('último relato de reinício e cabo prevalece',()=>{
 assert.equal(troubleshootingContext('não reiniciei',[c('já reiniciei')]).restarted,false);
 assert.doesNotMatch(resolveSupportReply({intent:'technical_slow',message:'não testei pelo cabo, só no celular',history:[c('em todos os aparelhos pelo cabo')]}),/Considerando o uso de cabo/);
});
test('financeiro não herda pedido técnico',()=>assert.doesNotMatch(resolveSupportReply({intent:'financial_invoice',message:'quero segunda via',history}),/avaliação técnica|visita|já reiniciou/));
test('correções negativas invalidam resumo positivo antigo',()=>{
 const reply=resolveSupportReply({intent:'technical_visit',message:'quero um técnico',history:[c('minha internet está lenta; em partidas online cai; uso pelo cabo e wi-fi'),c('não está lenta, partidas online não cai, não usei cabo')]});
 assert.doesNotMatch(reply,/lentidão relatada|quedas em partidas|uso de cabo/);
});
test('pedido financeiro explícito encerra contexto técnico também na fala seguinte',()=>{
 assert.equal(pendingSupportRequest('obrigado',[...history,c('quero segunda via do boleto')]),undefined);
 assert.equal(troubleshootingContext('internet lenta',[c('já reiniciei'),c('quero segunda via do boleto')]).restarted,false);
});
for(const text of ['não quero continuar os testes','não quero segunda via do boleto','não pode continuar','não é outro assunto']) test(`negação não libera pedido: ${text}`,()=>{
 assert.equal(pendingSupportRequest(text,history),'visit');
 assert.equal(pendingSupportRequest(text,[c('não posso conversar agora')]),'pause');
});
test('cancelamento negado não cancela pedido',()=>assert.equal(pendingSupportRequest('não cancela o pedido',history),'visit'));
for(const text of ['não desconsidera o chamado','não cancela o chamado']) test(`manter chamado: ${text}`,()=>assert.equal(pendingSupportRequest(text,[c('abre um chamado')]),'ticket'));
