/**
 * Interpreta o texto de alerta que hoje chega num grupo do Telegram, colado por
 * quem cuida da rede (bot ligado a algum monitoramento — Zabbix ou equivalente,
 * não confirmado). Dois formatos reais foram observados:
 *
 *   ❌ OLT-ZTE-CDB-SUP-02 possui alertas!
 *   Descrição:
 *   Interface gpon_olt-1/3/16 está DOWN
 *   Início:
 *   Data: 2026.08.03 | Hora: 14:48:20
 *
 *   ⛔ Possível rompimento de fibra em SW-L3-COR-CDB-SUP-01
 *   Descrição do evento:
 *    XGigabitEthernet0/0/12 - "Core: ..." - DOWN
 *   Data: 2026.08.04 | 21:59:31
 *   ID do evento: 129400624
 *
 * Deliberadamente **não decodifica** os códigos do nome do equipamento
 * (CDB, ARYB, SUP, POV, ESC…) em cidade/bairro. Parecem indicar localidade,
 * mas decodificar sem confirmação seria inventar geografia — o equipamento
 * fica bruto, exatamente como chegou, até existir uma tabela de tradução
 * explícita.
 *
 * Formato não reconhecido nunca é descartado: vira `kind:"unrecognized"`,
 * `parsed:false`, com o texto original preservado. Perder um alerta caído por
 * não bater com a regex é pior do que mostrá-lo cru.
 */

export type NetworkAlertKind = "olt_interface" | "fiber_link" | "unrecognized";

export interface ParsedNetworkAlert {
  kind: NetworkAlertKind;
  equipment: string;
  description: string | null;
  resolved: boolean;
  externalEventId: string | null;
  startedAt: string;
  resolvedAt: string | null;
  correlationKey: string;
  parsed: boolean;
}

// Âncoras deliberadamente sem acento (recupera-, não "recuperação"): um alerta
// real chegou com emoji e "í"/"ç"/"ã" corrompidos num teste manual, e a parte
// sem acento da palavra já identifica a mensagem sem depender de encoding.
const RESOLVED_HINT = /normalizad|restabelecid|recupera|✅/i;
const DATE_RE = /Data:\s*(\d{4})\.(\d{2})\.(\d{2})\s*\|\s*(?:Hora:\s*)?(\d{2}:\d{2}:\d{2})/g;
const RECOVERY_LABEL_NEAR = /recupera/i;

/** Datas do alerta são hora de Brasília, sem fuso escrito. -03:00 é estável (Brasil não observa horário de verão desde 2019). */
function toIso(year: string, month: string, day: string, time: string): string | null {
  const parsed = new Date(`${year}-${month}-${day}T${time}-03:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function extractDates(text: string): { startedAt: string | null; resolvedAt: string | null } {
  let startedAt: string | null = null;
  let resolvedAt: string | null = null;
  for (const match of text.matchAll(DATE_RE)) {
    const iso = toIso(match[1], match[2], match[3], match[4]);
    if (!iso) continue;
    const precedingContext = text.slice(Math.max(0, match.index - 40), match.index);
    if (RECOVERY_LABEL_NEAR.test(precedingContext)) resolvedAt = iso;
    else if (startedAt === null) startedAt = iso;
  }
  return { startedAt, resolvedAt };
}

function extractDescription(text: string): string | null {
  const match = text.match(/Descri[^\n:]*:\s*\n\s*(.+)/);
  return match ? match[1].trim() : null;
}

function extractEventId(text: string): string | null {
  const match = text.match(/ID do evento:\s*(\d+)/);
  return match ? match[1] : null;
}

export function parseNetworkAlertMessage(rawText: string, receivedAt: string): ParsedNetworkAlert {
  const text = rawText.trim();
  const resolved = RESOLVED_HINT.test(text);
  const description = extractDescription(text);
  const eventId = extractEventId(text);
  const { startedAt, resolvedAt } = extractDates(text);

  // `^[^\w]*` pula qualquer emoji/pontuação líder sem precisar enumerar cada
  // variante — mais robusto que depender do glifo exato do emoji.
  const oltMatch = text.match(/^[^\w]*(\S[\S ]*?)\s+(?:possui alertas|normalizado)!?/);
  const fiberMatch = text.match(/rompimento de fibra em\s+(\S+)/i);

  let kind: NetworkAlertKind = "unrecognized";
  let equipment = "desconhecido";
  if (oltMatch) { kind = "olt_interface"; equipment = oltMatch[1].trim(); }
  else if (fiberMatch) { kind = "fiber_link"; equipment = fiberMatch[1].trim(); }

  return {
    kind, equipment, description,
    resolved: kind === "unrecognized" ? resolved : (resolved || resolvedAt !== null),
    externalEventId: eventId,
    startedAt: startedAt ?? receivedAt,
    resolvedAt: resolved ? (resolvedAt ?? receivedAt) : null,
    correlationKey: eventId ? `event:${eventId}` : `${equipment}::${description ?? "sem-descricao"}`,
    parsed: kind !== "unrecognized",
  };
}
