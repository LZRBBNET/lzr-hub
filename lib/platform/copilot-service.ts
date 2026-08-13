import { sanitizeHandoffText } from "../agent/handoff.ts";
import { searchDocuments, type KnowledgeDoc } from "./knowledge-service.ts";

/**
 * Copiloto do atendente (issue #11).
 *
 * A IA que atende o cliente e a IA que ajuda o atendente são coisas diferentes,
 * e é por isso que este arquivo existe em vez de reaproveitar `runAgentPipeline`.
 *
 * ⚠️ O pipeline escreve texto de **homologação**: "no ambiente de homologação,
 * preparei a segunda via fictícia". Oferecer isso ao atendente como "resposta
 * pronta para enviar" entregaria a palavra *fictícia* a um cliente real. Então o
 * copiloto não usa aquelas frases — ele responde a partir da base de
 * conhecimento e cita de onde tirou.
 *
 * A regra que sustenta o resto: **sem trecho na base, o copiloto diz que não
 * sabe.** Um copiloto que inventa procedimento é pior que um que se cala, porque
 * o atendente repassa ao cliente com a autoridade da empresa.
 */

/** Abaixo disto o documento casou uma palavra solta de uma pergunta longa — citar seria pior que calar. */
export const MIN_SCORE = 0.4;
export const MAX_SOURCES = 3;
export const EXCERPT_LIMIT = 420;
export const COPILOT_TIMEOUT_MS = 6000;

export const NOT_FOUND_ANSWER =
  "Não encontrei nada na base de conhecimento sobre isso. Prefiro dizer que não sei a inventar um procedimento. " +
  "Se você resolver esse caso, registre o que funcionou em Conhecimento — da próxima vez a resposta existe.";

export const LLM_CAVEAT = "Texto escrito pela IA a partir dos trechos citados abaixo. Confira antes de usar com o cliente.";
export const EXCERPT_CAVEAT = "Trechos da base, no texto original. A IA não reescreveu nada aqui.";

export interface CopilotSource { id: string; title: string; category: string; version: number; excerpt: string; score: number }
export interface CopilotAnswer { answer: string; written: "llm" | "excerpt" | "none"; caveat: string | null; sources: CopilotSource[] }

const normalize = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const terms = (query: string) => normalize(query).split(/\s+/).filter((term) => term.length > 2);

/**
 * Palavras que aparecem em quase todo documento e por isso não distinguem nada.
 *
 * Medido na base real: "cliente sem conexão o que faço" casava 0,4 no documento
 * de *desbloqueio por confiança* — só porque ele também diz "cliente" e "sem".
 * Uma fonte errada citada com autoridade é pior que nenhuma fonte.
 */
const STOPWORDS = new Set([
  "cliente", "clientes", "sem", "que", "qual", "quais", "com", "para", "por", "dos", "das", "nos", "nas",
  "como", "uma", "uns", "umas", "nao", "mais", "meu", "minha", "sobre", "esse", "essa", "isso", "aqui",
  "fazer", "faco", "faz", "tem", "ter", "quando", "onde", "porque", "pode", "posso", "preciso", "quero",
]);

/**
 * A pergunta sem as palavras de enchimento. Vazio de propósito quando sobra
 * nada: "o que eu faço com esse cliente" não é uma pergunta pesquisável, e
 * responder algo a ela seria chutar.
 */
export function meaningfulQuery(question: string): string {
  return terms(question).filter((term) => !STOPWORDS.has(term)).join(" ");
}

/**
 * O pedaço do documento que fala do que foi perguntado. Mostrar o documento
 * inteiro faria o atendente procurar de novo — e o que ele não lê, ele não
 * confere.
 */
export function bestExcerpt(content: string, query: string): string {
  const wanted = terms(query);
  const blocks = content.split(/\n\s*\n|\r\n\s*\r\n/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length === 0) return content.slice(0, EXCERPT_LIMIT).trim();
  const scored = blocks.map((block) => {
    const haystack = normalize(block);
    return { block, hits: wanted.filter((term) => haystack.includes(term)).length };
  });
  const best = scored.reduce((a, b) => (b.hits > a.hits ? b : a));
  // Nenhum parágrafo casou termo: o começo do documento é a melhor aposta neutra.
  const chosen = best.hits > 0 ? best.block : blocks[0];
  return chosen.length > EXCERPT_LIMIT ? `${chosen.slice(0, EXCERPT_LIMIT).trimEnd()}…` : chosen;
}

/** Documentos publicados que sustentam a pergunta. Vazio significa "não sei", não "responda mesmo assim". */
/**
 * Documentos publicados que sustentam a pergunta. Vazio significa "não sei", não
 * "responda mesmo assim".
 *
 * `intentHint` existe por um problema medido: o cliente escreve "ta sem net" e o
 * documento se chama "cliente sem conexão" — nenhuma palavra em comum, e a busca
 * por termo devolve nada. A intenção já classificada (pelo modelo, quando ligado)
 * é justamente a tradução entre as duas linguagens, então ela vira uma **busca
 * separada**, não termos somados à primeira: somados, eles só aumentariam o
 * divisor da pontuação e afundariam o documento certo.
 */
