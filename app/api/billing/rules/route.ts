import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { DbCollectionRulesRepository, RuleValidationError, parseRuleInput } from "@/lib/platform/collection-rules-service";
import { authorize } from "@/lib/platform/session-guard";

export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  try {
    const rule = await new DbCollectionRulesRepository(await getDb()).getLatest();
    return NextResponse.json({ available: true, rule: rule ?? null });
  } catch {
    return NextResponse.json({ available: false, detail: "Régua indisponível", rule: null });
  }
}

/**
 * Salvar a régua cria uma versão nova e fica auditado. Não envia nada: a régua
 * define quando falar, o envio depende de campanha, que não está ligada.
 */
export async function POST(request: Request) {
  const guard = await authorize(request, "billing.write-demo");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });

  try {
    const input = parseRuleInput(body);
    const saved = await new DbCollectionRulesRepository(await getDb()).saveVersion(input, guard.user?.email ?? "não identificado");
    await logUnauthenticatedAction({
      action: "billing.rule.save", entity: `collection_rule:${saved.id}`, result: "success",
      reason: `Nova versão da régua de cobrança (v${saved.version}, ${saved.steps.length} etapas)`, actor: guard.user,
    });
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    if (error instanceof RuleValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Não foi possível salvar a régua" }, { status: 503 });
  }
}
