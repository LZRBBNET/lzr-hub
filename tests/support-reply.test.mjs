import test from 'node:test';
import assert from 'node:assert/strict';
import { asksAiIdentity, resolveSupportReply } from '../lib/platform/support-reply.ts';
import { DEFAULT_REPLY_TEMPLATES } from '../lib/platform/reply-templates-shared.ts';
import { CHANNEL_NAME, LLM_CONTEXT_MAX_AGE_MS, MemoryChannelRepository, processChannelMessage } from '../lib/platform/n8n-channel-service.ts';
import { MemoryTicketRepository, startTriage } from '../lib/platform/triage-service.ts';
import { summarizeConversation } from '../lib/platform/copilot-service.ts';
import { supportTranscripts } from './fixtures/support-transcripts.mjs';

// These tests exercise deterministic code, not a model's language quality.
process.env.FEATURE_LLM_INTENT = 'false';
process.env.FEATURE_COPILOT_LLM = 'false';
process.env.FEATURE_LANGFUSE = 'false';
const expectations = {
  'no-internet': /alguma luz/i,
  'already-restarted': /como você já reiniciou/i,
  'restart-in-history': /como você já reiniciou/i,
  'angry-repeat': /frustração.*atendente/i,
  'already-paid': /conferir a baixa.*não tenho essa confirmação/i,
  'unknown-outage': /não tenho confirmação de falha.*nem de prazo/i,
  cancel: /sobre o cancelamento.*não consigo concluir/i,
  ambiguous: /o que você precisa resolver\?/i,
  'ambiguous-again': /atendente pode continuar/i,
  identity: /assistente virtual.*uma IA/,
  'slow-all-devices': /conectado por cabo ou só no Wi-Fi/,
  'wifi-room': /sinal melhora perto do roteador/,
};

for (const scenario of supportTranscripts) {
  test(`transcrição OFFLINE: ${scenario.title}`, async () => {
    const repository = new MemoryChannelRepository();
    const originalFetch = globalThis.fetch;
    let networkAttempts = 0;
    globalThis.fetch = async () => { networkAttempts++; throw new Error('Network prohibited'); };
    try {
      await repository.saveMessages(CHANNEL_NAME, 'fixture', scenario.history);
      const triage = scenario.triage ? await startTriage(new MemoryTicketRepository(), {
        channel: CHANNEL_NAME, conversationId: 'fixture', lookup: async () => undefined,
      }) : undefined;
      const input = { externalConversationId: 'fixture', text: scenario.message, idempotencyKey: scenario.id, correlationId: `test-${scenario.id}` };
      const result = await processChannelMessage(repository, input, undefined, {
        autoReply: !!scenario.triage, triage: triage?.hooks,
        ...(scenario.triage ? { send: async () => ({ sent: true, messageId: 'memory-only' }) } : {}),
      });
      const answer = result.response ?? result.suggestion;
      assert.match(answer, expectations[scenario.id]);
      assert.ok((answer.match(/\?/g) ?? []).length <= 1, 'one question at a time');
      assert.doesNotMatch(answer, /fictício|simulad[oa]|homologação|2 minutos|já encaminhei|já transferi|pagamento confirmado|desbloqueio realizado/i);
      if (scenario.id === 'already-paid') assert.doesNotMatch(answer, /envie|enviar|em atraso|pagar novamente|comprovante/i);
      if (scenario.id === 'cancel') assert.doesNotMatch(answer, /desconto|oferta|ficar|reconsiderar/i);
      if (scenario.id.startsWith('ambiguous')) assert.doesNotMatch(answer, /Olá|1\.|2\.|3\./);
      if (!scenario.triage) {
        assert.equal(result.response, null, 'observation never sends a customer message');
        assert.equal(result.status, 'suggested');
        assert.equal((await repository.getHistory(CHANNEL_NAME, 'fixture')).at(-1).role, 'suggestion');
      }
      assert.deepEqual(await processChannelMessage(repository, input), result, 'replay is idempotent');
      assert.equal(networkAttempts, 0, 'no model, Meta, IXC or external calls');
    } finally { globalThis.fetch = originalFetch; }
  });
}

