import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Traduz o webhook do **WhatsApp Business Platform (Cloud API)** da Meta para o
 * que o canal do LZR HUB espera.
 *
 * Existe porque a Evolution API usa Baileys — uma reimplementação **não oficial**
 * do WhatsApp Web — e usá-la para automação viola os Termos de Serviço. A Meta
 * detectou e avisou que a conta pode ser restringida. Este é o caminho oficial;
 * o outro só adiava o banimento do número que atende os clientes.
 *
 * Formato confirmado na documentação da Meta:
 *
 *   { object, entry[].changes[].value.{ messaging_product, metadata,
 *     contacts[], messages[] }, field }
 *
 * ⚠️ O **mesmo** webhook entrega recibo de entrega e leitura, num array
 * `statuses` em vez de `messages`. Tratar recibo como mensagem faria a IA
 * responder ao próprio "entregue".
 */

export const MESSAGE_FIELD = "messages";
export const EXPECTED_OBJECT = "whatsapp_business_account";

export interface MetaMessage {
  /** Número de quem escreveu, só dígitos, com o código do país. */
  phone: string;
  text: string;
  /** `wamid...` — id da mensagem na Meta, e a chave de idempotência. */
  messageId: string;
  profileName?: string;
  /** Telefone da BBNET que recebeu. Guardado para saber por qual número entrou. */
  phoneNumberId?: string;
}

export type SkipReason =
  | "outro-objeto"
  | "outro-campo"
  | "recibo-de-status"
  | "sem-mensagem"
  | "sem-texto"
  | "sem-remetente"
  | "sem-id";

export type ParseResult =
  | { ok: true; message: MetaMessage }
  | { ok: false; skip: SkipReason };

/**
 * Confere a assinatura `X-Hub-Signature-256`.
 *
 * É a segurança de verdade deste webhook, e é melhor que o Bearer que a Evolution
 * usava: a Meta assina o **corpo** com o segredo do aplicativo, então nem um
 * segredo vazado em log de proxy permite forjar mensagem sem saber o corpo.
 *
 * Comparação de tempo constante porque comparar assinatura com `===` vaza,
 * byte a byte, quanto do palpite estava certo.
 */
