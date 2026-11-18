import { NextResponse } from "next/server";
import { createMetaTemplate, getPhoneLimits, listMetaTemplates, metaTemplatesConfigFromEnv } from "@/lib/integrations/meta/templates";
import { TEMPLATES } from "@/lib/platform/outbound-shared";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";

/**
 * Modelos de mensagem (templates) da cobrança e dos avisos, na conta do WhatsApp da BBNET.
 * GET mostra cada modelo do LZR com o status na Meta; POST envia para aprovação os que ainda
 * não existem lá (os já cadastrados não são reenviados). Exige `users.manage`.
 */

export async function GET(request: Request) {
  const guard = await authorize(request, "users.manage");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const config = metaTemplatesConfigFromEnv();
  if (!config) return NextResponse.json({ error: "Faltam META_ACCESS_TOKEN ou META_WABA_ID" }, { status: 503 });
  const remote = await listMetaTemplates(config);
  if (!remote.ok) return NextResponse.json({ error: remote.reason }, { status: 502 });
  const byName = new Map(remote.templates.map((item) => [item.name, item]));
  const phoneId = process.env.META_PHONE_NUMBER_ID?.trim();
  // O limite diário de conversas iniciadas e a qualidade do número: o teto real da cobrança.
  const phone = phoneId ? await getPhoneLimits(config, phoneId) : { ok: false as const, reason: "Falta META_PHONE_NUMBER_ID" };
  return NextResponse.json({
    phone,
    dailyCap: Number(process.env.OUTBOUND_DAILY_CAP) || 900,
    templates: Object.values(TEMPLATES).map((template) => ({
      name: template.name, body: template.body, status: byName.get(template.name)?.status ?? "NÃO CADASTRADO",
      rejectedReason: byName.get(template.name)?.rejectedReason ?? null,
    })),
  });
}

export async function POST(request: Request) {
  const guard = await authorize(request, "users.manage");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const config = metaTemplatesConfigFromEnv();
  if (!config) return NextResponse.json({ error: "Faltam META_ACCESS_TOKEN ou META_WABA_ID" }, { status: 503 });
  const remote = await listMetaTemplates(config);
  if (!remote.ok) return NextResponse.json({ error: remote.reason }, { status: 502 });
  const existing = new Set(remote.templates.map((item) => item.name));
  const results = [];
  for (const template of Object.values(TEMPLATES)) {
    if (existing.has(template.name)) { results.push({ name: template.name, result: "já cadastrado" }); continue; }
    const created = await createMetaTemplate(config, template);
    results.push({ name: template.name, result: created.ok ? `enviado (${created.status})` : `recusado: ${created.reason}` });
  }
  await logUnauthenticatedAction({
    action: "whatsapp.templates.submit", entity: "whatsapp", result: "ok", actor: guard.user,
    reason: `Modelos enviados para aprovação na Meta: ${results.map((item) => `${item.name} — ${item.result}`).join("; ")}`,
  }).catch(() => undefined);
  return NextResponse.json({ results });
}
