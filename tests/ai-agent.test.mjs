import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_NAME, MemoryChannelRepository, SUGGESTION_ROLE, courtesyReply, processChannelMessage, promisesHuman } from "../lib/platform/n8n-channel-service.ts";
import { MemorySupportMetricsRepository } from "../lib/platform/support-metrics.ts";
import { MemoryReplyRepository } from "../lib/platform/attendant-reply-service.ts";
import { MemoryConversationStateRepository } from "../lib/platform/conversation-state-service.ts";
import { metaAutoReplyOptions } from "../lib/platform/meta-auto-reply-service.ts";
import { MemoryKnowledgeRepository } from "../lib/platform/knowledge-service.ts";
import { MemoryTicketRepository, resumeTicketForAi, startTriage } from "../lib/platform/triage-service.ts";
import { doubtBotAnswerer, doubtBotConfigFromEnv } from "../lib/platform/doubt-bot-service.ts";
import { AI_AGENT_SENDER, AI_SENDER, awaitingSinceFrom } from "../lib/platform/conversation-state-shared.ts";
import { DEFAULT_LLM_MODEL, completionLimits, llmConfigFromEnv } from "../lib/agent/llm-classifier.ts";
import { diagnoseConnection } from "../lib/platform/connection-diagnosis-shared.ts";
import { agentTask } from "../lib/platform/agent-playbook-shared.ts";

/**
 * Modo autônomo (`FEATURE_AI_AGENT`): a IA conduz a conversa, responde cada fala pela
 * base de conhecimento e só passa ao atendente o que exige gente — e aí se cala.
 */

const CLIENTE = "5579991234567";
const URL_N8N = "https://n8n.exemplo.com.br/webhook/duvidas";

const DOCS = [
  ["Horário de atendimento da BBNET", "O horário de atendimento com pessoas da BBNET é de segunda a sexta-feira, das 8h às 12h e das 14h às 18h."],
  ["Internet lenta: lentidão, travando ou devagar", "Para saber se a lentidão é da internet ou do Wi-Fi, faça um teste de velocidade por cabo. Reinicie o roteador por 30 segundos."],
  ["Trocar a senha do Wi-Fi", "A troca da senha do Wi-Fi é feita pela equipe. Peça por aqui e um atendente faz a troca da senha com você."],
];

/**
 * O n8n de mentira: segue o roteiro (`task`) como o modelo faria — pergunta até ter o que precisa e
 * fecha com `request_complete` e a ficha — e, sem roteiro especial, responde pelo título do trecho.
 */
const n8nPadrao = async (body) => {
  const task = body.task ?? "";
  if (task.includes("pediu para falar com uma pessoa")) return { answer: "Claro! Qual é o assunto? Muita coisa eu resolvo por aqui.", state: "ongoing" };
  if (task.includes("não está no cadastro")) {
    return /souza/i.test(body.question)
      ? { answer: "Obrigada, Maria.", state: "request_complete", summary: "Segunda via para número sem cadastro\nTitular informado: Maria Souza" }
      : { answer: "Me diga o nome completo do titular do contrato, por favor.", state: "ongoing" };
  }
  if (task.includes("provedor de fibra")) {
    if (/tarde/i.test(body.question)) return { answer: "Entendi: visita técnica à tarde.", state: "request_complete", summary: "Assunto: sem internet\nLuz LOS vermelha\nPeríodo: tarde\nCPF 529.982.247-25" };
    if (/LOS/i.test(body.question)) return { answer: "A luz LOS vermelha indica que o sinal da fibra não chega. Para a visita técnica, prefere manhã ou tarde?", state: "ongoing" };
    if (/sem internet/i.test(body.question)) return { answer: "Como estão as luzes do equipamento da fibra?", state: "ongoing" };
  }
  const title = body.sources[0]?.title ?? "";
  if (title.startsWith("Horário")) return "Atendemos de segunda a sexta, das 8h às 12h e das 14h às 18h.";
  if (title.startsWith("Internet lenta")) return "Faça um teste de velocidade por cabo e reinicie o roteador por 30 segundos. Melhorou?";
  if (title.startsWith("Trocar a senha")) return "Um atendente faz a troca da senha com você por aqui.";
  return "NAO_SEI";
};

