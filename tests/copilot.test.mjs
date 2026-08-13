import test from "node:test";
import assert from "node:assert/strict";
import {
  NOT_FOUND_ANSWER, REFUSAL_TOKEN, answerFromExcerpts, askCopilot, bestExcerpt,
  copilotLlmConfigFromEnv, findSources, intentTerms, lastQuestionFrom, meaningfulQuery,
  summarizeConversation, writeGroundedAnswer,
} from "../lib/platform/copilot-service.ts";

const doc = (over = {}) => ({
  id: "d1", title: "Lentidão em plano fibra", category: "Suporte", status: "published", version: 3,
  validUntil: null, updatedAt: "2026-08-01T10:00:00.000Z",
  content: "Antes de abrir chamado, peça teste cabeado.\n\nSe a lentidão aparecer no cabo, colete o resultado do teste e abra ordem de serviço com a evidência.",
  ...over,
});

test("sem documento na base o copiloto diz que não sabe", async () => {
  const answer = await askCopilot([], "como resolvo lentidão em plano fibra 300 mega?", undefined);
  assert.equal(answer.answer, NOT_FOUND_ANSWER);
  assert.equal(answer.written, "none");
  assert.deepEqual(answer.sources, []);
});

test("rascunho não é fonte — só documento publicado responde", async () => {
  const answer = await askCopilot([doc({ status: "draft" })], "lentidão no plano fibra", undefined);
  assert.equal(answer.written, "none", "publicar é o que autoriza a IA a citar");
});

test("documento que casou uma palavra solta não vira fonte", () => {
  // "teste" bate, o resto não. Citar isso responderia outra pergunta.
  const sources = findSources([doc()], "qual o prazo de instalação em zona rural sem viabilidade");
  assert.deepEqual(sources, []);
});

test("palavra de enchimento não pesa na busca", () => {
  // Medido na base real: "cliente sem conexão o que faço" citava o documento de
  // desbloqueio, que só compartilhava "cliente" e "sem".
  assert.equal(meaningfulQuery("cliente sem conexão o que faço"), "conexao");
  assert.equal(meaningfulQuery("o que eu faço com esse cliente"), "", "pergunta sem substantivo não é pesquisável");
});

test("pergunta feita só de palavra de enchimento vira 'não sei', não um palpite", async () => {
  const answer = await askCopilot([doc()], "o que eu faço com esse cliente", undefined);
  assert.equal(answer.written, "none");
});

test("a intenção classificada faz a ponte entre o jeito do cliente e o do documento", async () => {
  const procedimento = doc({ title: "Cliente sem conexão", content: "Confirme a luz do equipamento e cheque massiva na região antes de abrir OS." });
  // Como o cliente escreve de verdade: nenhuma palavra em comum com o documento.
  assert.deepEqual(findSources([procedimento], "oi, ta sem net aqui em casa desde ontem"), [], "só a mensagem não acha nada");
  const comIntencao = findSources([procedimento], "oi, ta sem net aqui em casa desde ontem", intentTerms("technical_no_connection"));
  assert.equal(comIntencao.length, 1, "a intenção já classificada acha o procedimento certo");
});

test("intenção desconhecida não vira termo de busca", () => {
  assert.equal(intentTerms("intencao_que_nao_existe"), "");
  assert.equal(intentTerms(undefined), "");
});

test("a resposta cita título e versão do documento", async () => {
  const answer = await askCopilot([doc()], "lentidão fibra teste cabeado", undefined);
  assert.equal(answer.written, "excerpt");
  assert.equal(answer.sources[0].title, "Lentidão em plano fibra");
  assert.equal(answer.sources[0].version, 3);
});

test("o trecho mostrado é o parágrafo que fala do assunto, não o documento inteiro", () => {
  const excerpt = bestExcerpt(doc().content, "ordem de serviço evidência");
  assert.match(excerpt, /ordem de servi/);
  assert.doesNotMatch(excerpt, /Antes de abrir chamado/, "o parágrafo irrelevante fica de fora");
});

test("trecho longo é cortado com reticências em vez de despejar o documento", () => {
  const excerpt = bestExcerpt("palavra ".repeat(200), "palavra");
  assert.ok(excerpt.length <= 421, excerpt.length);
  assert.match(excerpt, /…$/);
});

test("a flag do copiloto é independente da do classificador", () => {
  assert.equal(copilotLlmConfigFromEnv({ FEATURE_LLM_INTENT: "true", GROQ_API_KEY: "k" }), undefined);
  assert.equal(copilotLlmConfigFromEnv({ FEATURE_COPILOT_LLM: "true" }), undefined, "sem chave não há chamada");
  assert.equal(copilotLlmConfigFromEnv({ FEATURE_COPILOT_LLM: "true", GROQ_API_KEY: "k" })?.apiKey, "k");
});

const llm = (content) => ({
  apiKey: "k", model: "m", baseUrl: "https://exemplo",
  fetcher: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }),
});

test("o modelo redige a partir dos trechos, e os trechos continuam visíveis", async () => {
  const sources = findSources([doc()], "lentidão fibra teste cabeado");
  const answer = await writeGroundedAnswer("lentidão fibra", sources, llm("Peça o teste cabeado antes de abrir chamado."));
  assert.equal(answer.written, "llm");
  assert.match(answer.answer, /teste cabeado/);
  assert.equal(answer.sources.length, 1, "a fonte acompanha a resposta escrita — quem lê pode conferir");
  assert.match(answer.caveat, /Confira antes de usar/);
});

