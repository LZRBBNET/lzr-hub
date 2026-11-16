import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DbAuthRepository } from "@/lib/platform/auth";
import { rolePermissions } from "@/lib/platform/rbac";
import { authEnforced, sessionState } from "@/lib/platform/session-guard";

export async function GET(request: Request) {
  const unavailable = () => NextResponse.json({ error: "Autenticação temporariamente indisponível. Tente novamente mais tarde." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const { user, unavailable: failed } = await sessionState(request);
  if (failed) return unavailable();
  if (!user) return NextResponse.json({ authenticated: false, authRequired: authEnforced() }, { status: 200 });
  // A marca de senha provisória vai junto: quem recarrega a página no meio do
  // primeiro acesso precisa continuar sendo levado a definir a senha.
  let mustChangePassword = false;
  try {
    const current = await new DbAuthRepository(await getDb()).findUserById(user.id);
    if (!current) return unavailable();
    mustChangePassword = current.mustChangePassword === true;
  } catch { return unavailable(); }
  return NextResponse.json({
    authenticated: true,
    authRequired: authEnforced(),
    user,
    mustChangePassword,
    permissions: rolePermissions[user.role],
  });
}
