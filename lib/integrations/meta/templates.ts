import { DEFAULT_GRAPH_VERSION } from "./cloud-client.ts";
import { templatePayload, type TemplateDefinition } from "../../platform/outbound-shared.ts";

/**
 * Cadastro dos modelos (templates) na conta do WhatsApp da BBNET, pela Graph API:
 *   GET  /{waba}/message_templates   — o que existe e o status (APPROVED, PENDING, REJECTED)
 *   POST /{waba}/message_templates   — envia um modelo para aprovação
 * A aprovação é da Meta (minutos a 1 dia). Nunca lança e nunca registra o token.
 */

export interface MetaTemplatesConfig { accessToken: string; wabaId: string; graphVersion: string; fetcher?: typeof fetch }

export function metaTemplatesConfigFromEnv(env: Record<string, string | undefined> = process.env): MetaTemplatesConfig | undefined {
  const accessToken = env.META_ACCESS_TOKEN?.trim();
  const wabaId = env.META_WABA_ID?.trim();
  if (!accessToken || !wabaId) return undefined;
  return { accessToken, wabaId, graphVersion: env.META_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION };
}

export interface MetaTemplateStatus { name: string; status: string; category?: string; rejectedReason?: string }

const url = (config: MetaTemplatesConfig, query = "") =>
  `https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(config.wabaId)}/message_templates${query}`;

export async function listMetaTemplates(config: MetaTemplatesConfig): Promise<{ ok: true; templates: MetaTemplateStatus[] } | { ok: false; reason: string }> {
  try {
    const response = await (config.fetcher ?? fetch)(url(config, "?fields=name,status,category,rejected_reason&limit=200"), { headers: { Authorization: `Bearer ${config.accessToken}` } });
    const body = await response.json().catch(() => ({})) as { data?: Array<{ name?: string; status?: string; category?: string; rejected_reason?: string }>; error?: { message?: string } };
    if (!response.ok) return { ok: false, reason: `A Meta recusou a consulta: ${String(body.error?.message ?? response.status).slice(0, 200)}` };
    return { ok: true, templates: (body.data ?? []).map((item) => ({ name: String(item.name ?? ""), status: String(item.status ?? ""), category: item.category, rejectedReason: item.rejected_reason && item.rejected_reason !== "NONE" ? item.rejected_reason : undefined })) };
  } catch {
    return { ok: false, reason: "Não consegui falar com a Meta agora." };
  }
}

/**
 * Limite de conversas que a empresa pode começar por dia (`messaging_limit_tier`: TIER_250,
 * TIER_1K, TIER_10K, TIER_100K, TIER_UNLIMITED) e a qualidade do número. É o teto real da
 * cobrança: `OUTBOUND_DAILY_CAP` precisa caber nele.
 */
export async function getPhoneLimits(config: MetaTemplatesConfig, phoneNumberId: string): Promise<{ ok: true; tier: string | null; quality: string | null; name: string | null } | { ok: false; reason: string }> {
  try {
    const response = await (config.fetcher ?? fetch)(`https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(phoneNumberId)}?fields=messaging_limit_tier,quality_rating,verified_name`, { headers: { Authorization: `Bearer ${config.accessToken}` } });
    const body = await response.json().catch(() => ({})) as { messaging_limit_tier?: string; quality_rating?: string; verified_name?: string; error?: { message?: string } };
    if (!response.ok) return { ok: false, reason: String(body.error?.message ?? response.status).slice(0, 200) };
    return { ok: true, tier: body.messaging_limit_tier ?? null, quality: body.quality_rating ?? null, name: body.verified_name ?? null };
  } catch {
    return { ok: false, reason: "Não consegui falar com a Meta agora." };
  }
}

/**
 * Para onde a Meta entrega as mensagens do número. Há três níveis, do mais forte ao mais fraco:
 * URL do **número**, URL da **conta do WhatsApp** (`override_callback_uri` em `subscribed_apps`) e URL do **app**.
 * Só o app aparece no painel de desenvolvedores; os outros dois substituem a URL dele em silêncio, e só a API mostra.
 * Só leitura; nunca lança e nunca devolve o token.
 */
export interface WebhookRouting {
  apps: Array<{ appId: string | null; appName: string | null; overrideCallbackUri: string | null }>;
  phoneOverrideUri: string | null;
}

export async function getWebhookRouting(config: MetaTemplatesConfig, phoneNumberId?: string): Promise<{ ok: true; routing: WebhookRouting; notes: string[] } | { ok: false; reason: string }> {
  const fetcher = config.fetcher ?? fetch;
  const headers = { Authorization: `Bearer ${config.accessToken}` };
  const base = `https://graph.facebook.com/${config.graphVersion}`;
  const notes: string[] = [];
  try {
    const response = await fetcher(`${base}/${encodeURIComponent(config.wabaId)}/subscribed_apps`, { headers, signal: AbortSignal.timeout(10000) });
    const body = await response.json().catch(() => ({})) as { data?: Array<{ whatsapp_business_api_data?: { id?: string; name?: string }; override_callback_uri?: string }>; error?: { message?: string } };
    if (!response.ok) return { ok: false, reason: `A Meta recusou a consulta: ${String(body.error?.message ?? response.status).slice(0, 200)}` };
    const apps = (body.data ?? []).map((item) => ({
      appId: item.whatsapp_business_api_data?.id ?? null, appName: item.whatsapp_business_api_data?.name ?? null, overrideCallbackUri: item.override_callback_uri ?? null,
    }));
    let phoneOverrideUri: string | null = null;
    if (phoneNumberId) {
      // A URL do número vem em outro campo; se a Meta não o expuser a este token, é dito, não presumido.
      const phone = await fetcher(`${base}/${encodeURIComponent(phoneNumberId)}?fields=webhook_configuration`, { headers, signal: AbortSignal.timeout(10000) }).catch(() => undefined);
      const phoneBody = phone ? await phone.json().catch(() => ({})) as { webhook_configuration?: { phone_number?: string }; error?: { message?: string } } : {};
      if (phone?.ok) phoneOverrideUri = phoneBody.webhook_configuration?.phone_number ?? null;
      else notes.push("Não consegui ler a URL própria do número (a Meta recusou o campo). Só a da conta e a do app foram conferidas.");
    }
    return { ok: true, routing: { apps, phoneOverrideUri }, notes };
  } catch {
    return { ok: false, reason: "Não consegui falar com a Meta agora." };
  }
}

export async function createMetaTemplate(config: MetaTemplatesConfig, definition: TemplateDefinition): Promise<{ ok: true; status: string } | { ok: false; reason: string }> {
  try {
    const response = await (config.fetcher ?? fetch)(url(config), {
      method: "POST",
      headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(templatePayload(definition)),
    });
    const body = await response.json().catch(() => ({})) as { status?: string; error?: { message?: string; error_user_msg?: string } };
    if (!response.ok) return { ok: false, reason: String(body.error?.error_user_msg ?? body.error?.message ?? `HTTP ${response.status}`).slice(0, 240) };
    return { ok: true, status: String(body.status ?? "PENDING") };
  } catch {
    return { ok: false, reason: "Não consegui falar com a Meta agora." };
  }
}
