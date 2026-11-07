import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DbAuthRepository, SESSION_COOKIE, logout } from "@/lib/platform/auth";
import { readSessionToken } from "@/lib/platform/session-guard";

export async function POST(request: Request) {
  let token: string | undefined;
  try {
    token = readSessionToken(request);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
  }
  if (!token) {
    const response = NextResponse.json({ error: "Sessão inválida ou expirada" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
    return response;
  }
  try {
    await logout(new DbAuthRepository(await getDb()), token);
  } catch {
    return NextResponse.json({ error: "Não foi possível confirmar o encerramento da sessão. Tente novamente." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