export function findSources(documents: KnowledgeDoc[], question: string, intentHint = ""): CopilotSource[] {
  const query = meaningfulQuery(question);
  const hint = meaningfulQuery(intentHint);
  if (!query && !hint) return [];
  const best = new Map<string, { hit: ReturnType<typeof searchDocuments>[number]; score: number }>();
  for (const source of [query, hint].filter(Boolean)) {
    for (const hit of searchDocuments(documents, source)) {
      const current = best.get(hit.document.id);
      if (!current || hit.score > current.score) best.set(hit.document.id, { hit, score: hit.score });
    }
  }
  return [...best.values()]
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SOURCES)
    .map(({ hit, score }) => ({
      id: hit.document.id, title: hit.document.title, category: hit.document.category,
      version: hit.document.version, score: Number(score.toFixed(2)),
      excerpt: bestExcerpt(hit.document.content, `${query} ${hint}`.trim()),
    }));
}

/** Resposta sem modelo de linguagem: os trechos, como estão escritos. Já é útil. */
export function answerFromExcerpts(sources: CopilotSource[]): CopilotAnswer {
  if (sources.length === 0) return { answer: NOT_FOUND_ANSWER, written: "none", caveat: null, sources: [] };
  return { answer: sources.map((source) => source.excerpt).join("\n\n"), written: "excerpt", caveat: EXCERPT_CAVEAT, sources };
}

/**
 * Configuração do redator. Flag própria, e não a do classificador de intenção:
 * o que sai daqui é diferente — vão trechos de procedimento interno, não a frase
 * do cliente. Consentir com um não é consentir com o outro.
 *
 * Sem a flag ou sem chave, o copiloto continua funcionando com os trechos.
 */
export interface CopilotLlmConfig { apiKey: string; model: string; baseUrl: string; fetcher?: typeof fetch }

export function copilotLlmConfigFromEnv(env: Record<string, string | undefined> = process.env): CopilotLlmConfig | undefined {
  if (env.FEATURE_COPILOT_LLM !== "true") return undefined;
  const apiKey = env.GROQ_API_KEY?.trim();
  if (!apiKey) return undefined;
  return {
    apiKey,
    model: env.LLM_MODEL?.trim() || "llama-3.3-70b-versatile",
    baseUrl: env.LLM_BASE_URL?.trim() || "https://api.groq.com/openai/v1",
  };
}

/** O modelo devolve isto quando os trechos não respondem. Vira "não sei" em vez de virar invenção. */
export const REFUSAL_TOKEN = "NAO_SEI";

const WRITER_PROMPT = `Você ajuda um ATENDENTE de um provedor de internet brasileiro. Quem lê é funcionário, não cliente.

Responda usando SOMENTE os trechos fornecidos. Eles são a única fonte permitida.

Regras absolutas:
- Se os trechos não responderem à pergunta, responda exatamente: ${REFUSAL_TOKEN}
- Nunca invente valor, prazo, número de telefone, endereço ou procedimento que não esteja nos trechos.
- Não prometa ação executada. Você não executa nada.
- Português do Brasil, no máximo 120 palavras, direto ao ponto.
- Não cite "trecho 1"/"documento": o atendente já vê as fontes na tela.`;

/**
 * Reescreve os trechos como resposta. Nunca lança: qualquer falha vira a
 * resposta por trechos, que é o comportamento sem a flag.
 *
 * A pergunta sai **sanitizada** — o atendente pode colar a fala do cliente com
 * CPF dentro, e o provedor do modelo não precisa disso para responder.
 */
