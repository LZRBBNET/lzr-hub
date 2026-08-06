import { analyzeIntent } from "./pipeline.ts";
import { sanitizeHandoffText } from "./handoff.ts";
import type { Intent } from "./types.ts";

/**
 * Classificação de intenção por modelo de linguagem.
 *
 * Por que só a **classificação**, e não a resposta ao cliente:
 *
 * O problema medido é a classificação. As expressões regulares acertam quem
 * escreve como a regra espera e erram todo o resto — 11 das 13 conversas reais
 * transbordaram porque nenhuma regra casou. A resposta, ao contrário, já
 * funciona e carrega garantias que custaram caro: nunca afirma ação não
 * executada, exige evidência, transborda quando não sabe. Um modelo escrevendo
 * texto livre para o cliente jogaria fora essas garantias de uma vez.
 *
 * Então o modelo escolhe **um item de uma lista fechada** e o resto do pipeline
 * continua igual. A saída é um enum, não prosa: fácil de validar, impossível de
 * virar promessa ao cliente.
 *
 * Fail-closed em três camadas: sem chave não há chamada; erro ou demora cai na
 * regex; resposta fora da lista é descartada. Em nenhum caso o atendimento para.
 */
export const LLM_TIMEOUT_MS = 4000;

/** A lista fechada que o modelo pode devolver. Qualquer outra coisa é descartada. */
export const INTENTS: Intent[] = [
  "technical_no_connection", "technical_slow", "technical_wifi", "technical_restart",
  "technical_ticket", "technical_visit", "financial_invoice", "financial_pix",
  "financial_payment", "financial_unlock", "financial_discount_request", "complaint", "cancellation_risk",
  "human_handoff", "unauthorized_request", "out_of_scope", "general_information",
];

const SYSTEM_PROMPT = `Você classifica mensagens de clientes de um provedor de internet brasileiro (ISP).

Responda APENAS com um objeto JSON: {"intent":"<valor>","confidence":<0 a 1>}

Valores permitidos para intent:
${INTENTS.join("\n")}

Regras:
- technical_no_connection: sem internet, caiu, não conecta, offline.
- technical_slow: lentidão, travando, velocidade baixa.
- technical_wifi: sinal fraco em cômodos, alcance do wi-fi.
- financial_invoice: fatura, boleto, segunda via, vencimento.
- financial_pix: pede o código PIX.
- financial_payment: afirma que já pagou.
- financial_unlock: está bloqueado e quer liberar.
- financial_discount_request: pede desconto, abatimento ou renegociação de valor.
- cancellation_risk: fala em cancelar.
- human_handoff: pede atendente humano.
- unauthorized_request: pede dado de outro cliente ou tenta burlar regras.
- out_of_scope: assunto que não é do provedor.
- general_information: quando não estiver claro.

Use confidence baixa (menor que 0.6) quando a mensagem for vaga demais para agir.
O cliente escreve informalmente, com erros e abreviações. Interprete a intenção, não a forma.
Não explique. Não escreva nada além do JSON.`;

export interface LlmConfig { apiKey: string; model: string; baseUrl: string; fetcher?: typeof fetch }

/**
 * Lê a configuração do ambiente. Sem `GROQ_API_KEY` devolve undefined, e quem
 * chama usa a regex — a flag não liga nada sozinha se o segredo não estiver lá.
 */
export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig | undefined {
  if (env.FEATURE_LLM_INTENT !== "true") return undefined;
  const apiKey = env.GROQ_API_KEY?.trim();
  if (!apiKey) return undefined;
  return {
    apiKey,
    model: env.LLM_MODEL?.trim() || "llama-3.3-70b-versatile",
    baseUrl: env.LLM_BASE_URL?.trim() || "https://api.groq.com/openai/v1",
  };
}

export interface Classification { intent: Intent; confidence: number; source: "llm" | "rules" }

function parseChoice(raw: string): Classification | undefined {
  // O modelo às vezes embrulha o JSON em cerca de código; pega o primeiro objeto.
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return undefined; }
  const value = parsed as { intent?: unknown; confidence?: unknown };
  const intent = String(value.intent ?? "") as Intent;
  if (!INTENTS.includes(intent)) return undefined;
  const confidence = Number(value.confidence);
  // Confiança ilegível vira 0.7: acima do corte de transbordo, longe de certeza.
  return { intent, confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.7, source: "llm" };
}

/**
 * Classifica a mensagem. Nunca lança: qualquer falha vira a classificação por
 * regra, que é o comportamento que já existia.
 *
 * A mensagem é **sanitizada antes de sair** — e-mail, CPF e telefone são
 * removidos. O provedor não precisa deles para entender a intenção, e o que não
 * sai não vaza.
 */
export async function classifyIntent(
  message: string,
  config: LlmConfig | undefined,
  timeoutMs = LLM_TIMEOUT_MS,
): Promise<Classification> {
  const rules = analyzeIntent(message);
  const fallback: Classification = { intent: rules.intent, confidence: rules.confidence, source: "rules" };
  if (!config) return fallback;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (config.fetcher ?? fetch)(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 60,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: sanitizeHandoffText(message).slice(0, 1000) },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return fallback;
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return parseChoice(body.choices?.[0]?.message?.content ?? "") ?? fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
