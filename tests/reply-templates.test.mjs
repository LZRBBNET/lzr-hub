import test from "node:test";
import assert from "node:assert/strict";
import { INTENTS } from "../lib/agent/llm-classifier.ts";
import {
  MemoryReplyTemplatesRepository,
  ReplyTemplateValidationError,
  loadOverrides,
  resetTemplate,
  saveTemplate,
  templatesView,
} from "../lib/platform/reply-templates-service.ts";
import {
  DEFAULT_REPLY_TEMPLATES,
  REPLY_INTENTS,
  containsHomologationText,
  resolveReply,
  validateReplyText,
} from "../lib/platform/reply-templates-shared.ts";
import { LLM_CONTEXT_MAX_AGE_MS, LLM_CONTEXT_TURNS, MemoryChannelRepository, contextForClassifier, processChannelMessage } from "../lib/platform/n8n-channel-service.ts";
import { MemorySupportMetricsRepository } from "../lib/platform/support-metrics.ts";

test("todas as intenções têm resposta padrão, e nenhuma é texto de homologação", () => {
  for (const intent of INTENTS) {
    assert.ok(DEFAULT_REPLY_TEMPLATES[intent], `sem padrão para ${intent}`);
    assert.equal(validateReplyText(DEFAULT_REPLY_TEMPLATES[intent]), null, `padrão de ${intent} não passa na própria validação`);
  }
  assert.deepEqual(REPLY_INTENTS.map((entry) => entry.intent).sort(), [...INTENTS].sort(), "a lista de telas cobre exatamente as intenções do classificador");
});

test("validação recusa vazio, longo, homologação e dado pessoal", () => {
  assert.match(validateReplyText("   "), /Escreva/);
  assert.match(validateReplyText("a".repeat(1001)), /1000/);
  for (const texto of ["Preparei a segunda via fictícia.", "Em homologação.", "Diagnóstico simulado."]) {
    assert.match(validateReplyText(texto), /homologa/i, texto);
  }
  assert.match(validateReplyText("Fale com ana@bbnet.com.br"), /e-mail, CPF ou telefone/);
  assert.match(validateReplyText("Seu CPF 529.982.247-25 está ok"), /e-mail, CPF ou telefone/);
  assert.match(validateReplyText("Ligue para (79) 99830-7232"), /e-mail, CPF ou telefone/);
  assert.equal(validateReplyText("Vou encaminhar para um atendente, que retorna por aqui."), null);
});

test("texto com 'simulado' ou 'fictício' é detectado, texto comum não", () => {
  assert.equal(containsHomologationText("No diagnóstico simulado, a ONU está online"), true);
  assert.equal(containsHomologationText("Preparei um chamado fictício"), true);
  assert.equal(containsHomologationText("Vou abrir um chamado para a equipe técnica."), false);
});

test("resposta editada vale; editada inválida cai no padrão em vez de ir ao cliente", () => {
  assert.equal(resolveReply("human_handoff", { human_handoff: "Já chamo alguém para você." }), "Já chamo alguém para você.");
  assert.equal(resolveReply("human_handoff", {}), DEFAULT_REPLY_TEMPLATES.human_handoff);
  assert.equal(resolveReply("human_handoff", { human_handoff: "texto fictício" }), DEFAULT_REPLY_TEMPLATES.human_handoff);
  assert.equal(resolveReply("human_handoff", { human_handoff: "   " }), DEFAULT_REPLY_TEMPLATES.human_handoff);
});

test("salvar sobe a versão e devolve o texto anterior para a auditoria", async () => {
  const repository = new MemoryReplyTemplatesRepository();
  const primeira = await saveTemplate(repository, { intent: "financial_pix", content: "Já envio o PIX para você." }, "ana@bbnet.com.br");
  assert.equal(primeira.saved.version, 1);
  assert.equal(primeira.previous, DEFAULT_REPLY_TEMPLATES.financial_pix, "a primeira edição substitui o padrão");
  const segunda = await saveTemplate(repository, { intent: "financial_pix", content: "Envio o PIX em instantes." }, "bia@bbnet.com.br");
  assert.equal(segunda.saved.version, 2);
  assert.equal(segunda.previous, "Já envio o PIX para você.");
  assert.equal(segunda.saved.updatedBy, "bia@bbnet.com.br");
});

test("salvar recusa intenção desconhecida e texto inválido", async () => {
  const repository = new MemoryReplyTemplatesRepository();
  await assert.rejects(saveTemplate(repository, { intent: "inventada", content: "ok" }, "a@b.com"), ReplyTemplateValidationError);
  await assert.rejects(saveTemplate(repository, { intent: "financial_pix", content: "PIX fictício" }, "a@b.com"), ReplyTemplateValidationError);
  await assert.rejects(saveTemplate(repository, { intent: "financial_pix", content: 42 }, "a@b.com"), ReplyTemplateValidationError);
  assert.equal(repository.rows.size, 0, "nada gravado em caso de recusa");
});

test("voltar ao padrão remove a edição e lembra o que havia", async () => {
  const repository = new MemoryReplyTemplatesRepository();
  await saveTemplate(repository, { intent: "complaint", content: "Sinto muito. Já encaminho." }, "a@b.com");
  const resultado = await resetTemplate(repository, "complaint");
  assert.equal(resultado.previous, "Sinto muito. Já encaminho.");
  assert.equal(repository.rows.size, 0);
  assert.equal((await resetTemplate(repository, "complaint")).previous, null, "sem edição, nada a descartar");
});