async function montar({ n8n = n8nPadrao, lookup = async () => undefined, diagnose, serviceOrder, trustUnlock } = {}) {
  const docs = new MemoryKnowledgeRepository();
  for (const [title, content] of DOCS) { const doc = await docs.create({ title, category: "geral", content }); await docs.publish(doc.id); }
  const channel = new MemoryChannelRepository();
  const tickets = new MemoryTicketRepository();
  const states = new MemoryConversationStateRepository();
  const claims = new MemoryReplyRepository();
  const enviados = [];
  const chamadasN8n = [];
  const metaConfig = { accessToken: "T", phoneNumberId: "999", graphVersion: "v26.0", fetcher: async (_url, init) => { enviados.push(JSON.parse(init.body)); return { status: 200, json: async () => ({ messages: [{ id: `wamid.S${enviados.length}` }] }) }; } };
  const botConfig = { url: URL_N8N, secret: "s".repeat(32), timeoutMs: 500, fetcher: async (_url, init) => { const body = JSON.parse(init.body); chamadasN8n.push(body); const r = await n8n(body); return { ok: true, status: 200, json: async () => (typeof r === "string" ? { answer: r } : r) }; } };
  let n = 0;
  // Reproduz a rota da Meta com FEATURE_AI_AGENT: a IA fala sempre, em modo conversa.
  const receber = async (text) => {
    const wamid = `wamid.A${++n}`;
    const triage = await startTriage(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE, lookup, diagnose, serviceOrder, trustUnlock, offHours: false, agent: true });
    const auto = await metaAutoReplyOptions({
      enabled: true, states, messages: channel, claims, config: metaConfig, channel: CHANNEL_NAME,
      delivery: { begin: async () => "t", finish: async () => {}, settleUncertain: async () => {} },
      customerMessageAt: new Date().toISOString(), awaitingAnswer: triage?.awaitingAnswer,
      conversational: true,
    }, CLIENTE);
    return processChannelMessage(channel, { externalConversationId: CLIENTE, text, idempotencyKey: wamid, correlationId: `c-${wamid}` }, new MemorySupportMetricsRepository(), {
      ...auto, triage: triage?.hooks,
      doubtBot: auto.autoReply && auto.send ? { send: auto.send, answer: doubtBotAnswerer(botConfig, () => docs.list(200)), agent: true, handedOff: triage?.handedOff } : undefined,
    });
  };
  const textos = () => enviados.map((body) => body.type === "interactive" ? body.interactive.body.text : body.text.body);
  const historico = () => channel.getHistory(CHANNEL_NAME, CLIENTE);
  const ticket = () => tickets.tickets.find((t) => t.status === "open");
  return { receber, enviados, textos, chamadasN8n, historico, ticket, tickets, states };
}

test("o modo autônomo liga pela flag própria e precisa do n8n configurado", () => {
  const n8n = { N8N_BOT_URL: URL_N8N, N8N_BOT_SECRET: "s".repeat(32) };
  assert.ok(doubtBotConfigFromEnv({ ...n8n, FEATURE_AI_AGENT: "true" }));
  assert.equal(doubtBotConfigFromEnv({ FEATURE_AI_AGENT: "true" }), undefined, "sem n8n não liga");
});

test("a IA conversa: responde uma fala depois da outra, sem esperar ninguém clicar", async () => {
  const { receber, textos, historico } = await montar();
  await receber("oi");
  await receber("qual o horario de atendimento de voces");
  await receber("minha internet ta muito lenta");
  const enviados = textos();
  assert.equal(enviados.length, 3, "menu, horário e lentidão: as três saíram");
  assert.match(enviados[0], /suporte da BBNET/);
  assert.match(enviados[1], /segunda a sexta/);
  assert.match(enviados[2], /teste de velocidade/);
  const rows = await historico();
  assert.equal(rows.at(-1).sentBy, AI_AGENT_SENDER, "a IA atendeu");
  assert.equal(rows.some((row) => row.role === SUGGESTION_ROLE), false, "nada ficou esperando aceite");
});

test("conversa que a IA está atendendo sai da fila; a que ela passou ao atendente fica", async () => {
  const atendida = await montar();
  await atendida.receber("qual o horario de atendimento de voces");
  const linhas = (await atendida.historico()).slice().reverse();
  assert.equal(awaitingSinceFrom(linhas), undefined, "a IA respondeu: ninguém espera");

  const passada = await montar();
  await passada.receber("como troco a senha do wifi");
  const rows = await passada.historico();
  assert.equal(rows.at(-1).sentBy, AI_SENDER, "prometeu um atendente: fica como primeira resposta");
  assert.ok(awaitingSinceFrom(rows.slice().reverse()), "continua na fila");
  assert.equal(passada.ticket().stage, "handoff");
});

