/**
 * Envio pela **WhatsApp Cloud API** (Meta): o caminho de saída, par do webhook
 * em `webhook-parser.ts`.
 *
 * Nunca lança e nunca registra o token: quem chama recebe sempre um resultado
 * tipado, e o texto do erro é montado aqui, sem eco do cabeçalho de autorização.
 */

export const DEFAULT_GRAPH_VERSION = "v26.0";
export const SEND_TIMEOUT_MS = 8000;
/** Limite do corpo de texto no WhatsApp. */
export const MAX_TEXT_LENGTH = 4096;

export interface MetaSendConfig {
  accessToken: string;
  phoneNumberId: string;
  graphVersion: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/** Sem token ou sem id do número não há envio — e quem chama trata isso como "não configurado". */
export function metaSendConfigFromEnv(env: Record<string, string | undefined> = process.env): MetaSendConfig | undefined {
  const accessToken = env.META_ACCESS_TOKEN?.trim();
  const phoneNumberId = env.META_PHONE_NUMBER_ID?.trim();
  if (!accessToken || !phoneNumberId) return undefined;
  return { accessToken, phoneNumberId, graphVersion: env.META_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION };
}

export type SendFailureKind =
  | "window_closed"
  | "not_allowed"
  | "invalid_token"
  | "invalid_recipient"
  | "rate_limited"
  | "timeout"
  | "unreachable"
  | "rejected";

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; kind: SendFailureKind; reason: string; metaCode?: number };

interface GraphError { error?: { message?: string; code?: number; error_subcode?: number; type?: string } }

/**
 * Traduz o código de erro da Meta para algo que o atendente entende. Os códigos
 * vêm da documentação de erros da Cloud API; o que não está aqui cai em
 * `rejected` com a mensagem da própria Meta, em vez de ganhar um palpite.
 */
function failureFrom(status: number, body: GraphError): SendResult & { ok: false } {
  const code = body.error?.code;
  const detail = String(body.error?.message ?? "").slice(0, 200);
  if (code === 131047) return { ok: false, kind: "window_closed", metaCode: code, reason: "Passaram mais de 24 horas desde a última mensagem do cliente. A Meta só aceita texto livre dentro dessa janela." };
  if (code === 131030) return { ok: false, kind: "not_allowed", metaCode: code, reason: "A conta da Meta ainda só envia para números cadastrados como destinatários de teste." };
  if (code === 131026) return { ok: false, kind: "invalid_recipient", metaCode: code, reason: "A mensagem não pôde ser entregue: o número pode não ter WhatsApp ou estar indisponível." };
  if (code === 190 || code === 102 || status === 401) return { ok: false, kind: "invalid_token", metaCode: code, reason: "A autorização de envio da Meta é inválida ou expirou. Avise quem administra a integração." };
  if (code === 130429 || code === 131056 || status === 429) return { ok: false, kind: "rate_limited", metaCode: code, reason: "A Meta limitou a taxa de envio. Tente de novo em instantes." };
  return { ok: false, kind: "rejected", metaCode: code, reason: `A Meta recusou o envio${code ? ` (código ${code})` : ""}${detail ? `: ${detail}` : "."}` };
}

async function post(config: MetaSendConfig, payload: unknown): Promise<{ status: number; body: unknown } | { failure: SendResult & { ok: false } }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? SEND_TIMEOUT_MS);
  try {
    const response = await (config.fetcher ?? fetch)(
      `https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(config.phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return aborted
      ? { failure: { ok: false, kind: "timeout", reason: "A Meta demorou demais para responder. Não sei se a mensagem saiu: confira antes de reenviar." } }
      : { failure: { ok: false, kind: "unreachable", reason: "Não consegui falar com a Meta agora." } };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTextMessage(config: MetaSendConfig, input: { to: string; text: string }): Promise<SendResult> {
  const result = await post(config, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "text",
    text: { preview_url: false, body: input.text },
  });
  if ("failure" in result) return result.failure;
  const body = result.body as GraphError & { messages?: Array<{ id?: string }> };
  if (result.status >= 200 && result.status < 300) {
    const messageId = body.messages?.[0]?.id;
    // 2xx sem id: a Meta aceitou mas não disse qual mensagem — não dá para afirmar o envio.
    return messageId ? { ok: true, messageId } : { ok: false, kind: "rejected", reason: "A Meta respondeu sem identificar a mensagem enviada." };
  }
  return failureFrom(result.status, body);
}

/** Marca a mensagem do cliente como lida. Melhor esforço: quem chama ignora a falha. */
export async function markAsRead(config: MetaSendConfig, messageId: string): Promise<boolean> {
  const result = await post(config, { messaging_product: "whatsapp", status: "read", message_id: messageId });
  return !("failure" in result) && result.status >= 200 && result.status < 300;
}
