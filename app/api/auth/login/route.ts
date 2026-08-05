import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DbAuthRepository, SESSION_COOKIE, SESSION_TTL_HOURS, login } from "@/lib/platform/auth";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { clientIp, loginThrottle } from "@/lib/platform/login-throttle";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { email?: unknown; password?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ error: "Informe e-mail e senha" }, { status: 400 });
  }

  const ip = clientIp(request);
  const wait = loginThrottle.retryAfterSeconds(email, ip);
  if (wait > 0) {
    // Nem chega a consultar o banco: o objetivo é encarecer a tentativa. A
    // mensagem não diz se o e-mail existe — só que houve tentativa demais.
    await logUnauthenticatedAction({ action: "auth.login", entity: "session", result: "blocked", reason: "Tentativas de login em excesso", actorNotApplicable: true });
    return NextResponse.json(
      { error: `Tentativas demais. Tente de novo em ${Math.ceil(wait / 60)} minuto(s).` },
      { status: 429, headers: { "retry-after": String(wait) } },
    );
  }

  let result;
  try {
    result = await login(new DbAuthRepository(await getDb()), email, password);
  } catch {
    return NextResponse.json({ error: "Serviço de autenticação indisponível" }, { status: 503 });
  }

  if (!result) {
    loginThrottle.recordFailure(email, ip);
    // Mensagem única: não revela se o e-mail existe nem se a conta está inativa.
    await logUnauthenticatedAction({ action: "auth.login", entity: "session", result: "failed", reason: "Tentativa de login sem sucesso", actorNotApplicable: true });
    return NextResponse.json({ error: "E-mail ou senha inválidos" }, { status: 401 });
  }

  loginThrottle.clear(email);
  const response = NextResponse.json({ user: result.user, expiresAt: result.expiresAt, mustChangePassword: result.mustChangePassword });
  response.cookies.set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_HOURS * 60 * 60,
  });
  return response;
}