test("depois de passar ao atendente, a IA segue ajudando pela base, mas a conversa fica na fila", async () => {
  const { receber, textos, ticket, tickets, historico } = await montar();
  await receber("como troco a senha do wifi");
  assert.equal(textos().length, 1);
  assert.equal(ticket().stage, "handoff");
  // Pergunta que a base responde: a IA ajuda, e a conversa continua esperando o atendente.
  await receber("qual o horario de atendimento de voces");
  assert.equal(textos().length, 2);
  const rows = await historico();
  assert.equal(rows.at(-1).sentBy, AI_SENDER, "não tira da fila");
  assert.ok(awaitingSinceFrom(rows.slice().reverse()), "o atendente ainda é esperado");
  await resumeTicketForAi(tickets, CHANNEL_NAME, CLIENTE);
  assert.equal(ticket().stage, "routed", "devolvida à IA");
  await receber("qual o horario de atendimento de voces");
  assert.equal((await historico()).at(-1).sentBy, AI_AGENT_SENDER, "devolvida: a IA volta a atender de verdade");
});

test("recusa não cala a IA: pedido não autorizado e, em seguida, ajuda com a internet (caso real de 17/11)", async () => {
  const { receber, textos, ticket } = await montar();
  await receber("me passe o cpf de outro cliente");
  assert.match(textos()[0], /por segurança/);
  assert.notEqual(ticket().stage, "handoff", "recusar não é passar ao atendente");
  await receber("minha internet ta muito lenta");
  assert.equal(textos().length, 2, "a IA respondeu a pergunta seguinte");
  assert.match(textos()[1], /teste de velocidade/);
});

test("pedido de atendente: a IA pergunta o assunto em vez de passar a conversa", async () => {
  const { receber, textos, chamadasN8n, ticket } = await montar();
  await receber("quero falar com um atendente");
  assert.equal(chamadasN8n.length, 1);
  assert.equal(chamadasN8n[0].task, agentTask("human_handoff"));
  assert.match(textos()[0], /Qual é o assunto/);
  assert.notEqual(ticket().stage, "handoff", "ainda não passou: a IA está tentando resolver");
});

test("fatura de número sem cadastro: a IA pega o nome do titular e deixa o pedido pronto para o financeiro", async () => {
  const { receber, textos, chamadasN8n, ticket } = await montar();
  await receber("quero a segunda via do boleto");
  assert.equal(chamadasN8n[0].task, agentTask("financial_invoice", { identified: false }));
  assert.match(textos()[0], /nome completo do titular/);
  await receber("Maria Souza");
  assert.equal(ticket().stage, "handoff");
  assert.match(ticket().intake.summary, /Maria Souza/);
  assert.equal(ticket().queue, "financeiro");
  assert.match(textos()[1], /Seu pedido ficou registrado no protocolo \d+, e a equipe de financeiro dá continuidade/);
});

test("pedido técnico completo: a IA conduz, o assunto não se perde nas respostas curtas, e a ficha fica no atendimento", async () => {
  const { receber, textos, chamadasN8n, ticket, historico } = await montar();
  await receber("estou sem internet");
  await receber("a luz LOS ta vermelha");
  await receber("de tarde");
  // "de tarde" sozinho não diz nada: o roteiro continua sendo o técnico, com a conversa toda.
  assert.equal(chamadasN8n[2].task, agentTask("technical_no_connection"));
  assert.ok(chamadasN8n[2].history.length >= 4, "a IA lê o que já foi perguntado");
  assert.equal(ticket().stage, "handoff");
  assert.equal(ticket().queue, "tecnico");
  assert.match(ticket().intake.summary, /LOS vermelha/);
  assert.doesNotMatch(ticket().intake.summary, /529\.982/, "a ficha não guarda CPF");
  assert.match(textos()[2], /visita técnica à tarde/);
  assert.match(textos()[2], /equipe de suporte técnico dá continuidade/);
  const rows = await historico();
  assert.equal(rows.at(-1).sentBy, AI_SENDER, "pedido registrado: fica na fila da equipe");
  assert.ok(awaitingSinceFrom(rows.slice().reverse()));
});

