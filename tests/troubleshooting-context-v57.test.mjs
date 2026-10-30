import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeIntent, runAgentPipeline } from '../lib/agent/pipeline.ts';
import { restartReport, troubleshootingContext } from '../lib/agent/troubleshooting-context.ts';
import { resolveSupportReply } from '../lib/platform/support-reply.ts';
import { CHANNEL_NAME, MemoryChannelRepository, processChannelMessage } from '../lib/platform/n8n-channel-service.ts';
process.env.FEATURE_LLM_INTENT = 'false';
process.env.FEATURE_COPILOT_LLM = 'false';
process.env.FEATURE_LANGFUSE = 'false';
const resolveAgentIntent = (message, history, intentOverride) => runAgentPipeline(message, history, { intentOverride });
const customer = content => ({ role: 'customer', content });
const agent = content => ({ role: 'agent', content });
const exact = 'minha internet está lenta desde ontem, já reiniciei o roteador mas continua lenta';
const cable = 'em todos os aparelhos, a tv e video game está pelo cabo, so celular que está pelo wi-fi';
const history = [customer(exact), agent('Isso acontece em todos os aparelhos ou só em um? Você está usando Wi-Fi ou cabo?')];

for (const [message, intent] of [
  [exact, 'technical_slow'], ['minha internet está lenta, ainda não reiniciei', 'technical_slow'],
  ['estou sem internet, já reiniciei', 'technical_no_connection'],
  ['Como reiniciar meu roteador?', 'technical_restart'], ['reinicia meu equipamento agora', 'technical_restart'],
  ['não quero reiniciar, estou sem internet', 'technical_no_connection'],
]) test(`classificação contextual: ${message}`, () => assert.equal(analyzeIntent(message).intent, intent));

for (const [message, expected] of [
  ['já reiniciei, mas não resolveu', 'done'], ['não reiniciei ainda', 'not_done'],
  ['desliguei e liguei mas continua lenta', 'done'], ['desliguei e não liguei novamente', 'not_done'],
  ['reiniciei?','undefined'], ['se reiniciei, muda algo?', 'undefined'],
  ['não está funcionando, já reiniciei', 'done'],
]) test(`relato sem transformar negação em ação: ${message}`, () => assert.equal(String(restartReport(message)), expected));

test('confirmação curta só vale depois da pergunta/instrução entregue', () => {
  assert.equal(troubleshootingContext('sim', [agent('O roteador já foi reiniciado?')]).restarted, true);
  assert.equal(troubleshootingContext('não', [agent('O roteador já foi reiniciado?')]).restarted, false);
  assert.equal(troubleshootingContext('fiz isso mas continua lento', [agent('Tire da tomada e ligue novamente')]).restarted, true);
  assert.equal(troubleshootingContext('sim', [{ role: 'suggestion', content: 'Já reiniciou?' }]).restarted, false);
  assert.equal(troubleshootingContext('não reiniciei, me confundi', [customer('já reiniciei')]).restarted, false);
});

test('episódio resolvido não empresta tentativa ao próximo', () => {
  assert.equal(troubleshootingContext('a internet caiu de novo', [customer('já reiniciei'), customer('agora está funcionando')]).restarted, false);
  const reply = resolveSupportReply({ intent: 'technical_restart', message: 'reiniciei e agora a internet voltou', history: [] });
  assert.match(reply, /você relata/); assert.doesNotMatch(reply, /tire da tomada|\?/);
  assert.doesNotMatch(resolveSupportReply({ intent: 'technical_no_connection', message: 'a internet não voltou', history: [] }), /Que bom/);
});

test('segundo turno real preserva lentidão, sem inventar Wi-Fi fraco', () => {
  const intent = resolveAgentIntent(cable, history).intent;
  assert.equal(intent, 'technical_slow');
  const reply = resolveSupportReply({ intent, message: cable, history });
  assert.match(reply, /sites e aplicativos/);
  assert.doesNotMatch(reply, /qual cômodo|sinal.*fraco|tire da tomada|todos os aparelhos ou/);
});

