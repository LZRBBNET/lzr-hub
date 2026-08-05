import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DbAuthRepository, PasswordChangeError, changeOwnPassword } from "@/lib/platform/auth";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { currentUser, readSessionToken } from "@/lib/platform/session-guard";

/**
 * Troca da própria senha. Não passa por `authorize`: nenhuma permissão de
 * perfil concede ou nega isso — o que vale é ter sessão válida e saber a senha
 * atual. Um "Somente leitura" precisa poder trocar a própria senha.
 */
export async function POST(request: Request) {
  const token = readSessionToken(request);
  const user = await currentUser(request);
  if (!token || !user) return NextResponse.json({ error: "Sessão inválida ou expirada" }, { status: 401 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (!currentPassword || !newPassword) return NextResponse.json({ error: "Informe a senha atual e a nova" }, { status: 400 });

  try {
    await changeOwnPassword(new DbAuthRepository(await getDb()), user.id, token, currentPassword, newPassword);
    // A auditoria registra que houve troca; a senha em si nunca entra no rastro.
    await logUnauthenticatedAction({ action: "auth.password.change", entity: `user:${user.id}`, result: "success", reason: "Troca de senha pelo próprio usuário", actor: user });
    return NextResponse.json({ changed: true, otherSessionsRevoked: true });
  } catch (error) {
    if (error instanceof PasswordChangeError) {
      await logUnauthenticatedAction({ action: "auth.password.change", entity: `user:${user.id}`, result: "failed", reason: "Troca de senha recusada", actor: user });
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Não foi possível trocar a senha" }, { status: 503 });
  }
}
