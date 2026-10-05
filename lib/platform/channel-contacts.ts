import { channelContacts } from "../../db/schema.ts";

/**
 * Nome do perfil de WhatsApp de quem escreveu.
 *
 * É o que a pessoa escolheu para si: ajuda o atendente a reconhecer a conversa,
 * mas não identifica ninguém — qualquer um pode se chamar "BBNET Suporte". O
 * cadastro do cliente continua vindo do telefone cruzado com o IXC.
 */

export const MAX_DISPLAY_NAME = 80;

/**
 * Tira caractere de controle e os invisíveis que invertem ou escondem texto
 * (marcas de direção, espaço de largura zero): um nome que se reescreve na tela
 * pode se passar por outro. O ZWJ fica, porque compõe emoji de família.
 */
const HIDDEN = /[\u0000-\u001f\u007f​‌‎‏‪-‮⁦-⁩]/g;

export function cleanDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.replace(HIDDEN, "").replace(/\s+/g, " ").trim();
  if (!value) return undefined;
  // Por caractere, não por unidade de código: cortar no meio de um emoji deixa lixo.
  return Array.from(value).slice(0, MAX_DISPLAY_NAME).join("");
}

export interface ContactsRepository {
  upsertName(channel: string, conversationId: string, name: string): Promise<void>;
}

/** Guarda o último nome visto. Nunca lança: o nome é conveniência, a mensagem já foi registrada. */
export async function rememberContactName(repository: ContactsRepository, channel: string, conversationId: string, raw: unknown): Promise<void> {
  const name = cleanDisplayName(raw);
  if (!name) return;
  try { await repository.upsertName(channel, conversationId, name); } catch { /* sem nome a conversa aparece pelo número, como antes */ }
}

export class DbContactsRepository implements ContactsRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }
  async upsertName(channel: string, conversationId: string, name: string): Promise<void> {
    const updatedAt = new Date().toISOString();
    await this.db.insert(channelContacts).values({ channel, externalConversationId: conversationId, displayName: name, updatedAt })
      .onConflictDoUpdate({ target: [channelContacts.channel, channelContacts.externalConversationId], set: { displayName: name, updatedAt } });
  }
}

export class MemoryContactsRepository implements ContactsRepository {
  readonly names = new Map<string, string>();
  async upsertName(channel: string, conversationId: string, name: string) { this.names.set(`${channel}:${conversationId}`, name); }
}
