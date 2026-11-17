import { sanitizeHandoffText } from "../agent/handoff.ts";
import type { ChatMessage, Intent } from "../agent/types.ts";
import { MAX_SOURCES, findSources, intentTerms, type CopilotSource } from "./copilot-service.ts";
import type { KnowledgeDoc } from "./knowledge-service.ts";
import { containsHomologationText } from "./reply-templates-shared.ts";

/**
 * Robô de dúvidas (n8n) — no horário comercial, só dúvida.
 *
 * O LZR continua sendo quem recebe o WhatsApp, decide, confere e envia. O n8n
 * recebe a pergunta e os trechos da base de conhecimento e **devolve um texto**;
 * não tem acesso ao WhatsApp nem ao IXC. Assim ele não consegue abrir OS,
 * renegociar dívida nem falar duas vezes com o cliente: tudo que tem efeito no
 * mundo continua nos fluxos do LZR, com login, idempotência e auditoria.
 *
 * Só chega aqui o que o classificador chamou de dúvida (`DOUBT_INTENTS`).
 * Fatura, bloqueio, sem internet e cancelamento seguem os fluxos de sempre.
 *
 * Fail-closed em quatro camadas, todas caindo na sugestão ao atendente:
 * sem a flag ou sem URL/segredo não há chamada; sem trecho na base não há
 * chamada (não se pergunta a um modelo o que a base não sustenta); n8n lento
 * ou fora do ar não segura o webhook; e o texto devolvido é conferido antes de
 * sair — o n8n é editável por mais gente que o código, então não é confiável.
 */

export const DOUBT_BOT_TIMEOUT_MS = 7000;
export const DOUBT_BOT_MAX_ANSWER = 900;
/** Teto por documento enviado ao n8n: os da base inicial têm até ~1.500 caracteres. */
export const BOT_SOURCE_LIMIT = 1800;
/** O n8n devolve isto quando os trechos não respondem. Vira "não sei" — o atendente assume. */
export const DOUBT_BOT_REFUSAL = "NAO_SEI";

/** Assuntos que não dizem nada sobre o que buscar. */
const VAGUE_INTENTS: ReadonlySet<string> = new Set(["general_information", "out_of_scope"]);

export interface DoubtBotConfig { url: string; secret: string; fetcher?: typeof fetch; timeoutMs?: number }

/**
 * Liga com `FEATURE_N8N_BOT` (dúvidas no horário comercial) ou `FEATURE_AI_AGENT` (modo
 * autônomo), mais `N8N_BOT_URL` (https) e `N8N_BOT_SECRET`. Faltou qualquer um: desligado.
 */
export function doubtBotConfigFromEnv(env: Record<string, string | undefined> = process.env): DoubtBotConfig | undefined {
  if (env.FEATURE_N8N_BOT !== "true" && env.FEATURE_AI_AGENT !== "true") return undefined;
  const url = env.N8N_BOT_URL?.trim();
  const secret = env.N8N_BOT_SECRET?.trim();
  if (!url || !secret || secret.length < 24) return undefined;
  try { if (new URL(url).protocol !== "https:") return undefined; } catch { return undefined; }
  return { url, secret };
}

/**
 * Tudo que o texto devolvido não pode conter. A lista de "ação já feita" é
 * propositalmente larga: errar para o lado de sugerir ao atendente custa um
 * clique; errar para o outro, o cliente acredita que algo foi feito e não foi.
 */
const ACTION_CLAIM = /\b(já|acabei de|foi|foram)\s+(abri|abriu|aberto|aberta|gerei|gerou|gerado|gerada|enviei|enviou|enviado|enviada|cancelei|cancelou|cancelado|cancelada|desbloqueei|desbloqueou|desbloqueado|agendei|agendou|agendado|agendada|registrei|registrou|criei|criou|criado|criada|alterei|alterou|alterado|alterada|renegociei|renegociou|renegociado|renegociada|liberei|liberou|liberado|liberada)\b|\b(abri|gerei|enviei|cancelei|desbloqueei|agendei|criei|renegociei|liberei)\s+(o|a|um|uma|seu|sua|os|as)\b/i;

export type BotAnswerCheck = { ok: true; text: string } | { ok: false; reason: string };

