import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { listUsers } from "@/lib/platform/auth";
import { authorize } from "@/lib/platform/session-guard";

/**
 * Contas reais do LZR HUB, somente leitura. Criar, desativar e trocar senha
 * ainda não existem na tela — são feitos por `scripts/create-user.mjs`. Mostrar
 * quem tem acesso já é útil; fingir que dá para gerenciar por aqui não é.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "users.manage");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  try {
    return NextResponse.json({ available: true, users: await listUsers(await getDb()) });
  } catch {
    return NextResponse.json({ available: false, detail: "Lista de usuários indisponível", users: [] });
  }
}
