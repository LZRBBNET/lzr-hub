import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { listUsers } from "@/lib/platform/auth";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";
import {
  DbUserAdminRepository, UserAdminError, createUser, parseNewUser, resetPassword, setActive, setRole,
} from "@/lib/platform/user-admin";

/** Contas reais do LZR HUB. */
export async function GET(request: Request) {
  const guard = await authorize(request, "users.manage");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  try {
    return NextResponse.json({ available: true, users: await listUsers(await getDb()) });
  } catch {
    return NextResponse.json({ available: false, detail: "Lista de usuários indisponível", users: [] });
  }
}

/**
 * Criar, desativar, trocar perfil e resetar senha.
 *
 * Exige ator identificado mesmo que a exigência de login esteja desligada:
 * conceder e revogar acesso sem saber quem está agindo não pode acontecer, e as
 * travas contra auto-bloqueio dependem de saber quem é você.
 *
 * A senha gerada volta na resposta uma única vez e **nunca** entra na
 * auditoria — o motivo registrado descreve a ação, não o segredo.
 */
export async function POST(request: Request) {
  const guard = await authorize(request, "users.manage");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!guard.user) return NextResponse.json({ error: "Gestão de contas exige sessão identificada (FEATURE_AUTH)" }, { status: 403 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });
  const targetId = typeof body.id === "string" ? body.id : "";

  try {
    const repository = new DbUserAdminRepository(await getDb());

    if (body.action === "create") {
      const input = parseNewUser(body);
      const { user, password } = await createUser(repository, input);
      await logUnauthenticatedAction({ action: "users.create", entity: `user:${user.id}`, result: "success", reason: `Conta criada para ${user.email} com perfil ${user.role}`, actor: guard.user });
      return NextResponse.json({ user, password }, { status: 201 });
    }
    if (body.action === "set-active") {
      const active = body.active === true;
      const user = await setActive(repository, guard.user, targetId, active);
      await logUnauthenticatedAction({ action: active ? "users.activate" : "users.deactivate", entity: `user:${targetId}`, result: "success", reason: `${active ? "Reativação" : "Desativação"} da conta ${user.email}`, actor: guard.user });
      return NextResponse.json(user);
    }
    if (body.action === "set-role") {
      const user = await setRole(repository, guard.user, targetId, typeof body.role === "string" ? body.role : "");
      await logUnauthenticatedAction({ action: "users.set-role", entity: `user:${targetId}`, result: "success", reason: `Perfil de ${user.email} alterado para ${user.role}`, actor: guard.user });
      return NextResponse.json(user);
    }
    if (body.action === "reset-password") {
      const { user, password } = await resetPassword(repository, targetId);
      await logUnauthenticatedAction({ action: "users.reset-password", entity: `user:${targetId}`, result: "success", reason: `Senha redefinida para ${user.email}`, actor: guard.user });
      return NextResponse.json({ user, password });
    }
    return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
  } catch (error) {
    if (error instanceof UserAdminError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "Gestão de contas indisponível" }, { status: 503 });
  }
}
