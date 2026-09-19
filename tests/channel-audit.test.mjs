import test from "node:test";
import assert from "node:assert/strict";
import { MemoryChannelRepository, processChannelMessage } from "../lib/platform/n8n-channel-service.ts";
import { MemorySupportMetricsRepository } from "../lib/platform/support-metrics.ts";
import { appVersion } from "../lib/runtime/app-version.ts";

/**
 * O que precisa ser provável depois: o que a IA disse, a quem, por quê, quem
 * classificou e qual código produziu aquilo.
 */

const input = (over = {}) => ({
  externalConversationId: "557999151289",
  text: "minha internet ta lenta",
  idempotencyKey: "msg-1",
  correlationId: "corr-abc",
  ...over,
});

async function processar(options = { autoReply: false }) {
  const channel = new MemoryChannelRepository();
  const metrics = new MemorySupportMetricsRepository();
  await processChannelMessage(channel, input(), metrics, options);
  return { channel, metrics };
}

test("a mensagem gravada carrega o rastro", async () => {
  // Sem isto, do registro de auditoria não se chegava à frase exata — só por
  // conversa e horário, que é aproximação.
  const { channel } = await processar();
  const gravadas = await channel.getHistory("n8n-whatsapp", "557999151289");
  assert.equal(gravadas.length, 2);
  for (const mensagem of gravadas) assert.equal(mensagem.correlationId, "corr-abc");
});

test("o desfecho registra quem classificou e com quanta certeza", async () => {
  const { metrics } = await processar();
  const desfecho = metrics.outcomes[0];
  // Sem chave da Groq configurada, quem decide é a regex — e isso fica dito.
  assert.equal(desfecho.intentSource, "rules");
  assert.equal(typeof desfecho.intentConfidence, "number");
  assert.ok(desfecho.intentConfidence >= 0 && desfecho.intentConfidence <= 100, "percentual inteiro");
  assert.equal(desfecho.intentModel, null, "regex não tem modelo");
});

test("o desfecho carrega a versão do código", async () => {
  // Mudar o prompt não pode tornar o passado inexplicável.
  const { metrics } = await processar();
  assert.equal(metrics.outcomes[0].appVersion, appVersion());
});

test("com resposta automática ligada, a auditoria diz que ENVIOU, e o quê", async () => {
  // "Mensagem recebida" descrevia a metade inofensiva e calava a outra — que é
  // um texto ter saído para um cliente real.
  const { channel } = await processar({ autoReply: true });
  const registro = channel.audits[0];
  assert.match(registro.reason, /ENVIADA ao cliente/);
  assert.match(registro.reason, /"/, "o texto que saiu fica no registro");
  assert.equal(registro.correlationId, "corr-abc");
});

test("em modo observação, a auditoria diz que NÃO enviou", async () => {
  const { channel } = await processar({ autoReply: false });
  assert.match(channel.audits[0].reason, /apenas sugerida, não enviada/);
  assert.doesNotMatch(channel.audits[0].reason, /ENVIADA/);
});

test("o texto no registro passa pela sanitização", async () => {
  // A auditoria é lida por quem não participou do atendimento. A regra do
  // projeto não abre exceção para "este caso não tem dado pessoal".
  const channel = new MemoryChannelRepository();
  await processChannelMessage(channel, input({ text: "meu cpf 529.982.247-25 e email a@b.com" }), new MemorySupportMetricsRepository(), { autoReply: true });
  for (const registro of channel.audits) {
    assert.doesNotMatch(registro.reason, /529\.982\.247-25/);
    assert.doesNotMatch(registro.reason, /a@b\.com/);
  }
});

test("o mesmo rastro liga mensagem, desfecho e auditoria", async () => {
  // É a corrente inteira: da linha de auditoria até a frase exata.
  const { channel, metrics } = await processar({ autoReply: true });
  const mensagens = await channel.getHistory("n8n-whatsapp", "557999151289");
  assert.equal(channel.audits[0].correlationId, "corr-abc");
  assert.equal(metrics.outcomes[0].correlationId, "corr-abc");
  assert.equal(mensagens[0].correlationId, "corr-abc");
});

test("versão vem do Railway, e fora dele é nula em vez de inventada", () => {
  assert.equal(appVersion({ RAILWAY_GIT_COMMIT_SHA: "92e41ff0123456789" }), "92e41ff");
  assert.equal(appVersion({ APP_VERSION: "abcdef0" }), "abcdef0");
  // Carimbar "local" ou "v1" seria pôr um número falso na auditoria.
  assert.equal(appVersion({}), null);
  assert.equal(appVersion({ RAILWAY_GIT_COMMIT_SHA: "   " }), null);
});
