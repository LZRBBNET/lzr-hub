import { NextResponse } from "next/server";
import { rolePermissions } from "@/lib/platform/rbac";
import { authEnforced, currentUser } from "@/lib/platform/session-guard";

export async function GET(request: Request) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ authenticated: false, authRequired: authEnforced() }, { status: 200 });
  // A marca de senha provisória vai junto: quem recarrega a página no meio do
  // primeiro acesso precisa continuar sendo levado a definir a senha.
  const mustChangePassword = user.mustChangePassword === true;
  return NextResponse.json({
    authenticated: true,
    authRequired: authEnforced(),
    user,
    mustChangePassword,
    permissions: rolePermissions[user.role],
  });
}