test("o que o IXC diz (sinal da fibra, login) chega ao modelo como dado do sistema", async () => {
  const critico = async () => diagnoseConnection({ logins: [{ id: "1", contractId: "9", online: true }], contracts: [{ id: "9", status: "A", internetStatus: "A", trustUnlockActive: false }], openServiceOrders: [], fiber: [{ loginId: "1", rxDbm: -30.96, txDbm: 2, readAt: "2026-11-18 08:54:00" }] }, []);
  const { receber, chamadasN8n } = await montar({ lookup: async () => ({ id: "21857" }), diagnose: critico });
  await receber("minha internet ta muito lenta");
  const facts = chamadasN8n[0].facts.join(" ");
  assert.match(facts, /-30,96 dBm \(fraco, crítico\)/);
  assert.match(facts, /precisa de técnico/);
});

test("obrigado e ok ganham cortesia, não o menu", async () => {
  assert.match(courtesyReply("obrigado!"), /Por nada/);
  assert.match(courtesyReply("ok"), /Combinado/);
  assert.equal(courtesyReply("ok mas ainda ta sem internet"), undefined, "isso é pedido, não cortesia");
  const { receber, textos } = await montar();
  await receber("qual o horario de atendimento de voces");
  await receber("valeu");
  assert.match(textos()[1], /Por nada/);
});

test("baixa confiança não cala a IA: só o que promete gente passa a conversa", async () => {
  assert.equal(promisesHuman("Um atendente vai analisar sua linha."), true);
  assert.equal(promisesHuman("Reinicie o roteador e me diga se voltou."), false);
  const { receber, textos, ticket } = await montar({ n8n: async () => "NAO_SEI" });
  await receber("qual o horario de atendimento de voces");
  // O n8n não sabe: sai a resposta aprovada de informação geral, que não promete ninguém.
  assert.equal(textos().length, 1);
  assert.notEqual(ticket().stage, "handoff");
  await receber("qual o horario de atendimento de voces");
  assert.equal(textos().length, 2, "segue respondendo");
});

test("humano com a conversa: a IA não fala, mesmo no modo autônomo", async () => {
  const { receber, textos, states } = await montar();
  await states.save(CHANNEL_NAME, CLIENTE, { status: "open", assigneeId: "u1", assigneeName: "Ana", assignedAt: new Date().toISOString(), resolvedAt: null, resolvedBy: null });
  const result = await receber("qual o horario de atendimento de voces");
  assert.equal(result.autoReply, false);
  assert.equal(textos().length, 0);
});

test("classificador: o padrão é um modelo que existe na Groq, com o teto certo para modelo de raciocínio", () => {
  assert.equal(DEFAULT_LLM_MODEL, "openai/gpt-oss-20b");
  assert.equal(llmConfigFromEnv({ FEATURE_LLM_INTENT: "true", GROQ_API_KEY: "k" }).model, DEFAULT_LLM_MODEL);
  assert.deepEqual(completionLimits("openai/gpt-oss-20b", 60), { max_completion_tokens: 400, reasoning_effort: "low" });
  assert.deepEqual(completionLimits("qualquer-outro", 60), { max_tokens: 60 });
});

test("pedido técnico pronto de cliente identificado: a IA abre a OS e diz o número", async () => {
  const pedidos = [];
  const serviceOrder = async (input) => { pedidos.push(input); return { status: "success", orderId: "301041", detail: "ok" }; };
  const { receber, textos, ticket } = await montar({ lookup: async () => ({ id: "21857" }), serviceOrder });
  await receber("estou sem internet");
  await receber("a luz LOS ta vermelha");
  await receber("de tarde");
  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].customerId, "21857");
  assert.equal(pedidos[0].intent, "technical_no_connection");
  assert.match(pedidos[0].summary, /LOS vermelha/);
  assert.match(textos()[2], /Abri a ordem de serviço nº 301041/);
  assert.equal(ticket().intake.serviceOrderId, "301041");
  assert.equal(ticket().intake.serviceOrderStatus, "success");
});

test("OS não abriu (IXC fora, bloqueio): a IA não fala em OS e o pedido fica registrado para a equipe", async () => {
  const serviceOrder = async () => ({ status: "failed", detail: "IXC fora" });
  const { receber, textos, ticket } = await montar({ lookup: async () => ({ id: "21857" }), serviceOrder });
  await receber("estou sem internet");
  await receber("a luz LOS ta vermelha");
  await receber("de tarde");
  assert.doesNotMatch(textos()[2], /ordem de serviço/);
  assert.match(textos()[2], /Seu pedido ficou registrado no protocolo/);
  assert.equal(ticket().intake.serviceOrderStatus, "failed");
});

