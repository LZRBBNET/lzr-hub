import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentPipeline } from '../lib/agent/pipeline.ts';
import { supportRequest, supportReportSummary } from '../lib/agent/troubleshooting-context.ts';
import { resolveSupportReply } from '../lib/platform/support-reply.ts';
const history = [{ role: 'customer', content: 'minha internet está lenta, já reiniciei' }, { role: 'agent', content: 'O problema no Wi-Fi acontece em qual cômodo?' }];
const respond = (message, turns = history, intentOverride) => {
  const result = runAgentPipeline(message, turns, { intentOverride });
  return { intent: result.intent, text: resolveSupportReply({ intent: result.intent, message, history: turns, handoffReason: result.handoff.reason }) };
};
for (const message of ['não posso falar agora', 'não consigo responder agora', 'não posso conversar agora', 'não to com tempo pra ta conversando, estou no trabalho']) {
  test(`indisponibilidade explícita encerra perguntas: ${message}`, () => {
    const result = respond(message, history, { intent: 'technical_wifi', confidence: 0.99 });
    assert.equal(result.intent, 'human_handoff'); assert.doesNotMatch(result.text, /\?|já encaminhei|vou encaminhar|agendad|protocolo/);
    assert.match(result.text, /não vou insistir/); assert.match(result.text, /lentidão relatada/); assert.match(result.text, /reinício já tentado/);
  });
}
for (const message of ['quero um técnico aqui', 'preciso de um técnico aqui', 'manda um técnico aqui', 'tem como mandar alguem vim aqui pra resolver?']) {
  test(`pedido técnico sem fingir agendamento: ${message}`, () => {
    const result = respond(message, history, { intent: 'technical_wifi', confidence: 0.99 });
    assert.equal(result.intent, 'technical_visit'); assert.doesNotMatch(result.text, /\?|vou encaminhar|vou mandar|visita agendada|já agendei|horário marcado/);
    assert.match(result.text, /avaliar a visita/);
  });
}
for (const message of ['não quero técnico', 'não precisa chamado', 'não quero atendente', 'não preciso de uma visita']) {
  test(`negação não autoriza pedido: ${message}`, () => {
    assert.equal(supportRequest(message), undefined);
    for (const intent of ['technical_visit', 'technical_ticket', 'human_handoff']) {
      const result = respond(message, history, { intent, confidence: 0.99 });
      assert.ok(!['technical_visit', 'technical_ticket', 'human_handoff'].includes(result.intent));
      assert.doesNotMatch(result.text, /Entendi o pedido|avaliar a visita|abertura ou protocolo|atendente pode continuar/);
    }
  });
}

test('negação local não apaga um pedido diferente afirmado depois', () => {
  assert.equal(supportRequest('não quero técnico, quero um atendente'), 'human');
  assert.equal(supportRequest('não quero visita, mas abre um chamado'), 'ticket');
  assert.equal(supportRequest('não funciona e quero um técnico'), 'visit');
  assert.equal(supportRequest('não quero técnico e quero atendente'), 'human');
});

test('abertura de chamado exige confirmação, não promessa de ação', () => {
  const result = respond('abre um chamado para mim');
  assert.equal(result.intent, 'technical_ticket');
  assert.doesNotMatch(result.text, /\?|vou encaminhar|já abri|confirma o protocolo com você/);
  assert.match(result.text, /ainda não tenho abertura ou protocolo confirmados/);
});

test('resumo limitado a relatos, sem copiar dados privados ou diagnóstico', () => {
  const summary = supportReportSummary('quero um técnico', [...history, {role:'customer',content:'meu CPF é 12345678900, moro na rua exemplo 10; em partidas online cai'}]);
  assert.match(summary, /lentidão relatada/); assert.match(summary, /reinício já tentado/);
  assert.doesNotMatch(summary, /12345678900|rua exemplo|falha na rede|sinal fraco|problema no roteador/);
  assert.equal(supportReportSummary('quero técnico', []), '');
  assert.doesNotMatch(supportReportSummary('não trava', []), /lentidão/);
});

test('parada clara não é anulada por template de perguntas', () => {
  const result = resolveSupportReply({intent:'human_handoff',message:'não posso falar agora',history,templates:{human_handoff:'Em qual cômodo? Já reiniciou?'}});
  assert.doesNotMatch(result,/\?/); assert.match(result,/não vou insistir/);
});

test('rótulo técnico alternativo não contorna parada explícita', () => {
  for (const intent of ['technical_no_connection', 'technical_ticket', 'technical_visit']) {
    const result = respond('não posso falar agora', history, {intent,confidence:0.99});
    assert.equal(result.intent,'human_handoff'); assert.doesNotMatch(result.text,/\?/);
  }
});
test('resumo omite negação e hipótese em vez de atribuir sintoma', () => {
  for (const content of ['não há lentidão', 'não tenho lentidão', 'se ficar lento eu aviso', 'talvez esteja lento', 'posso testar pelo cabo ou wi-fi', 'quero testar pelo cabo em vez do wi-fi', 'se a partida online cai, reinicio']) {
    assert.equal(supportReportSummary('quero técnico', [{role:'customer',content}]), '');
  }
});