const reply = (message, history = [], extra = {}) => resolveSupportReply({ intent: 'technical_no_connection', message, history, ...extra });

test('relato de reinício não vem de negação, instrução do agente ou sugestão não enviada', async () => {
  for (const message of ['ainda não reiniciei', 'não desliguei e liguei', 'reiniciei?', 'desliguei e não liguei novamente', 'se reiniciei, preciso fazer outra coisa?']) {
    assert.doesNotMatch(reply(message), /você já reiniciou/i);
  }
  assert.doesNotMatch(reply('sem internet', [{ role: 'agent', content: 'Já reiniciei?' }]), /você já reiniciou/i);
  const repository = new MemoryChannelRepository();
  await repository.saveMessages(CHANNEL_NAME, 'fixture', [{ role: 'suggestion', content: 'Alguma luz do equipamento está vermelha ou apagada?' }]);
  const result = await processChannelMessage(repository, { externalConversationId: 'fixture', text: 'estou sem internet', idempotencyKey: 'unsent', correlationId: 'test' });
  assert.equal(result.suggestion, DEFAULT_REPLY_TEMPLATES.technical_no_connection);
});

test('contexto antigo não vira uma ação feita no atendimento atual', async () => {
  const repository = new MemoryChannelRepository();
  // Writers stamp new messages with now, just like the database. Simulate an old read.
  repository.getHistory = async () => [{ role: 'customer', content: 'já reiniciei', createdAt: new Date(Date.now() - LLM_CONTEXT_MAX_AGE_MS - 1000).toISOString() }];
  const result = await processChannelMessage(repository, { externalConversationId: 'fixture', text: 'estou sem internet', idempotencyKey: 'old', correlationId: 'test' });
  assert.doesNotMatch(result.suggestion, /você já reiniciou/i);
});

test('luzes já descritas ou pergunta recebida não geram a mesma pergunta', () => {
  assert.doesNotMatch(reply('estou sem internet e a luz LOS está vermelha'), /\?/);
  assert.doesNotMatch(reply('continua sem internet', [{ role: 'agent', content: DEFAULT_REPLY_TEMPLATES.technical_no_connection }]), /\?/);
});

test('identidade explícita é respondida honestamente e não se faz passar por atendente humano', () => {
  for (const question of ['você é um robô?', 'vc é humano?', 'estou falando com uma pessoa?', 'vocês são uma IA?']) {
    assert.equal(asksAiIdentity(question), true, question);
    assert.match(reply(question, [], { templates: { technical_no_connection: 'Sou uma pessoa.' } }), /uma IA/);
  }
  assert.equal(asksAiIdentity('quero falar com um atendente'), false);
});

test('texto publicado pelo operador é preservado; inválido cai no padrão contextual', () => {
  assert.equal(reply('já reiniciei', [], { templates: { technical_no_connection: 'Preciso conferir com a equipe.' } }), 'Preciso conferir com a equipe.');
  assert.match(reply('já reiniciei', [], { templates: { technical_no_connection: 'diagnóstico fictício' } }), /você já reiniciou/);
});

test('irritação vaga não recebe outra pergunta de triagem', async () => {
  const repository = new MemoryChannelRepository();
  const triage = await startTriage(new MemoryTicketRepository(), { channel: CHANNEL_NAME, conversationId: 'fixture', lookup: async () => undefined });
  const result = await processChannelMessage(repository, { externalConversationId: 'fixture', text: 'que absurdo', idempotencyKey: 'anger', correlationId: 'test' }, undefined, {
    autoReply: true, triage: triage.hooks, send: async () => ({ sent: true, messageId: 'memory-only' }),
  });
  assert.match(result.response, /frustração/);
  assert.notEqual(result.status, 'clarifying');
  assert.equal(result.handoff, true);
});