export async function writeGroundedAnswer(
  question: string,
  sources: CopilotSource[],
  config: CopilotLlmConfig | undefined,
  timeoutMs = COPILOT_TIMEOUT_MS,
): Promise<CopilotAnswer> {
  const fallback = answerFromExcerpts(sources);
  if (!config || sources.length === 0) return fallback;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const context = sources.map((source) => `[${source.title}]\n${source.excerpt}`).join("\n\n");
    const response = await (config.fetcher ?? fetch)(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model, temperature: 0.2, max_tokens: 320,
        messages: [
          { role: "system", content: WRITER_PROMPT },
          { role: "user", content: `Trechos da base:\n\n${context}\n\nPergunta do atendente: ${sanitizeHandoffText(question).slice(0, 600)}` },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return fallback;
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = (body.choices?.[0]?.message?.content ?? "").trim();
    // Recusa do modelo ou resposta vazia: mostra os trechos, não force uma resposta.
    if (!text || text.includes(REFUSAL_TOKEN)) return fallback;
    return { answer: text, written: "llm", caveat: LLM_CAVEAT, sources };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

export async function askCopilot(
  documents: KnowledgeDoc[],
  question: string,
  config: CopilotLlmConfig | undefined,
  intentHint = "",
): Promise<CopilotAnswer> {
  const sources = findSources(documents, question, intentHint);
  if (sources.length === 0) return answerFromExcerpts([]);
  return writeGroundedAnswer(question, sources, config);
}

const INTENT_PT: Record<string, string> = {
  technical_no_connection: "sem conexão", technical_slow: "lentidão", technical_wifi: "Wi-Fi",
  technical_restart: "reinício de equipamento", technical_ticket: "abertura de chamado", technical_visit: "visita técnica",
  financial_invoice: "fatura / segunda via", financial_pix: "PIX", financial_payment: "pagamento",
  financial_unlock: "desbloqueio", financial_discount_request: "pedido de desconto", complaint: "reclamação",
  cancellation_risk: "risco de cancelamento", human_handoff: "pedido de atendente",
  unauthorized_request: "pedido não autorizado", out_of_scope: "fora de escopo", general_information: "informação geral",
};

/**
 * A fala do cliente que a sugestão deve responder.
 *
 * Não é simplesmente a última: depois do atendimento ela costuma ser a **nota do
 * CSAT** ("1", "5") ou uma saudação solta ("oi", "ok"). Responder a "1" com
 * procedimento é responder a coisa nenhuma — e foi o que aconteceu na primeira
 * versão, numa conversa real de produção. Anda para trás até achar conteúdo.
 */
export function lastQuestionFrom(messages: Array<{ role: string; content: string }>): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "customer") continue;
    const text = message.content.trim();
    if (text.length < 3) continue;
    if (/^\d+$/.test(text)) continue;
    return text;
  }
  return undefined;
}

/** Rótulo em português da intenção classificada — é ele que vira termo de busca. */
export const intentTerms = (intent: string | undefined) => (intent ? INTENT_PT[intent] ?? "" : "");

export interface SummaryMessage { role: "customer" | "agent" | "suggestion"; content: string; createdAt: string }
export interface SummaryInput {
  externalConversationId: string;
  messages: SummaryMessage[];
  outcome?: { intent: string; finalStatus: string; handoff: boolean } | undefined;
}

const day = (iso: string) => {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? "?" : parsed.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
};
const quote = (text: string) => `"${sanitizeHandoffText(text).replace(/\s+/g, " ").trim().slice(0, 220)}"`;

/**
 * Resumo para passar o caso a um colega. É montado dos fatos gravados — contagem,
 * primeira e última fala, desfecho registrado — e não escrito por modelo nenhum.
 * Resumo é o que um colega vai ler antes de falar com o cliente; um parágrafo
 * bonito e errado aqui custa mais caro que uma lista seca e certa.
 *
 * O texto das mensagens passa pela sanitização (e-mail, CPF, telefone). O
 * identificador da conversa **fica**: é a chave para achar o atendimento, e o
 * colega que recebe o caso já o vê na tela — apagá-lo tornaria o resumo inútil.
 */
export function summarizeConversation(input: SummaryInput): string {
  const { messages } = input;
  if (messages.length === 0) return `Atendimento ${input.externalConversationId} não tem mensagem gravada — não há o que resumir.`;

  const fromCustomer = messages.filter((message) => message.role === "customer");
  const delivered = messages.filter((message) => message.role === "agent");
  const suggested = messages.filter((message) => message.role === "suggestion");
  const lines = [
    `Atendimento ${input.externalConversationId} — ${messages.length} mensagem(ns) entre ${day(messages[0].createdAt)} e ${day(messages[messages.length - 1].createdAt)}.`,
  ];
  if (fromCustomer.length > 0) {
    lines.push(`Cliente abriu com: ${quote(fromCustomer[0].content)}`);
    if (fromCustomer.length > 1) lines.push(`Última fala do cliente: ${quote(fromCustomer[fromCustomer.length - 1].content)}`);
  } else {
    lines.push("Nenhuma mensagem do cliente neste histórico.");
  }
  lines.push(input.outcome
    ? `Intenção classificada: ${INTENT_PT[input.outcome.intent] ?? input.outcome.intent}. Desfecho: ${input.outcome.finalStatus}${input.outcome.handoff ? " (transbordou para humano)" : ""}.`
    : "Nenhum desfecho registrado para esta conversa.");
  // A distinção que mais engana quem pega o caso: sugestão parece resposta dada.
  lines.push(delivered.length > 0
    ? `A IA enviou ${delivered.length} resposta(s) ao cliente.`
    : suggested.length > 0
      ? `A IA não enviou nada ao cliente: ${suggested.length} resposta(s) ficaram apenas sugeridas (modo observação).`
      : "A IA não respondeu nesta conversa.");
  return lines.join("\n");
}