test("desbloqueio de confiança: o modelo pede, o sistema decide e a mensagem diz o desfecho real", async () => {
  const pedidos = [];
  const trustUnlock = async (input) => { pedidos.push(input); return { status: "done", text: "Pronto: liberei sua internet em confiança enquanto o pagamento compensa." }; };
  const n8n = async (body) => /libera/i.test(body.question) ? { answer: "Vou verificar a liberação para você.", state: "ongoing", action: "trust_unlock", promised_date: "sexta" } : n8nPadrao(body);
  const { receber, textos } = await montar({ n8n, lookup: async () => ({ id: "21857" }), trustUnlock });
  await receber("oi");
  await receber("nao consigo pagar agora, libera minha internet que eu pago sexta");
  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].promisedDate, "sexta");
  assert.equal(pedidos[0].holderVerified, false, "o CPF ainda não foi conferido neste atendimento");
  assert.match(textos()[1], /Vou verificar a liberação/);
  assert.match(textos()[1], /liberei sua internet em confiança/);
});

test("desbloqueio sem CPF conferido: a IA pede o CPF e a próxima fala é tratada como o documento", async () => {
  const trustUnlock = async () => ({ status: "needs_cpf", text: "Para liberar, preciso confirmar o titular do contrato: me diga o CPF, só os números." });
  const n8n = async (body) => /libera/i.test(body.question) ? { answer: "Vou verificar.", state: "ongoing", action: "trust_unlock" } : n8nPadrao(body);
  const { receber, textos, ticket } = await montar({ n8n, lookup: async () => ({ id: "21857" }), trustUnlock });
  await receber("oi");
  await receber("libera minha internet por favor");
  assert.match(textos()[1], /me diga o CPF/);
  assert.equal(ticket().selfService.step, "awaiting_cpf");
});

test("número sem cadastro pede desbloqueio: a IA explica e o IXC nem é consultado", async () => {
  let chamadas = 0;
  const trustUnlock = async () => { chamadas++; return { status: "done", text: "x" }; };
  const n8n = async (body) => /libera/i.test(body.question) ? { answer: "Vou verificar.", state: "ongoing", action: "trust_unlock" } : n8nPadrao(body);
  const { receber, textos } = await montar({ n8n, trustUnlock });
  await receber("oi");
  await receber("libera minha internet por favor");
  assert.equal(chamadas, 0);
  assert.match(textos()[1], /não está no cadastro/);
});

test("depois do pedido registrado, 'ok' é despedida: não repete a ficha, não chama o modelo e a conversa fica na fila (caso 1289)", async () => {
  const { receber, textos, chamadasN8n, ticket, historico } = await montar();
  await receber("estou sem internet");
  await receber("a luz LOS ta vermelha");
  await receber("de tarde");
  const antes = chamadasN8n.length;
  await receber("Ok");
  assert.equal(chamadasN8n.length, antes, "despedida não vai ao modelo");
  assert.match(textos().at(-1), /Combinado/);
  assert.doesNotMatch(textos().at(-1), /protocolo/i);
  assert.equal(ticket().stage, "handoff");
  const rows = await historico();
  assert.equal(rows.at(-1).sentBy, AI_SENDER, "a despedida não tira o pedido da fila da equipe");
});

test("o modelo repetindo 'pedido pronto' não registra nem confirma de novo", async () => {
  const sempre = async () => ({ answer: "Entendi tudo, registrei de novo.", state: "request_complete", summary: "Assunto: sem internet" });
  const { receber, textos, ticket } = await montar({ n8n: sempre });
  await receber("estou sem internet");
  const intake = ticket().intake;
  await receber("mais uma coisa: ta sem internet ainda");
  assert.match(textos().at(-1), /Já está anotado/);
  assert.deepEqual(ticket().intake, intake);
});

test("assunto resolvido fecha o atendimento: a próxima fala abre outro, com protocolo novo", async () => {
  const resolve = async () => ({ answer: "Que bom que voltou! Qualquer coisa me chame.", state: "resolved" });
  const { receber, tickets } = await montar({ n8n: resolve });
  await receber("minha internet ta lenta");
  const primeiro = tickets.tickets[0];
  assert.equal(primeiro.status, "closed");
  assert.equal(primeiro.closedReason, "resolved");
  await receber("oi de novo");
  assert.notEqual(tickets.tickets.at(-1).id, primeiro.id);
});

test("a IA fala simples e se apresenta como suporte da BBNET", () => {
  const tarefa = agentTask("technical_no_connection");
  assert.match(tarefa, /frases curtas/);
  assert.match(tarefa, /caixinha da internet/);
  assert.match(agentTask("general_information"), /Aqui é o suporte da BBNET/);
});
