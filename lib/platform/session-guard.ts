import { getDb } from "../../db/index.ts";
import { DbAuthRepository, SESSION_COOKIE, resolveSession, type AuthenticatedUser } from "./auth.ts";
import { can } from "./rbac.ts";
import { createSessionFailureReporter, resolveObservedSession } from "./session-diagnostics.ts";

const reportSessionFailure = createSessionFailureReporter(message => console.warn(message));

/**
 * FEATURE_AUTH liga o login na demo. Piloto declarado sempre exige sessão,
 * mesmo com a flag desligada; modo inválido não pode reabrir a demo.
 *
 * Ela nasce desligada de propósito: o ambiente de demonstração publicado é
 * mock-only, sem dado real, e passaria a responder 401 em tudo no instante em
 * que isso subisse. Precisa estar ligada antes de qualquer dado real (M4).
 */
export function authEnforced(): boolean {
  return process.env.FEATURE_AUTH === "true" || (process.env.PILOT_MODE ?? "disabled") !== "disabled";
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
  return resolveObservedSession(
    () => readSessionToken(request),
    async token => resolveSession(new DbAuthRepository(await getDb()), token),
    reportSessionFailure,
  );
}

export type GuardResult =
  | { allowed: true; user?: AuthenticatedUser }
  | { allowed: false; status: 401 | 403; error: string };

/**
 * A demo sem piloto mantém o contrato anterior. No piloto, sessão, participação
 * na allowlist e permissão são requisitos independentes, resolvidos no servidor.
 */
export async function authorize(request: Request, permission: string): Promise<GuardResult> {
  if (!authEnforced()) return { allowed: true };

  const user = await currentUser(request);
  if (!user) return { allowed: false, status: 401, error: "Sessão inválida ou expirada" };
  const pilotMode = process.env.PILOT_MODE ?? "disabled";
  if (pilotMode !== "disabled") {
    const participants = [...new Set((process.env.PILOT_ALLOWED_USER_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean))];
    if (pilotMode !== "internal" || participants.length < 2 || participants.length > 3 || !participants.includes(user.id)) {
      return { allowed: false, status: 403, error: "Acesso ao piloto não autorizado" };
    }
  }
  if (!can(user.role, permission)) return { allowed: false, status: 403, error: "Seu perfil não permite esta ação" };
  return { allowed: true, user };
}

