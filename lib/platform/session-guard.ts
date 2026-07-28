import { getDb } from "../../db/index.ts";
import { DbAuthRepository, SESSION_COOKIE, resolveSession, type AuthenticatedUser } from "./auth.ts";
import { can } from "./rbac.ts";

/**
 * A exigência de login é ligada por FEATURE_AUTH.
 *
 * Ela nasce desligada de propósito: o ambiente de demonstração publicado é
 * mock-only, sem dado real, e passaria a responder 401 em tudo no instante em
 * que isso subisse. Precisa estar ligada antes de qualquer dado real (M4).
 */
export function authEnforced(): boolean {
  return process.env.FEATURE_AUTH === "true";
}

export function readSessionToken(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export async function currentUser(request: Request): Promise<AuthenticatedUser | undefined> {
  try {
    return await resolveSession(new DbAuthRepository(await getDb()), readSessionToken(request));
  } catch {
    // Sem banco disponível não há sessão para resolver; quem chama decide o que fazer.
    return undefined;
  }
}

export type GuardResult =
  | { allowed: true; user?: AuthenticatedUser }
  | { allowed: false; status: 401 | 403; error: string };

/**
 * Autoriza a ação. Com FEATURE_AUTH desligada libera e devolve `user: undefined`
 * (a auditoria registra como não identificado, como já fazia).
 */
export async function authorize(request: Request, permission: string): Promise<GuardResult> {
  if (!authEnforced()) return { allowed: true };

  const user = await currentUser(request);
  if (!user) return { allowed: false, status: 401, error: "Sessão inválida ou expirada" };
  if (!can(user.role, permission)) return { allowed: false, status: 403, error: "Seu perfil não permite esta ação" };
  return { allowed: true, user };
}
