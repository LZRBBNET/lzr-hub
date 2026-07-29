import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import { auditEvents } from "../../db/schema.ts";
import type { AuthenticatedUser } from "./auth.ts";

export interface UnauthenticatedActionEntry {
  action: string;
  entity: string;
  result: string;
  reason: string;
  correlationId?: string;
  /** Quando há sessão, o rastro deixa de ser anônimo. */
  actor?: AuthenticatedUser;
  /**
   * Marque nas ações em que não existir autor é o esperado — por exemplo, uma
   * tentativa de login que falhou nunca terá sessão. Sem isso, o registro
   * ganharia uma ressalva sobre autenticação ausente que não faz sentido ali.
   */
  actorNotApplicable?: boolean;
}

/**
 * Registra uma ação no rastro de auditoria.
 * Nunca deve derrubar a ação principal se o banco falhar — só complementa o rastro.
 */
export async function logUnauthenticatedAction(entry: UnauthenticatedActionEntry): Promise<void> {
  const anonymous = !entry.actor && !entry.actorNotApplicable;
  try {
    const db = await getDb();
    await db.insert(auditEvents).values({
      id: randomUUID(),
      actorId: entry.actor ? entry.actor.email : "anônimo",
      role: entry.actor ? entry.actor.role : "não identificado",
      action: entry.action,
      entity: entry.entity,
      beforeMasked: null,
      afterMasked: null,
      reason: anonymous
        ? `${entry.reason} (sem autenticação nesta requisição — FEATURE_AUTH desligada)`
        : entry.reason,
      correlationId: entry.correlationId ?? randomUUID(),
      result: entry.result,
      // Só é "humano" com sessão resolvida; sem autor verificado a origem fica em aberto.
      origin: entry.actor ? "humano" : "não verificado",
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Auditoria é best-effort aqui; a rota principal já respondeu ao cliente.
  }
}

export interface AuditEntry {
  id: string; actorId: string; role: string; action: string; entity: string;
  reason: string; correlationId: string; result: string; origin: string; createdAt: string;
}

/** Lê o rastro real do banco para a tela de auditoria do admin. */
export async function listAuditEvents(limit = 50): Promise<AuditEntry[]> {
  const db = await getDb();
  return db.select({
    id: auditEvents.id, actorId: auditEvents.actorId, role: auditEvents.role,
    action: auditEvents.action, entity: auditEvents.entity, reason: auditEvents.reason,
    correlationId: auditEvents.correlationId, result: auditEvents.result,
    origin: auditEvents.origin, createdAt: auditEvents.createdAt,
  }).from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(limit);
}
