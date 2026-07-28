import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DbAuthRepository, SESSION_COOKIE, logout } from "@/lib/platform/auth";
import { readSessionToken } from "@/lib/platform/session-guard";

export async function POST(request: Request) {
  try {
    await logout(new DbAuthRepository(await getDb()), readSessionToken(request));
  } catch {
    // Mesmo se o banco falhar, o cookie é limpo abaixo: o usuário sai de qualquer forma.
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
