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
import { aiTrustUnlock } from "../lib/platform/ai-trust-unlock.ts";
import { MemoryIxcWriteOperationsRepository } from "../lib/platform/ixc-write-service.ts";
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
  // Como o modelo real segue o roteiro STYLE: cumprimento sem assunto ganha a apresentação do suporte, sem menu.
  if (/^(oi|ola|olá|bom dia|boa tarde|boa noite)\W*$/i.test(String(body.question).trim())) return "Olá! Aqui é o suporte da BBNET. Me conta o que está acontecendo?";
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

async function montar({ n8n = n8nPadrao, lookup = async () => undefined, identify, customerByDocument, diagnose, serviceOrder, trustUnlock, invoice, trustIdentity, trustPromptDelivered, trustSentAt, trustActionUnavailable, onTrustActionStage, offHours = false } = {}) {
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
    const triage = await startTriage(tickets, { channel: CHANNEL_NAME, conversationId: CLIENTE, lookup, identify, customerByDocument, diagnose, serviceOrder, trustUnlock, invoice, trustIdentity, trustPromptDelivered, trustInboundAt:trustSentAt ? trustSentAt(n) : new Date(Date.now() + n * 1000 - 500).toISOString(), now:Date.now() + n * 1000, offHours, agent: true });
    const auto = await metaAutoReplyOptions({
      enabled: true, states, messages: channel, claims, config: metaConfig, channel: CHANNEL_NAME,
      delivery: { begin: async () => "t", finish: async () => {}, settleUncertain: async () => {} },
      customerMessageAt: new Date().toISOString(), awaitingAnswer: triage?.awaitingAnswer,
      conversational: true,
    }, CLIENTE);
    return processChannelMessage(channel, { externalConversationId: CLIENTE, text, idempotencyKey: wamid, correlationId: `c-${wamid}` }, new MemorySupportMetricsRepository(), {
      ...auto, triage: triage?.hooks, trustActionUnavailable, onTrustActionStage,
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

test("fora do horário a IA atende sozinha: o roteiro diz que não há atendente e proíbe prometer um (25/11)", async () => {
  assert.doesNotMatch(agentTask("cancellation_risk"), /FORA DO HORÁRIO/, "no horário, o roteiro de sempre");
  const fora = agentTask("cancellation_risk", { offHours: true });
  assert.match(fora, /FORA DO HORÁRIO/);
  assert.match(fora, /Nunca diga que vai chamar, transferir ou passar para um atendente/);
  assert.match(fora, /request_complete/, "o que só a equipe executa continua registrado");
  const { receber, chamadasN8n } = await montar({ offHours: true });
  await receber("quero falar com um atendente");
  assert.equal(chamadasN8n[0].task, agentTask("human_handoff", { offHours: true }), "a instrução chega ao modelo");
  const { receber: noHorario, chamadasN8n: chamadas } = await montar({ offHours: false });
  await noHorario("quero falar com um atendente");
  assert.equal(chamadas[0].task, agentTask("human_handoff"), "no horário, pode passar ao atendente se precisar");
});

test("fala de liberação sem pedido claro: a IA pergunta direto, e o 'sim' seguinte pede a liberação", async () => {
  let attempts = 0;
  const f = await montar({
    lookup: async () => ({ id: "80" }),
    trustUnlock: async () => { attempts++; return { status: "needs_cpf", text: "Confirme o CPF do titular." }; },
    n8n: async () => ({ answer: "Vou verificar.", state: "ongoing", action: "trust_unlock" }),
  });
  await f.receber("e se eu pagar sexta, libera?");
  assert.equal(attempts, 0);
  assert.match(f.textos().at(-1), /você quer que eu peça a liberação da sua internet em confiança/);
  await f.receber("sim");
  assert.equal(attempts, 1, "o sim à pergunta é o pedido");
});

test("fora do horário, quem está na fila não fica sem resposta: protocolo e quando a equipe volta (25/11)", async () => {
  const visita = async (body) => /visita/.test(body.question) ? { answer: "Anotado.", state: "request_complete", summary: "Visita técnica\nMelhor período: tarde" } : n8nPadrao(body);
  const f = await montar({ lookup: async () => ({ id: "80" }), n8n: visita, offHours: true });
  await f.receber("quero agendar uma visita de tarde");
  assert.equal(f.ticket().stage, "handoff");
  const r = await f.receber("boa noite");
  assert.notEqual(r.status, "human_queue_held");
  assert.match(f.textos().at(-1), /^Boa noite! Seu atendimento está registrado no protocolo \d+, e a equipe da BBNET continua .+, por aqui\./);
  assert.equal((await f.historico()).at(-1).sentBy, AI_SENDER, "a conversa continua na fila para a equipe");
  await f.receber("pode liberar minha internet?");
  assert.match(f.textos().at(-1), /escreva "segunda via" que eu mando o PIX/);
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
  assert.doesNotMatch(textos()[1], /Vou verificar a liberação/);
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

test("a loja só entra no que é presencial, pelo endereço da base, nunca pelo telefone da loja", () => {
  for (const intent of ["technical_wifi", "general_information", "sales_inquiry"]) {
    const tarefa = agentTask(intent);
    assert.match(tarefa, /Só indique ir à loja para o que é presencial/, intent);
    assert.match(tarefa, /Nunca mande o cliente procurar a loja por telefone ou WhatsApp/, intent);
  }
});

test("confirma CPF só para desbloqueio e aguarda nova solicitação antes de atuar no único contrato bloqueado", async () => {
  const customerId = "80", blockedId = "207", reads = [], writes = [];
  const deps = {
    enabled:true, ledger:new MemoryIxcWriteOperationsRepository(), correlationId:"synthetic",
    provider:{
      async listTrustUnlockContracts(owner) {
        reads.push(["contracts",owner]);
        return Array.from({length:7},(_,i)=>({id:String(201+i),status:"A",internetStatus:i===6?"CA":"A"}));
      },
      async getTrustUnlockFacts(owner,contract) {
        reads.push(["facts",owner,contract]);
        return {contractId:contract,internetStatus:"CA",trustUnlockActive:false,lastUnlockAt:null,overdueCount:1,paidAfterUnlock:[]};
      },
    },
    unlock:async id=>{writes.push(id);return {raw:{type:"success"}};},
  };
  const n8n = async body => /libera/i.test(body.question) ? { answer:"Vou passar para um atendente.",state:"request_complete",summary:"Crie OS.",action:"trust_unlock" } : n8nPadrao(body);
  let serviceOrders = 0;
  const f = await montar({n8n,serviceOrder:async()=>{serviceOrders++;return undefined;},lookup:async()=>({id:customerId}),trustIdentity:async()=>({id:customerId}),trustPromptDelivered:async id=>id==="wamid.S3",trustUnlock:input=>aiTrustUnlock(deps,input),
    invoice:{sendData:false,lookup:{documentOf:async()=>"52998224725",openInvoices:async()=>{ throw Error("unexpected finance read"); }}}});
  const previous=process.env.FEATURE_IXC_WRITE;
  process.env.FEATURE_IXC_WRITE="true";
  try {
    await f.receber("oi");
    await f.receber("libera minha internet por favor");
    assert.equal(f.ticket().selfService.step,"awaiting_cpf");
    assert.deepEqual(reads,[]);
    await f.receber("52998224725");
    assert.equal(f.ticket().selfService.step,"verified");
    assert.deepEqual(writes,[]);
    assert.match(f.textos().at(-1),/Pode liberar minha internet/);
    assert.doesNotMatch(JSON.stringify(await f.historico()), /52998224725/);
    await f.receber("Pode liberar minha internet");
    assert.deepEqual(reads,[["contracts",customerId],["facts",customerId,blockedId]]);
    assert.deepEqual(writes,[blockedId]);
    assert.equal(serviceOrders,0);
    assert.doesNotMatch(f.textos().join(" "), /Vou passar para um atendente|Crie OS/);
  } finally {
    if (previous === undefined) delete process.env.FEATURE_IXC_WRITE;
    else process.env.FEATURE_IXC_WRITE=previous;
  }
});

test("a solicitação anterior ao comprovante, sem entrega ou com titular alterado não consulta nem libera contrato", async () => {
  for (const mode of ["old", "unconfirmed", "holder_changed"]) {
    let approved = false, owner = "80", reads = 0;
    const n8n = async body => /libera/i.test(body.question) ? { answer:"Vou conferir.",state:"ongoing",action:"trust_unlock" } : n8nPadrao(body);
    const f = await montar({ n8n, lookup:async()=>({id:"80"}), trustIdentity:async()=>({id:owner}),
      trustPromptDelivered:async()=>mode!=="unconfirmed", trustSentAt:n=>new Date(Date.now()+(mode==="old"&&n===4 ? 1000 : n*1000-500)).toISOString(),
      trustUnlock:async input=>{ if(input.holderVerified){approved=true;reads++;} return {status:"needs_cpf",text:"Confirme o titular."}; },
      invoice:{ sendData:false, lookup:{ documentOf:async()=>"52998224725", openInvoices:async()=>{throw Error("financial read");} } },
    });
    await f.receber("oi");
    await f.receber("libera minha internet por favor");
    await f.receber("52998224725");
    assert.equal(f.ticket().selfService.step,"verified");

    if(mode==="holder_changed")owner="81";
    await f.receber("Pode liberar minha internet");
    assert.equal(approved,false,mode);
    assert.equal(reads,0,mode);
    assert.doesNotMatch(f.textos().join(" "),/Já liberei/);
  }
});

test("falha de contexto da liberação tem motivo técnico fixo e não fala em recusa nem repete a data",async()=>{
  const sent=[];
  const n8n=async body=>/25\/11/.test(body.question)?{answer:"Pode confirmar a data exata mais uma vez?",state:"ongoing",action:"trust_unlock"}:n8nPadrao(body);
  const f=await montar({n8n,lookup:async()=>({id:"80"}), trustActionUnavailable:"sender_unverified", onTrustActionStage:stage=>sent.push(stage)});
  await f.receber("oi");
  await f.receber("Pode liberar minha internet? Pago 25/11");
  assert.deepEqual(sent,["sender_unverified"]);
  assert.match(f.textos().at(-1),/Não tenho uma confirmação do sistema/);
  assert.doesNotMatch(f.textos().at(-1),/recus|data exata|25\/11/);
});

test("roteiro de desbloqueio aceita intenção relativa sem transformar promessa em consentimento",()=>{
  for (const intent of ["financial_unlock","financial_payment"]) {
    const task=agentTask(intent);
    assert.match(task,/amanhã.*sexta.*outro dia/);
    assert.match(task,/campo é opcional/);
    assert.match(task,/Sem pedido explícito no contexto, não use a ação/);
    assert.doesNotMatch(task,/em que data vai pagar/);
  }
});

test("faixa protegida do fluxo técnico: ligada por padrão, desligável por chave", async () => {
  const { protectedLaneEnabled } = await import("../lib/platform/technical-conversation-pilot.ts");
  assert.equal(protectedLaneEnabled({}), true, "padrão: como antes");
  assert.equal(protectedLaneEnabled({ FEATURE_PROTECTED_TECHNICAL_LANE: "true" }), true);
  assert.equal(protectedLaneEnabled({ FEATURE_PROTECTED_TECHNICAL_LANE: "false" }), false);
  for (const desligado of ["false", "False", "FALSE", " false ", "\"false\"", "'false'", "0", "off", "no"]) assert.equal(protectedLaneEnabled({ FEATURE_PROTECTED_TECHNICAL_LANE: desligado }), false, `desliga com ${JSON.stringify(desligado)}`);
  for (const ligado of ["", "true", "abc", "1", undefined]) assert.equal(protectedLaneEnabled({ FEATURE_PROTECTED_TECHNICAL_LANE: ligado }), true, `mantém ligada com ${JSON.stringify(ligado)}`);
});


test("uma saudação nova não herda pedido de confiança anterior na conversa autônoma", async () => {
  let attempts = 0;
  const f = await montar({
    lookup: async () => ({id:"80"}),
    trustUnlock: async () => { attempts++; return {status:"needs_cpf",text:"Confirme o titular."}; },
    n8n: async () => ({answer:"Vou liberar.",state:"request_complete",action:"trust_unlock"}),
  });
  await f.receber("Pode liberar minha internet? Pago amanhã");
  const calls = f.chamadasN8n.length;
  assert.equal(attempts,1);
  await f.receber("boa noite");
  assert.equal(attempts,1);
  assert.equal(f.chamadasN8n.length,calls);
  assert.match(f.textos().at(-1),/^Boa noite!/);
  assert.doesNotMatch(f.textos().at(-1),/libera|CPF|protocolo/i);
  assert.equal(f.ticket().selfService.step,"awaiting_cpf");
});

test("um modelo que confunde resposta curta, recusa ou mudança de assunto não aciona liberação nem OS", async () => {
  let trust = 0, orders = 0;
  const f = await montar({
    lookup: async () => ({id:"80"}),
    trustUnlock: async () => { trust++; return {status:"done",text:"liberado"}; },
    serviceOrder: async () => { orders++; return {status:"success",orderId:"42"}; },
    n8n: async input => /lentidao/.test(input.question) ? {answer:"A luz da caixinha está vermelha?",state:"ongoing"} : {answer:"Vou verificar a liberação.",state:"request_complete",summary:"abrir ordem",action:"trust_unlock"},
  });
  await f.receber("estou com lentidao na minha internet");
  for (const message of ["sim", "não quero liberar minha internet", "na verdade quero saber meu plano", "amanhã", "como funciona o desbloqueio por confiança"]) {
    await f.receber(message);
    assert.doesNotMatch(f.textos().at(-1),/Liberei|agendei|Vou verificar a liberação|Não tenho uma confirmação do sistema/);
  }
  assert.ok(f.textos().some(text => /Só para confirmar/.test(text)), "a proposta sem respaldo deve ser descartada");
  assert.equal(trust,0);
  assert.equal(orders,0);
});

test("fila humana: recebe a saudação e a solicitação sem reenviar fallback de liberação nem autorizar ação", async () => {
  let trust = 0;
  const f = await montar({
    n8n: async input => /liberar/.test(input.question) ? { answer:"Vou liberar.",state:"request_complete",action:"trust_unlock" } : n8nPadrao(input),
    trustUnlock: async () => { trust++; return {status:"done",text:"liberado"}; },
  });
  await f.receber("como troco a senha do wifi");
  assert.equal(f.ticket().stage,"handoff");
  const sends = f.textos().length;
  for (const message of ["boa noite", "Pode liberar minha internet?"]) {
    const r = await f.receber(message);
    assert.equal(r.status,"human_queue_held");
    assert.equal(r.response,null);
    assert.equal((await f.historico()).at(-1).content,message);
  }
  assert.equal(f.textos().length,sends);
  assert.equal(trust,0);
  assert.equal(f.ticket().stage,"handoff");
});

test("número em mais de um cadastro: a IA pede o CPF e abre a OS no cadastro do CPF (conversa da Estefany, 27/11)", async () => {
  const pedidos = [];
  const serviceOrder = async (input) => { pedidos.push(input); return { status: "success", orderId: "301500", detail: "ok" }; };
  const consultas = [];
  const customerByDocument = async (document, phone) => { consultas.push([document, phone]); return { id: "13909", phoneMatches: true }; };
  const { receber, textos, ticket, historico } = await montar({ identify: async () => ({ ambiguous: true }), customerByDocument, serviceOrder });
  await receber("estou sem internet");
  assert.equal(ticket().identification, "ambiguous");
  await receber("a luz LOS ta vermelha");
  await receber("de tarde");
  assert.equal(pedidos.length, 0, "sem cadastro certo ainda não abre");
  assert.match(textos()[2], /me diga o CPF/);
  assert.equal(ticket().intake.serviceOrderStatus, "awaiting_cpf");
  await receber("529.982.247-25");
  assert.deepEqual(consultas[0], ["52998224725", CLIENTE]);
  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].customerId, "13909");
  assert.match(textos()[3], /Abri a ordem de serviço nº 301500/);
  assert.equal(ticket().identification, "identified", "CPF e telefone do mesmo cadastro");
  assert.equal(ticket().intake.serviceOrderId, "301500");
  assert.ok((await historico()).some((row) => row.content === "[documento omitido]"), "o CPF não fica no histórico");
});

test("número fora do IXC: o CPF acha o cadastro e a OS sai, mas a identificação vale só para a OS", async () => {
  const pedidos = [];
  const serviceOrder = async (input) => { pedidos.push(input); return { status: "success", orderId: "301501", detail: "ok" }; };
  const { receber, textos, ticket } = await montar({ identify: async () => undefined, customerByDocument: async () => ({ id: "555", phoneMatches: false }), serviceOrder });
  await receber("estou sem internet");
  await receber("a luz LOS ta vermelha");
  await receber("de tarde");
  await receber("52998224725");
  assert.equal(pedidos[0]?.customerId, "555");
  assert.match(textos()[3], /Abri a ordem de serviço nº 301501/);
  assert.equal(ticket().identification, "cpf_only");
});

test("CPF sem cadastro: a IA diz que a equipe abre a OS e o motivo fica na ficha", async () => {
  const serviceOrder = async () => { throw new Error("não devia abrir"); };
  const { receber, textos, ticket } = await montar({ identify: async () => ({ ambiguous: true }), customerByDocument: async () => undefined, serviceOrder });
  await receber("estou sem internet");
  await receber("a luz LOS ta vermelha");
  await receber("de tarde");
  await receber("52998224725");
  assert.match(textos()[3], /Não encontrei cadastro com esse documento/);
  assert.equal(ticket().intake.serviceOrderStatus, "skipped");
  assert.match(ticket().intake.serviceOrderDetail, /Nenhum cadastro/);
});

test("pedido técnico já registrado: \"vai vir amanhã?\" ganha o próximo passo, não só \"já está anotado\"", async () => {
  const n8n = async (body) => /amanh/i.test(body.question) ? { answer: "Certo.", state: "request_complete", summary: "de novo" } : n8nPadrao(body);
  const { receber, textos } = await montar({ n8n, lookup: async () => ({ id: "21857" }) });
  await receber("estou sem internet");
  await receber("a luz LOS ta vermelha");
  await receber("de tarde");
  await receber("vai vir amanhã de manhã?");
  assert.match(textos()[3], /O técnico entra em contato antes de ir/);
});

test("dois endereços: a IA pergunta em qual é o problema e abre a OS no escolhido", async () => {
  const pedidos = [];
  const options = [{ contractId: "36058", label: "Rua A, 10 - Centro" }, { contractId: "48901", label: "Rua B, 20 - Centro" }];
  const serviceOrder = async (input) => { pedidos.push(input); return input.contractId ? { status: "success", orderId: "301600", detail: "ok" } : { status: "choose", detail: "2 contratos", options }; };
  const { receber, textos, ticket } = await montar({ lookup: async () => ({ id: "21857" }), serviceOrder });
  await receber("estou sem internet");
  await receber("a luz LOS ta vermelha");
  await receber("de tarde");
  assert.equal(pedidos[0].allowChoice, true, "titular pelo telefone: pode ver os próprios endereços");
  assert.match(textos()[2], /mais de um endereço/);
  assert.match(textos()[2], /1\. Rua A, 10 - Centro\n2\. Rua B, 20 - Centro/);
  assert.equal(ticket().intake.serviceOrderStatus, "awaiting_choice");
  await receber("2");
  assert.equal(pedidos[1].contractId, "48901");
  assert.match(textos()[3], /Certo, Rua B, 20 - Centro\. Abri a ordem de serviço nº 301600/);
});

test("identificado só pelo CPF: a IA não lista endereços para o número", async () => {
  const pedidos = [];
  const serviceOrder = async (input) => { pedidos.push(input); return { status: "blocked", detail: "2 contratos" }; };
  const { receber } = await montar({ identify: async () => undefined, customerByDocument: async () => ({ id: "555", phoneMatches: false }), serviceOrder });
  await receber("estou sem internet");
  await receber("a luz LOS ta vermelha");
  await receber("de tarde");
  await receber("52998224725");
  assert.equal(pedidos[0].allowChoice, false);
});
