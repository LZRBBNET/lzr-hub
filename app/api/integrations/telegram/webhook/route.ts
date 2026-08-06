import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { parseNetworkAlertMessage } from "@/lib/integrations/telegram/network-alert-parser";
import { DbNetworkAlertsRepository } from "@/lib/platform/network-alerts-service";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";

/**
 * Alerta de rede real nasce desligado, como toda flag que produz efeito no
 * mundo real — aqui o "efeito" é gravar no banco a cada mensagem do grupo, sem
 * ninguém no meio para revisar antes.
 *
 * Autenticação: Telegram ecoa o `secret_token` passado no `setWebhook` no
 * cabeçalho `X-Telegram-Bot-Api-Secret-Token` em toda chamada — mesmo papel
 * que o `Authorization: Bearer` faz para o canal n8n, adaptado ao mecanismo
 * que o Telegram oferece.
 *
 * Sempre responde 200 (mesmo em erro de parsing): devolver erro faria o
 * Telegram reentregar a mensagem em loop. O que não é reconhecido fica
 * registrado como `parsed:false`, nunca descartado.
 */
export async function POST(request: Request) {
  if (process.env.FEATURE_TELEGRAM_ALERTS !== "true") {
    return NextResponse.json({ ok: true, skipped: "disabled" });
  }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: true, skipped: "misconfigured" });
  if (request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  const update = await request.json().catch(() => null) as Record<string, unknown> | null;
  const text = (update?.message as { text?: string } | undefined)?.text
    ?? (update?.channel_post as { text?: string } | undefined)?.text;
  if (typeof text !== "string" || !text.trim()) return NextResponse.json({ ok: true, skipped: "no-text" });

  const receivedAt = new Date().toISOString();
  const correlationId = randomUUID();
  try {
    const parsed = parseNetworkAlertMessage(text, receivedAt);
    const { row, created } = await new DbNetworkAlertsRepository(await getDb()).upsertFromMessage(parsed, text, "telegram");
    await logUnauthenticatedAction({
      action: "integrations.telegram.alert", entity: `network_alert:${row.id}`, result: parsed.parsed ? "success" : "unrecognized",
      reason: `${created ? "Novo" : "Atualizado"} alerta ${parsed.kind} (${parsed.equipment}), status ${row.status}`,
      correlationId,
      // Webhook de máquina autenticado pelo secret_token do Telegram, não por
      // sessão — não é a mesma ausência de autor que uma rota sem login.
      actorNotApplicable: true,
    });
    return NextResponse.json({ ok: true, id: row.id, created });
  } catch {
    // Nunca propaga erro para o Telegram — ele reentregaria a mensagem sem parar.
    return NextResponse.json({ ok: true, skipped: "error" });
  }
}
