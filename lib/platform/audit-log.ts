import { randomUUID } from "node:crypto";
import { getDb } from "../../db/index.ts";
import { auditEvents } from "../../db/schema.ts";

export interface UnauthenticatedActionEntry {
  action: string;
  entity: string;
  result: string;
  reason: string;
  correlationId?: string;
}

/**
 * Registra uma ação em rotas que ainda não têm autenticação de usuário real.
 * Nunca deve derrubar a ação principal se o banco falhar — só complementa o rastro.
 */
export async function logUnauthenticatedAction(entry: UnauthenticatedActionEntry): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(auditEvents).values({
      id: randomUUID(),
      actorId: "anônimo",
      role: "não identificado",
      action: entry.action,
      entity: entry.entity,
      beforeMasked: null,
      afterMasked: null,
      reason: `${entry.reason} (sem autenticação disponível nesta rota — ver issue de autenticação)`,
      correlationId: entry.correlationId ?? randomUUID(),
      result: entry.result,
      origin: "não verificado",
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Auditoria é best-effort aqui; a rota principal já respondeu ao cliente.
  }
}
