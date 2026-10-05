import { and, eq, sql } from "drizzle-orm";
import { channelMessages } from "../../db/schema.ts";
import { describeMetaError } from "../integrations/meta/cloud-client.ts";
import type { DeliveryStatus, MetaStatus } from "../integrations/meta/webhook-parser.ts";

/**
 * Recibos de entrega das respostas enviadas pela tela.
 *
 * Sem eles, "enviada" quer dizer só "a Meta aceitou" — e uma mensagem aceita
 * pode falhar depois (número sem WhatsApp, janela fechada no caminho). O
 * atendente precisa ver essa falha, senão o cliente fica sem resposta e a tela
 * diz que respondeu.
 */

/** A ordem em que o recibo avança. Recibo que chega fora de ordem não rebaixa. */
export const STATUS_RANK: Record<DeliveryStatus, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

export interface DeliveryUpdate { messageId: string; status: DeliveryStatus; error: string | null; at: string }

export interface DeliveryRepository {
  /** `false` quando nada mudou: mensagem que não é nossa, ou recibo mais velho que o gravado. */
  apply(update: DeliveryUpdate): Promise<boolean>;
}

/** O motivo da falha na mesma frase que a recusa no envio usaria. */
export function deliveryError(status: MetaStatus): string | null {
  return status.status === "failed" ? describeMetaError(status.errorCode, status.errorDetail).reason : null;
}

export async function applyStatuses(repository: DeliveryRepository, statuses: MetaStatus[], now: () => string = () => new Date().toISOString()): Promise<number> {
  let changed = 0;
  for (const status of statuses) {
    if (await repository.apply({ messageId: status.messageId, status: status.status, error: deliveryError(status), at: status.at ?? now() })) changed++;
  }
  return changed;
}

export class DbDeliveryRepository implements DeliveryRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }
  async apply(update: DeliveryUpdate): Promise<boolean> {
    const current = sql`case ${channelMessages.deliveryStatus} when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'failed' then 4 else 0 end`;
    const rows = await this.db.update(channelMessages)
      .set({ deliveryStatus: update.status, deliveryError: update.error, deliveryUpdatedAt: update.at })
      // Só resposta nossa: o `wamid` do cliente também está gravado, e recibo nunca é dele.
      .where(and(eq(channelMessages.externalMessageId, update.messageId), eq(channelMessages.role, "agent"), sql`${current} < ${STATUS_RANK[update.status]}`))
      .returning({ id: channelMessages.id });
    return rows.length > 0;
  }
}

export class MemoryDeliveryRepository implements DeliveryRepository {
  /** `wamid` → recibo gravado. Só mensagem cadastrada aqui é "nossa". */
  readonly messages = new Map<string, { status: DeliveryStatus | null; error: string | null; at: string | null }>();
  async apply(update: DeliveryUpdate) {
    const current = this.messages.get(update.messageId);
    if (!current) return false;
    if ((current.status ? STATUS_RANK[current.status] : 0) >= STATUS_RANK[update.status]) return false;
    this.messages.set(update.messageId, { status: update.status, error: update.error, at: update.at });
    return true;
  }
}
