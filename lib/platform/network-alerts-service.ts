import { randomUUID } from "node:crypto";
import { desc, eq, gte, and } from "drizzle-orm";
import { networkAlerts } from "../../db/schema.ts";
import type { ParsedNetworkAlert } from "../integrations/telegram/network-alert-parser.ts";

/**
 * Alertas de rede reais, ingeridos do grupo do Telegram (ver
 * lib/integrations/telegram/network-alert-parser.ts para o formato). Uma
 * mensagem de queda e a normalização correspondente casam pela mesma
 * `correlationKey` e viram **uma linha**, não duas — sem isso "alertas
 * ativos" contaria coisa já resolvida.
 *
 * Correlação geográfica ("clientes da região reclamando") não é feita por
 * aqui: o código do equipamento não foi decodificado em cidade/bairro (ver
 * comentário no schema), então agrupar por local seria inventar a mesma
 * geografia que decidimos não adivinhar. O que existe é a contagem de
 * alertas simultaneamente abertos — sinal real, sem fingir saber onde.
 */

export interface NetworkAlertRow {
  id: string;
  source: string;
  kind: string;
  equipment: string;
  description: string | null;
  status: "open" | "resolved";
  externalEventId: string | null;
  correlationKey: string;
  startedAt: string;
  resolvedAt: string | null;
  rawText: string;
  parsed: boolean;
  createdAt: string;
}

export interface NetworkAlertsRepository {
  /** Casa com um alerta ainda aberto da mesma correlationKey; senão, cria linha nova. */
  upsertFromMessage(parsed: ParsedNetworkAlert, rawText: string, source: string): Promise<{ row: NetworkAlertRow; created: boolean }>;
  listOpen(): Promise<NetworkAlertRow[]>;
  listSince(sinceIso: string): Promise<NetworkAlertRow[]>;
}

function toRow(id: string, parsed: ParsedNetworkAlert, rawText: string, source: string, createdAt: string): NetworkAlertRow {
  return {
    id, source, kind: parsed.kind, equipment: parsed.equipment, description: parsed.description,
    status: parsed.resolved ? "resolved" : "open", externalEventId: parsed.externalEventId,
    correlationKey: parsed.correlationKey, startedAt: parsed.startedAt, resolvedAt: parsed.resolvedAt,
    rawText, parsed: parsed.parsed, createdAt,
  };
}

export class DbNetworkAlertsRepository implements NetworkAlertsRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async upsertFromMessage(parsed: ParsedNetworkAlert, rawText: string, source: string) {
    const now = new Date().toISOString();
    const openMatch = await this.db.select().from(networkAlerts)
      .where(and(eq(networkAlerts.correlationKey, parsed.correlationKey), eq(networkAlerts.status, "open")))
      .limit(1);

    if (openMatch[0] && parsed.resolved) {
      const updated = await this.db.update(networkAlerts)
        .set({ status: "resolved", resolvedAt: parsed.resolvedAt, updatedAt: now })
        .where(eq(networkAlerts.id, openMatch[0].id))
        .returning();
      return { row: updated[0] as NetworkAlertRow, created: false };
    }
    if (openMatch[0] && !parsed.resolved) {
      // Reenvio da mesma queda ainda aberta: não duplica.
      return { row: openMatch[0] as NetworkAlertRow, created: false };
    }

    const id = randomUUID();
    const row = toRow(id, parsed, rawText, source, now);
    await this.db.insert(networkAlerts).values({ ...row, createdAt: now, updatedAt: now });
    return { row, created: true };
  }

  async listOpen(): Promise<NetworkAlertRow[]> {
    return this.db.select().from(networkAlerts).where(eq(networkAlerts.status, "open")).orderBy(desc(networkAlerts.startedAt));
  }

  async listSince(sinceIso: string): Promise<NetworkAlertRow[]> {
    return this.db.select().from(networkAlerts).where(gte(networkAlerts.startedAt, sinceIso)).orderBy(desc(networkAlerts.startedAt));
  }
}

export class MemoryNetworkAlertsRepository implements NetworkAlertsRepository {
  readonly rows: NetworkAlertRow[] = [];
  async upsertFromMessage(parsed: ParsedNetworkAlert, rawText: string, source: string) {
    const open = this.rows.find((row) => row.correlationKey === parsed.correlationKey && row.status === "open");
    if (open && parsed.resolved) { open.status = "resolved"; open.resolvedAt = parsed.resolvedAt; return { row: open, created: false }; }
    if (open && !parsed.resolved) return { row: open, created: false };
    const row = toRow(randomUUID(), parsed, rawText, source, new Date().toISOString());
    this.rows.push(row);
    return { row, created: true };
  }
  async listOpen() { return this.rows.filter((row) => row.status === "open"); }
  async listSince(sinceIso: string) { return this.rows.filter((row) => row.startedAt >= sinceIso); }
}

/** A partir deste tanto de alertas abertos simultâneos, vale considerar massiva — sem apontar região, que não sabemos. */
export const MASSIVA_SUGGESTION_THRESHOLD = 3;
export function suggestsMassiva(openAlerts: NetworkAlertRow[]): boolean {
  return openAlerts.length >= MASSIVA_SUGGESTION_THRESHOLD;
}