export function signatureIsValid(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const [algorithm, offered] = header.split("=");
  if (algorithm !== "sha256" || !offered) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(offered, "hex");
  // `timingSafeEqual` lança se os tamanhos diferem — e tamanho diferente já é
  // assinatura inválida, então a recusa vem antes.
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

const digits = (value: string) => value.replace(/\D/g, "");

export function parseMetaWebhook(payload: unknown): ParseResult {
  const body = (payload ?? {}) as Record<string, unknown>;
  if (body.object !== EXPECTED_OBJECT) return { ok: false, skip: "outro-objeto" };

  const entry = Array.isArray(body.entry) ? body.entry[0] as Record<string, unknown> | undefined : undefined;
  const change = Array.isArray(entry?.changes) ? entry.changes[0] as Record<string, unknown> | undefined : undefined;
  if (!change) return { ok: false, skip: "sem-mensagem" };
  if (change.field !== MESSAGE_FIELD) return { ok: false, skip: "outro-campo" };

  const value = (change.value ?? {}) as Record<string, unknown>;
  // Recibo de entrega/leitura chega pelo mesmo caminho, com `statuses` no lugar
  // de `messages`. Sem esta checagem a IA responderia ao próprio "entregue".
  if (Array.isArray(value.statuses) && value.statuses.length > 0) return { ok: false, skip: "recibo-de-status" };

  const message = Array.isArray(value.messages) ? value.messages[0] as Record<string, unknown> | undefined : undefined;
  if (!message) return { ok: false, skip: "sem-mensagem" };

  const phone = digits(String(message.from ?? ""));
  if (phone.length < 10) return { ok: false, skip: "sem-remetente" };

  const messageId = String(message.id ?? "").trim();
  if (!messageId) return { ok: false, skip: "sem-id" };

  // Só texto. Áudio, imagem, documento e botão têm outra forma; mandar a
  // legenda de uma foto como se fosse a fala do cliente faria a IA responder a
  // outra coisa — mesma decisão que já valia no caminho da Evolution.
  const text = message.type === "text"
    ? String(((message.text ?? {}) as Record<string, unknown>).body ?? "").trim()
    : "";
  if (!text) return { ok: false, skip: "sem-texto" };

  const contact = Array.isArray(value.contacts) ? value.contacts[0] as Record<string, unknown> | undefined : undefined;
  const profileName = contact && typeof (contact.profile as Record<string, unknown> | undefined)?.name === "string"
    ? String((contact.profile as Record<string, unknown>).name).trim()
    : undefined;
  const metadata = (value.metadata ?? {}) as Record<string, unknown>;

  return {
    ok: true,
    message: {
      phone, text, messageId, profileName,
      phoneNumberId: typeof metadata.phone_number_id === "string" ? metadata.phone_number_id : undefined,
    },
  };
}

/* ------------------------------------------------- lote e tipos de mensagem --- */

/**
 * Tipos que chegam pelo webhook e o atendente precisa ver. Áudio, foto e
 * documento não têm texto para a IA, mas são o cliente falando: descartá-los em
 * silêncio deixaria alguém esperando resposta sem que ninguém soubesse.
 */
export type InboundKind = "text" | "audio" | "image" | "video" | "document" | "sticker" | "location" | "contacts" | "other";

export interface MetaInbound {
  phone: string;
  messageId: string;
  kind: InboundKind;
  /** A fala do cliente. Vazio quando não é texto. */
  text: string;
  /** Legenda de foto, vídeo ou documento — mostrada ao atendente, nunca tratada como fala. */
  caption?: string;
  profileName?: string;
  phoneNumberId?: string;
  /**
   * Quando o cliente escreveu, pelo relógio da Meta. É daí que conta a janela de
   * 24 horas: a Meta reentrega webhook por dias, e a hora de chegada mentiria.
   */
  sentAt?: string;
}

/** Reação a uma mensagem e aviso de sistema (troca de número) não são fala do cliente. */
const IGNORED_TYPES = new Set(["reaction", "system"]);
const MEDIA_KINDS: Record<string, InboundKind> = {
  audio: "audio", voice: "audio", image: "image", video: "video", document: "document",
  sticker: "sticker", location: "location", contacts: "contacts",
};

type Bag = Record<string, unknown>;
const bag = (value: unknown): Bag => (value && typeof value === "object" ? value as Bag : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function textFrom(message: Bag): string {
  const type = message.type;
  if (type === "text") return String(bag(message.text).body ?? "").trim();
  // Resposta a botão é o cliente escolhendo uma opção: o título é a fala dele.
  if (type === "button") return String(bag(message.button).text ?? "").trim();
  if (type === "interactive") {
    const interactive = bag(message.interactive);
    return String(bag(interactive.button_reply).title ?? bag(interactive.list_reply).title ?? "").trim();
  }
  return "";
}

/** Percorre `entry[].changes[]` de um objeto de webhook, só no campo de mensagens. */
function messageChanges(payload: unknown): Bag[] {
  const body = bag(payload);
  if (body.object !== EXPECTED_OBJECT) return [];
  return list(body.entry).flatMap((entry) => list(bag(entry).changes).map(bag)).filter((change) => change.field === MESSAGE_FIELD).map((change) => bag(change.value));
}

/**
 * Todas as mensagens do webhook. A Meta pode juntar mais de uma no mesmo POST —
 * ler só a primeira, como `parseMetaWebhook` faz, perderia as outras em silêncio.
 */
export function parseMetaMessages(payload: unknown): MetaInbound[] {
  const result: MetaInbound[] = [];
  for (const value of messageChanges(payload)) {
    const contacts = list(value.contacts).map(bag);
    const metadata = bag(value.metadata);
    for (const raw of list(value.messages)) {
      const message = bag(raw);
      const type = String(message.type ?? "");
      if (IGNORED_TYPES.has(type)) continue;
      const phone = digits(String(message.from ?? ""));
      const messageId = String(message.id ?? "").trim();
      if (phone.length < 10 || !messageId) continue;
      // O contato certo é o do remetente; em lote, o primeiro pode ser de outra pessoa.
      const contact = contacts.find((entry) => digits(String(entry.wa_id ?? "")) === phone) ?? contacts[0];
      const name = bag(contact?.profile).name;
      const text = textFrom(message);
      const kind: InboundKind = text ? "text" : MEDIA_KINDS[type] ?? "other";
      const caption = kind === "text" ? undefined : String(bag(message[type]).caption ?? "").trim() || undefined;
      const seconds = Number(message.timestamp);
      result.push({
        phone, messageId, kind, text, caption,
        profileName: typeof name === "string" && name.trim() ? name.trim() : undefined,
        phoneNumberId: typeof metadata.phone_number_id === "string" ? metadata.phone_number_id : undefined,
        sentAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined,
      });
    }
  }
  return result;
}

/* ------------------------------------------------------ recibo de entrega --- */

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";
const DELIVERY_STATUSES = new Set<string>(["sent", "delivered", "read", "failed"]);

export interface MetaStatus {
  /** `wamid` da mensagem que nós enviamos. */
  messageId: string;
  status: DeliveryStatus;
  at?: string;
  errorCode?: number;
  errorDetail?: string;
}

/**
 * Recibos de entrega e leitura (`statuses`). É o único jeito de saber se a
 * resposta chegou: o 200 do envio só diz que a Meta aceitou.
 */
export function parseMetaStatuses(payload: unknown): MetaStatus[] {
  const result: MetaStatus[] = [];
  for (const value of messageChanges(payload)) {
    for (const raw of list(value.statuses)) {
      const entry = bag(raw);
      const status = String(entry.status ?? "");
      const messageId = String(entry.id ?? "").trim();
      if (!DELIVERY_STATUSES.has(status) || !messageId) continue;
      const seconds = Number(entry.timestamp);
      const error = bag(list(entry.errors)[0]);
      const code = Number(error.code);
      const detail = String(bag(error.error_data).details ?? error.message ?? error.title ?? "").slice(0, 200);
      result.push({
        messageId, status: status as DeliveryStatus,
        at: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined,
        errorCode: Number.isFinite(code) ? code : undefined,
        errorDetail: detail || undefined,
      });
    }
  }
  return result;
}
