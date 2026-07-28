import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DbAuthRepository, SESSION_COOKIE, SESSION_TTL_HOURS, login } from "@/lib/platform/auth";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { email?: unknown; password?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ error: "Informe e-mail e senha" }, { status: 400 });
  }

  let result;
  try {
    result = await login(new DbAuthRepository(await getDb()), email, password);
  } catch {
    return NextResponse.json({ error: "Serviço de autenticação indisponível" }, { status: 503 });
  }

  if (!result) {
    // Mensagem única: não revela se o e-mail existe nem se a conta está inativa.
    await logUnauthenticatedAction({ action: "auth.login", entity: "session", result: "failed", reason: "Tentativa de login sem sucesso" });
    return NextResponse.json({ error: "E-mail ou senha inválidos" }, { status: 401 });
  }

  const response = NextResponse.json({ user: result.user, expiresAt: result.expiresAt });
  response.cookies.set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_HOURS * 60 * 60,
  });
  return response;
}