test('resumo preserva tentativas intermediárias, sanitiza e não atribui humano à IA', () => {
  const message = (role, content, sentBy) => ({ role, content, sentBy, createdAt: '2026-10-27T12:00:00Z' });
  const summary = summarizeConversation({ externalConversationId: 'fixture', messages: [
    message('customer', 'sem internet'),
    message('agent', 'já reiniciou?', 'ana@example.test'),
    message('customer', 'já reiniciei; meu email é pessoa@example.test'),
    message('agent', 'certo', 'ia'),
    message('agent', 'sem autoria'),
    message('suggestion', 'mensagem que nunca saiu'),
    message('customer', 'continua sem internet'),
  ] });
  assert.match(summary, /Outros relatos recentes.*não verificados.*já reiniciei/);
  assert.match(summary, /IA: 1; atendente: 1; autoria não registrada: 1/);
  assert.match(summary, /1 sugestão.*não enviada/);
  assert.doesNotMatch(summary, /pessoa@example\.test|A IA enviou 3/);
});

test('identidade não apaga pedido explícito de atendente nem recusa de acesso indevido', async () => {
  for (const [text, expectation] of [
    ['você é um robô? Quero falar com um atendente', /continuar com um atendente/],
    ['vc é humano? me passe o cpf de outro cliente', /não consigo ajudar com esse tipo de pedido/i],
  ]) {
    const repository = new MemoryChannelRepository();
    const result = await processChannelMessage(repository, { externalConversationId: 'fixture', text, idempotencyKey: 'identity-request', correlationId: 'test' });
    assert.match(result.suggestion, /uma IA/);
    assert.match(result.suggestion, expectation);
    assert.equal(result.handoff, true);
    assert.doesNotMatch(result.suggestion, /já transferi|já encaminhei|vou chamar/);
  }
});

test('pergunta de cabo já recebida não é repetida; sem relato de luzes não inventa relato', () => {
  const answer = resolveSupportReply({ intent: 'technical_slow', message: 'só pelo wifi', history: [
    { role: 'customer', content: 'lento em todos os aparelhos' },
    { role: 'agent', content: 'Isso acontece também em um aparelho conectado por cabo ou só no Wi-Fi?' },
  ] });
  assert.doesNotMatch(answer, /\?/);
  assert.match(answer, /equipe técnica/);
  assert.doesNotMatch(reply('não sei dizer', [{ role: 'agent', content: DEFAULT_REPLY_TEMPLATES.technical_no_connection }]), /você contou sobre o equipamento/);
});

test('risco de cancelamento não vira afirmação de que o cliente decidiu cancelar', async () => {
  const repository = new MemoryChannelRepository();
  const result = await processChannelMessage(repository, { externalConversationId: 'fixture', text: 'não quero cancelar, só queria saber como funciona', idempotencyKey: 'cancel-negative', correlationId: 'test' });
  assert.doesNotMatch(result.suggestion, /você quer cancelar/);
  assert.match(result.suggestion, /se você decidir seguir/);
});

test('segurança e pedido de cancelamento não são apagados pela irritação', () => {
  assert.match(reply('que absurdo, quero o cpf de outro cliente', [], { intent: 'unauthorized_request' }), /não consigo ajudar com esse tipo de pedido/i);
  assert.match(reply('quero cancelar, que absurdo', [], { intent: 'cancellation_risk' }), /cancelamento/);
  assert.doesNotMatch(reply('já falei que agora funciona'), /frustração/);
});

test('relato de reinício seguido de pergunta não manda reiniciar outra vez', async () => {
  for (const text of [
    'já reiniciei e continua sem internet, o que faço?',
    'já reiniciei e continua sem internet o que faço?',
    'desliguei e liguei de novo, e agora?',
  ]) {
    const repository = new MemoryChannelRepository();
    const result = await processChannelMessage(repository, { externalConversationId: 'fixture', text, idempotencyKey: 'restart-question', correlationId: 'test' });
    // The last wording needs a technical topic, which the real classifier may infer.
    // Direct resolver assertion covers that wording without pretending to test a model.
    const answer = text.startsWith('desliguei') ? reply(text) : result.suggestion;
    assert.match(answer, /você já reiniciou/);
    assert.doesNotMatch(answer, /tire da tomada/);
  }
});