export function checkBotAnswer(raw: unknown): BotAnswerCheck {
  if (typeof raw !== "string") return { ok: false, reason: "O n8n não devolveu texto." };
  const text = raw.trim();
  if (!text) return { ok: false, reason: "O n8n devolveu texto vazio." };
  if (text.includes(DOUBT_BOT_REFUSAL)) return { ok: false, reason: "O n8n disse que a base não responde." };
  if (text.length > DOUBT_BOT_MAX_ANSWER) return { ok: false, reason: `O texto passa de ${DOUBT_BOT_MAX_ANSWER} caracteres.` };
  if (containsHomologationText(text)) return { ok: false, reason: "O texto menciona homologação, simulação ou dado fictício." };
  if (sanitizeHandoffText(text) !== text) return { ok: false, reason: "O texto traz e-mail, CPF ou telefone." };
  if (/https?:\/\/|www\./i.test(text)) return { ok: false, reason: "O texto traz link; a base não é lida por link no robô." };
  if (ACTION_CLAIM.test(text)) return { ok: false, reason: "O texto afirma uma ação já executada, que o robô não executa." };
  return { ok: true, text };
}

export interface DoubtBotInput {
  question: string;
  intent: Intent;
  /** Últimas falas do atendimento, já sem o que o cliente nunca viu (sugestões). */
  history: ChatMessage[];
}

export type DoubtBotResult =
  | { kind: "answer"; text: string; sources: string[] }
  | { kind: "none" }
  | { kind: "failed"; reason: string };

const publishedAndValid = (documents: KnowledgeDoc[], now: number) =>
  documents.filter((document) => document.status === "published" && (!document.validUntil || !(Date.parse(document.validUntil) < now)));

/** A chamada ao n8n. Nunca lança: qualquer falha vira `failed`, e o canal segue como se o robô não existisse. */
export async function askDoubtBot(config: DoubtBotConfig, input: DoubtBotInput, sources: CopilotSource[]): Promise<DoubtBotResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DOUBT_BOT_TIMEOUT_MS);
  try {
    const response = await (config.fetcher ?? fetch)(config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.secret}`, "Content-Type": "application/json" },
      // Sanitizado mesmo sendo o cliente falando: o n8n e o provedor do modelo não precisam de CPF, e-mail ou telefone para responder uma dúvida.
      body: JSON.stringify({
        intent: input.intent,
        question: sanitizeHandoffText(input.question).slice(0, 600),
        history: input.history.map((turn) => ({ role: turn.role === "agent" ? "assistant" : "customer", text: sanitizeHandoffText(turn.content).slice(0, 400) })),
        sources: sources.slice(0, MAX_SOURCES).map((source) => ({ title: source.title, excerpt: source.excerpt })),
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { kind: "failed", reason: `O n8n respondeu HTTP ${response.status}.` };
    const body = await response.json().catch(() => undefined) as { answer?: unknown; text?: unknown } | undefined;
    const checked = checkBotAnswer(body?.answer ?? body?.text);
    // Recusa do modelo não é falha: é o robô dizendo que não sabe, e o atendente assume.
    if (!checked.ok) return checked.reason.startsWith("O n8n disse que a base") ? { kind: "none" } : { kind: "failed", reason: checked.reason };
    return { kind: "answer", text: checked.text, sources: sources.map((source) => source.title) };
  } catch (error) {
    return { kind: "failed", reason: (error as Error)?.name === "AbortError" ? "O n8n demorou demais para responder." : "Não consegui falar com o n8n." };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Quem o canal chama. Busca nos documentos publicados e vigentes; **sem trecho
 * não chama o n8n** — o robô só responde o que a base sustenta.
 */
export function doubtBotAnswerer(config: DoubtBotConfig, loadDocuments: () => Promise<KnowledgeDoc[]>, now: () => number = Date.now) {
  return async (input: DoubtBotInput): Promise<DoubtBotResult> => {
    let documents: KnowledgeDoc[];
    try { documents = publishedAndValid(await loadDocuments(), now()); } catch { return { kind: "failed", reason: "A base de conhecimento não respondeu." }; }
    // O assunto já entendido busca em separado: o cliente escreve "ta sem net", o documento diz "sem conexão".
    // "Informação geral" não é assunto: buscar por ela casava todo documento da categoria "Geral" (a
    // padrão da tela) e mandava trechos aleatórios a quem só disse "alô? alguém?".
    const hint = VAGUE_INTENTS.has(input.intent) ? "" : intentTerms(input.intent);
    const sources = findSources(documents, input.question, hint);
    if (sources.length === 0) return { kind: "none" };
    // O robô recebe o documento inteiro, não só o parágrafo que casou: medido em 17/11, com um
    // parágrafo só ele repetia o primeiro passo ("veja se acontece em todos os aparelhos") a quem
    // já tinha reiniciado, porque nunca via o passo seguinte nem o "se não voltar, um atendente".
    const byId = new Map(documents.map((document) => [document.id, document]));
    const whole = sources.map((source) => ({ ...source, excerpt: (byId.get(source.id)?.content ?? source.excerpt).slice(0, BOT_SOURCE_LIMIT) }));
    return askDoubtBot(config, input, whole);
  };
}
