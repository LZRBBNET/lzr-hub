import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { clientIp, loginThrottle } from "@/lib/platform/login-throttle";
import { DbPasswordResetRepository, parseResetRequest } from "@/lib/platform/password-reset";

/**
 * Registra um pedido de recuperação. Rota pública, então três cuidados:
 *
 * 1. A resposta é **sempre a mesma**, com ou sem conta, com ou sem banco. Uma
 *    resposta diferente para e-mail desconhecido transformaria isto num
 *    verificador de quais endereços têm conta na BBNET.
 * 2. Passa pelo mesmo freio do login, para não virar um jeito de encher a
 *    tabela nem de varrer endereços sem limite.
 * 3. Nada é enviado a ninguém: não há e-mail no projeto. Quem resolve é uma
 *    pessoa, na tela de Usuários.
 */
const SAME_ANSWER = { registered: true, detail: "Se houver uma conta com este e-mail, um administrador vai receber o pedido." };

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const parsed = body ? parseResetRequest(body) : undefined;
  if (!parsed) return NextResponse.json({ error: "Informe um e-mail válido" }, { status: 400 });

  const ip = clientIp(request);
  if (loginThrottle.retryAfterSeconds(parsed.email, ip) > 0) {
    return NextResponse.json({ error: "Pedidos demais. Tente de novo mais tarde." }, { status: 429 });
  }
  loginThrottle.recordFailure(parsed.email, ip);

  try {
    await new DbPasswordResetRepository(await getDb()).create(parsed.email, parsed.note);
    await logUnauthenticatedAction({ action: "auth.password.reset-request", entity: "password_reset", result: "success", reason: "Pedido de recuperação de senha registrado", actorNotApplicable: true });
  } catch {
    // Banco fora do ar não pode mudar a resposta: a diferença viraria um sinal.
  }
  return NextResponse.json(SAME_ANSWER);
}
