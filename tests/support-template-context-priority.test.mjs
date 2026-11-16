import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REPLY_TEMPLATES } from '../lib/platform/reply-templates-shared.ts';
import { resolveSupportReply } from '../lib/platform/support-reply.ts';
const reply = (intent, message, content, history=[]) => resolveSupportReply({intent,message,history,templates:{[intent]:content}});
const done = 'minha internet está lenta desde ontem, já reiniciei o roteador mas continua lenta';
for (const content of ['Certo, reinicie o roteador novamente.', 'Entendi. Antes de seguir, desligue e ligue o roteador.', 'Tudo bem, vamos tentar reiniciar mais uma vez.']) {
  test(`tentativa feita vence override sem depender do prefixo: ${content}`, () => {
    const result = reply('technical_slow',done,content);
    assert.notEqual(result,content); assert.match(result,/já reiniciou/); assert.doesNotMatch(result,/reinicie|desligue|mais uma vez/);
  });
}

test('cabo e todos os aparelhos já respondidos vencem override de lentidão', () => {
  const content = 'Vamos verificar a lentidão. Ela acontece em todos os aparelhos ou só em um? E é perto do roteador ou em outro cômodo?';
  const result = reply('technical_slow','em todos os aparelhos, a tv e video game está pelo cabo, so celular que está pelo wi-fi',content,[{role:'customer',content:'internet lenta'}]);
  assert.notEqual(result,content); assert.match(result,/sites e aplicativos/);
  assert.doesNotMatch(result,/todos os aparelhos ou|cômodo/);
});

test('pergunta já entregue é contexto, não pode ser repetida por override', () => {
  const result = reply('technical_slow','em todos','A lentidão acontece em todos os aparelhos ou só em um?',[
    {role:'customer',content:'internet lenta'}, {role:'agent',content:'A lentidão acontece em todos os aparelhos ou só em um?'}]);
  assert.match(result,/cabo ou só no Wi-Fi/); assert.doesNotMatch(result,/todos os aparelhos ou/);
});

test('reinício negado não é transformado em tentativa feita', () => {
  const content='Posso explicar como reiniciar o roteador.';
  assert.equal(reply('technical_restart','ainda não reiniciei',content),content);
  assert.doesNotMatch(reply('technical_slow','internet lenta e ainda não reiniciei','Preciso conferir com a equipe.'),/já reiniciou/);
});

test('novo pedido explícito de orientação permite resposta ao que foi solicitado', () => {
  const content='Tire o roteador da tomada e ligue novamente. Não use o botão de reset.';
  assert.equal(reply('technical_restart','como reiniciar o roteador?',content,[{role:'customer',content:'já reiniciei'}]),content);
});

test('customização benigna preservada quando não há contexto que exija continuidade', () => {
  const content='Preciso conferir com a equipe.';
  assert.equal(reply('technical_slow','internet lenta',content),content);
  assert.equal(reply('technical_no_connection','estou sem internet',content),content);
});

test('tentativa conhecida protege qualquer intenção técnica, não apenas reinício', () => {
  for (const intent of ['technical_restart','technical_wifi','technical_no_connection']) {
    const content='Certo, reinicie o roteador novamente.';
    assert.notEqual(reply(intent,'continua o problema',content,[{role:'customer',content:'já reiniciei'}]),content);
  }
});

test('resolução relatada vence template de repetição; financeiro usa padrão revisado', () => {
  assert.match(reply('technical_slow','a internet voltou e agora está normal','Certo, reinicie de novo.'),/Que bom/);
  assert.equal(reply('financial_invoice','quero segunda via','Vou verificar a solicitação.'),DEFAULT_REPLY_TEMPLATES.financial_invoice);
});