test("ler as edições nunca derruba o atendimento", async () => {
  const quebrado = { list: async () => { throw new Error("banco fora"); }, upsert: async () => { throw new Error("x"); }, remove: async () => false };
  assert.deepEqual(await loadOverrides(quebrado), {}, "sem banco, vale o padrão do código");

  const repository = new MemoryReplyTemplatesRepository();
  await saveTemplate(repository, { intent: "human_handoff", content: "Chamo alguém já." }, "a@b.com");
  assert.deepEqual(await loadOverrides(repository), { human_handoff: "Chamo alguém já." });
});

test("a visão tem uma linha por intenção, com o texto em vigor e o padrão", async () => {
  const repository = new MemoryReplyTemplatesRepository();
  await saveTemplate(repository, { intent: "technical_slow", content: "Me conte onde fica lento." }, "ana@bbnet.com.br");
  const visao = await templatesView(repository);
  assert.equal(visao.length, INTENTS.length);
  const editada = visao.find((linha) => linha.intent === "technical_slow");
  assert.equal(editada.edited, true);
  assert.equal(editada.content, "Me conte onde fica lento.");
  assert.equal(editada.defaultContent, DEFAULT_REPLY_TEMPLATES.technical_slow);
  assert.equal(editada.version, 1);
  const padrao = visao.find((linha) => linha.intent === "technical_wifi");
  assert.equal(padrao.edited, false);
  assert.equal(padrao.content, DEFAULT_REPLY_TEMPLATES.technical_wifi);
  assert.equal(padrao.version, null);
});

/* ------------------------------------------------------- canal --- */

const entrada = (over = {}) => ({ externalConversationId: "5579991234567", text: "estou sem internet", idempotencyKey: "wamid.ENTRADA1", correlationId: "corr-1", ...over });

test("o canal sugere a resposta aprovada, nunca o texto de homologação do pipeline", async () => {
  const canal = new MemoryChannelRepository();
  const resultado = await processChannelMessage(canal, entrada(), new MemorySupportMetricsRepository(), { autoReply: false });
  assert.equal(resultado.suggestion, DEFAULT_REPLY_TEMPLATES.technical_no_connection);
  assert.equal(containsHomologationText(resultado.suggestion), false);
  const gravadas = await canal.getHistory("n8n-whatsapp", "5579991234567");
  assert.equal(gravadas.find((m) => m.role === "suggestion").content, DEFAULT_REPLY_TEMPLATES.technical_no_connection);
});

test("a edição feita pela BBNET é o que o canal usa", async () => {
  const canal = new MemoryChannelRepository();
  const resultado = await processChannelMessage(canal, entrada(), new MemorySupportMetricsRepository(), {
    autoReply: false, templates: { technical_no_connection: "Já olho isso para você." },
  });
  assert.equal(resultado.suggestion, "Já olho isso para você.");
});

test("com resposta automática, o que sai é o texto aprovado", async () => {
  const canal = new MemoryChannelRepository();
  const resultado = await processChannelMessage(canal, entrada({ text: "quero falar com um atendente" }), new MemorySupportMetricsRepository(), { autoReply: true });
  assert.equal(resultado.response, DEFAULT_REPLY_TEMPLATES.human_handoff);
  assert.equal(containsHomologationText(resultado.response), false);
});

test("a fala do cliente guarda o id da mensagem na Meta", async () => {
  const canal = new MemoryChannelRepository();
  await processChannelMessage(canal, entrada(), new MemorySupportMetricsRepository(), { autoReply: false });
  const cliente = (await canal.getHistory("n8n-whatsapp", "5579991234567")).find((m) => m.role === "customer");
  assert.equal(cliente.externalMessageId, "wamid.ENTRADA1", "é com este id que se marca como lida");
});

/* ------------------------------------------------------- memória --- */

const linha = (role, content, minutosAtras) => ({ role, content, createdAt: new Date(Date.now() - minutosAtras * 60_000).toISOString() });

test("o contexto do classificador deixa de fora a sugestão, que o cliente nunca viu", () => {
  const contexto = contextForClassifier([linha("customer", "estou sem internet", 5), linha("suggestion", "texto da IA", 5), linha("agent", "reiniciou?", 4)]);
  assert.deepEqual(contexto.map((turno) => turno.role), ["customer", "agent"]);
});

test("o contexto guarda só as últimas falas", () => {
  const muitas = Array.from({ length: 20 }, (_, i) => linha("customer", `fala ${i}`, 20 - i));
  const contexto = contextForClassifier(muitas);
  assert.equal(contexto.length, LLM_CONTEXT_TURNS);
  assert.equal(contexto.at(-1).content, "fala 19", "as mais recentes");
});

test("conversa de ontem não explica a de hoje", () => {
  const antigas = Math.round(LLM_CONTEXT_MAX_AGE_MS / 60_000) + 5;
  const contexto = contextForClassifier([linha("customer", "sem internet ontem", antigas), linha("customer", "sim", 2)]);
  assert.deepEqual(contexto.map((turno) => turno.content), ["sim"]);
});

test("fala sem carimbo de data não é descartada: não há como afirmar que é antiga", () => {
  const contexto = contextForClassifier([{ role: "customer", content: "sem carimbo" }]);
  assert.equal(contexto.length, 1);
});