test("quando o modelo recusa, a resposta volta a ser o trecho — nunca texto inventado", async () => {
  const sources = findSources([doc()], "lentidão fibra teste cabeado");
  const answer = await writeGroundedAnswer("lentidão fibra", sources, llm(REFUSAL_TOKEN));
  assert.equal(answer.written, "excerpt");
});

test("falha do provedor não derruba o copiloto", async () => {
  const sources = findSources([doc()], "lentidão fibra teste cabeado");
  const quebrado = { apiKey: "k", model: "m", baseUrl: "https://exemplo", fetcher: async () => { throw new Error("rede"); } };
  const answer = await writeGroundedAnswer("lentidão fibra", sources, quebrado);
  assert.equal(answer.written, "excerpt");
});

test("sem fonte o modelo nem é chamado", async () => {
  let chamou = false;
  const config = { apiKey: "k", model: "m", baseUrl: "https://exemplo", fetcher: async () => { chamou = true; throw new Error("nao devia"); } };
  const answer = await askCopilot([doc()], "qual o prazo de instalação em zona rural sem viabilidade", config);
  assert.equal(chamou, false, "sem trecho na base não há o que embasar — perguntar ao modelo abriria a porta da invenção");
  assert.equal(answer.answer, NOT_FOUND_ANSWER);
});

test("resposta por trechos existe mesmo sem modelo nenhum", () => {
  const answer = answerFromExcerpts(findSources([doc()], "teste cabeado lentidão"));
  assert.equal(answer.written, "excerpt");
  assert.match(answer.caveat, /não reescreveu/);
});

const msg = (role, content, createdAt) => ({ role, content, createdAt });

test("a sugestão não responde à nota do CSAT", () => {
  // Conversa real de produção: a última fala do cliente era "1", a nota. A
  // primeira versão tentou responder a isso e devolveu "Escreva a pergunta".
  const conversa = [
    msg("customer", "oi", "2026-08-04T10:57:00.000Z"),
    msg("agent", "Ainda não tenho evidência suficiente…", "2026-08-04T10:57:10.000Z"),
    msg("customer", "quero a segunda via do boleto", "2026-08-04T10:57:20.000Z"),
    msg("agent", "…de 1 a 5, como você avalia este atendimento?", "2026-08-04T10:57:30.000Z"),
    msg("customer", "1", "2026-08-04T10:57:40.000Z"),
  ];
  assert.equal(lastQuestionFrom(conversa), "quero a segunda via do boleto");
});

test("saudação solta também não é a pergunta a responder", () => {
  assert.equal(lastQuestionFrom([msg("customer", "boleto vencido", ""), msg("customer", "oi", ""), msg("customer", "ok", "")]), "boleto vencido");
});

test("conversa sem nenhuma fala com conteúdo devolve nada, não um palpite", () => {
  assert.equal(lastQuestionFrom([msg("customer", "oi", ""), msg("customer", "5", "")]), undefined);
  assert.equal(lastQuestionFrom([msg("agent", "posso ajudar?", "")]), undefined, "resposta da IA não é pergunta do cliente");
});

test("resumo é montado dos fatos gravados", () => {
  const summary = summarizeConversation({
    externalConversationId: "5579998307232",
    messages: [
      msg("customer", "minha internet caiu ontem", "2026-08-10T12:00:00.000Z"),
      msg("suggestion", "resposta que ninguém enviou", "2026-08-10T12:01:00.000Z"),
      msg("customer", "e hoje continua sem nada", "2026-08-11T09:00:00.000Z"),
    ],
    outcome: { intent: "technical_no_connection", finalStatus: "handoff", handoff: true },
  });
  assert.match(summary, /3 mensagem\(ns\) entre 10\/08 e 11\/08/);
  assert.match(summary, /Cliente abriu com: "minha internet caiu ontem"/);
  assert.match(summary, /Última fala do cliente: "e hoje continua sem nada"/);
  assert.match(summary, /sem conexão/);
  assert.match(summary, /transbordou para humano/);
});

test("o resumo diz quando a IA não enviou nada ao cliente", () => {
  const summary = summarizeConversation({
    externalConversationId: "5579998307232",
    messages: [msg("customer", "oi", "2026-08-10T12:00:00.000Z"), msg("suggestion", "olá", "2026-08-10T12:01:00.000Z")],
  });
  // Sugestão parece resposta dada — é o engano mais provável de quem pega o caso.
  assert.match(summary, /não enviou nada ao cliente/);
  assert.match(summary, /Nenhum desfecho registrado/);
});

test("o resumo não carrega dado pessoal do texto do cliente", () => {
  const summary = summarizeConversation({
    externalConversationId: "5579998307232",
    messages: [msg("customer", "meu cpf é 123.456.789-09 e o email joao@exemplo.com", "2026-08-10T12:00:00.000Z")],
  });
  assert.doesNotMatch(summary, /123\.456\.789-09/);
  assert.doesNotMatch(summary, /joao@exemplo\.com/);
  // O identificador da conversa fica: sem ele o colega não acha o atendimento.
  assert.match(summary, /5579998307232/);
});

test("conversa sem mensagem não vira resumo inventado", () => {
  const summary = summarizeConversation({ externalConversationId: "55799", messages: [] });
  assert.match(summary, /não há o que resumir/);
});