test('pipeline real em memória: duas mensagens, observação, nenhuma rede', async () => {
  const repository = new MemoryChannelRepository();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('NETWORK_FORBIDDEN'); };
  try {
    const first = await processChannelMessage(repository, { externalConversationId: 'synthetic-support', text: exact, idempotencyKey: 'one', correlationId: 'offline' });
    assert.match(first.suggestion, /já reiniciou/);
    assert.match(first.suggestion, /todos os aparelhos/);
    assert.equal(first.response, null);
    await repository.saveMessages(CHANNEL_NAME, 'synthetic-support', history);
    const second = await processChannelMessage(repository, { externalConversationId: 'synthetic-support', text: cable, idempotencyKey: 'two', correlationId: 'offline' });
    assert.match(second.suggestion, /sites e aplicativos/);
    assert.equal(second.response, null); assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

for (const message of ['já tentei reiniciar o roteador, mas continua lento', 'não vou reiniciar, internet está lenta']) {
  test(`tentativa/recusa não é novo pedido: ${message}`, () => assert.equal(analyzeIntent(message).intent, 'technical_slow'));
}
for (const message of ['a internet voltou ontem, hoje caiu novamente', 'a conexão normalizou por cinco minutos e caiu de novo', 'a internet voltou mas está lenta', 'agora está normal só pelo cabo']) {
  test(`resolução parcial/histórica não encerra episódio: ${message}`, () => assert.equal(troubleshootingContext(message, history).resolved, false));
}

test('resposta sobre luz não nega tentativa de reinício anterior', () => {
  const context = troubleshootingContext('não, estão normais', [customer('já reiniciei'), agent('Como você já reiniciou, não vou pedir isso de novo. Alguma luz do equipamento está vermelha ou apagada?')]);
  assert.equal(context.restarted, true);
});

test('pergunta não vira relato de teste, cabo normal não pergunta cabo outra vez', () => {
  const question = resolveSupportReply({ intent: 'technical_slow', message: 'como testar pelo cabo?', history });
  assert.doesNotMatch(question, /uso de cabo que você informou|problema também no cabo/);
  const normal = resolveSupportReply({ intent: 'technical_slow', message: 'a internet está lenta só no celular, pelo cabo está normal', history: [] });
  assert.match(normal, /pelo cabo está normal/);
  assert.doesNotMatch(normal, /conectado por cabo ou/);
  const apps = resolveSupportReply({ intent: 'technical_slow', message: 'está lento pelo cabo em todos os sites e aplicativos', history: [] });
  assert.doesNotMatch(apps, /\?/);
});

test('terceiro turno real não recomeça atendimento nem repete pergunta respondida', () => {
  const turns = [...history, customer(cable), agent('A lentidão acontece em todos os sites e aplicativos ou só em algum específico?')];
  const message = 'em partidas online cai , e no instagram trava';
  const intent = resolveAgentIntent(message, turns).intent;
  assert.equal(intent, 'technical_slow');
  const answer = resolveSupportReply({ intent, message, history: turns });
  assert.doesNotMatch(answer, /Olá|o que você precisa|\?/);
  assert.match(answer, /com o que você já contou/);
});

test('preserva texto editado benigno, mas não reinstrução de tentativa feita', () => {
  const base = { intent: 'technical_restart', message: 'já reiniciei', history: [] };
  assert.equal(resolveSupportReply({ ...base, templates: { technical_restart: 'Confira o cabo e aguarde nossa equipe.' } }), 'Confira o cabo e aguarde nossa equipe.');
  assert.doesNotMatch(resolveSupportReply({ ...base, templates: { technical_restart: 'Reinicie o roteador novamente.' } }), /Reinicie o roteador novamente/);
});

test('quarto turno real: retorno ao jogo não é resolução da conexão nem cobertura Wi-Fi', () => {
  const turns = [...history, customer(cable), agent('A lentidão acontece em todos os sites e aplicativos ou só em algum específico?'),
    customer('em partidas online cai , e no instagram trava'), agent('Os demais aparelhos perdem internet ao mesmo tempo?')];
  const message = 'não prestei atençao, a partida fecha ai perco a partida depois logo e volto pra o jogo normal';
  const intent = resolveAgentIntent(message, turns).intent;
  assert.equal(intent, 'technical_slow');
  assert.equal(troubleshootingContext(message, turns).resolved, false);
  assert.doesNotMatch(resolveSupportReply({ intent, message, history: turns }), /sinal.*fraco|cômodo|Olá|Que bom/);
});

test('rótulo isolado incorreto do modelo não transforma relato em novo comando', () => {
  for (const intent of ['technical_restart', 'technical_wifi', 'general_information']) {
    assert.equal(resolveAgentIntent(exact, [], { intent, confidence: 0.99 }).intent, 'technical_slow');
  }
  assert.equal(resolveAgentIntent(exact, [], { intent: 'human_handoff', confidence: 0.99 }).intent, 'human_handoff');
});

test('negação do funcionamento pelo cabo não vira conexão normal', () => {
  const answer = resolveSupportReply({ intent: 'technical_slow', message: 'está lento pelo cabo, não funciona direito', history: [] });
  assert.doesNotMatch(answer, /pelo cabo está normal/);
});
for (const message of ['a internet voltou a falhar', 'a conexão normalizou ontem, mas hoje estou sem internet']) {
  test(`falha atual prevalece sobre recuperação antiga: ${message}`, () => assert.equal(troubleshootingContext(message, history).resolved, false));
}
test('tentativa interrogativa não vira falha e template que impede repetição é preservado', () => {
  assert.equal(troubleshootingContext('já tentei reiniciar?', []).attemptedWithoutResult, false);
  const text = 'Não precisa reiniciar novamente. A equipe dará continuidade.';
  assert.equal(resolveSupportReply({ intent: 'technical_restart', message: 'já reiniciei', history: [], templates: { technical_restart: text } }), text);
});

for (const [message, intent] of [
  ['so diz que desconectou a partida, tem como mandar alguem vim aqui pra resolver ?', 'technical_visit'],
  ['não to com tempo pra ta conversando, estou no trabalho', 'human_handoff'],
]) test(`pedido de continuidade humana sem visita inventada: ${message}`, () => {
  const turns = [...history, customer(cable)];
  const resolved = resolveAgentIntent(message, turns).intent;
  assert.equal(resolved, intent);
  assert.equal(resolveAgentIntent(message, turns, { intent: "technical_wifi", confidence: 0.99 }).intent, intent);
  const answer = resolveSupportReply({ intent: resolved, message, history: turns });
  assert.doesNotMatch(answer, /Wi-Fi|cômodo|Olá|já encaminhei|já agendei|vou chamar|vou encaminhar/);
});

test('seis turnos reais reproduzidos em observação, sem envio nem rede', async () => {
  const steps = [
    [exact, /já reiniciou/],
    [cable, /sites e aplicativos/],
    ['em partidas online cai , e no instagram trava', /com o que você já contou/],
    ['não prestei atençao, a partida fecha ai perco a partida depois logo e volto pra o jogo normal', /com o que você já contou/],
    ['so diz que desconectou a partida, tem como mandar alguem vim aqui pra resolver ?', /disponibilidade/],
    ['não to com tempo pra ta conversando, estou no trabalho', /continuar com um atendente/],
  ];
  const turns = [];
  const oldFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; throw new Error('NETWORK_FORBIDDEN'); };
  try {
    for (const [index, [text, expected]] of steps.entries()) {
      const repository = new MemoryChannelRepository();
      await repository.saveMessages(CHANNEL_NAME, 'six-turns', turns);
      const result = await processChannelMessage(repository, { externalConversationId: 'six-turns', text, idempotencyKey: `step-${index}`, correlationId: 'synthetic' });
      assert.match(result.suggestion, expected);
      assert.doesNotMatch(result.suggestion, /sinal.*fraco|Olá|2 minutos|já agendei|já encaminhei/);
      assert.equal(result.response, null); assert.equal(result.autoReply, false);
      turns.push(customer(text), agent(result.suggestion)); // explicitly simulate reviewed delivered history
    }
    assert.equal(attempts, 0);
  } finally { globalThis.fetch = oldFetch; }
});
