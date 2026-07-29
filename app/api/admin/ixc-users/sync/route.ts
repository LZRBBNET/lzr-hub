import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { fetchIxcSystemUsers } from "@/lib/integrations/ixc/system-users";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { DbUserProvisioningRepository, parseGroupRoleMap, syncIxcUsers } from "@/lib/platform/ixc-user-sync";
import { authorize } from "@/lib/platform/session-guard";

export async function POST(request: Request) {
  const guard = await authorize(request, "users.manage");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const baseUrl = process.env.IXC_BASE_URL;
  const token = process.env.IXC_API_TOKEN;
  if (!baseUrl || !token) {
    return NextResponse.json({ error: "Integração IXC não configurada (IXC_BASE_URL e IXC_API_TOKEN)" }, { status: 503 });
  }

  try {
    const ixcUsers = await fetchIxcSystemUsers({ baseUrl, token });
    const summary = await syncIxcUsers(ixcUsers, new DbUserProvisioningRepository(await getDb()), {
      groupRoles: parseGroupRoleMap(process.env.IXC_GROUP_ROLE_MAP),
      protectedEmails: (process.env.IXC_SYNC_PROTECTED_EMAILS ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    });
    await logUnauthenticatedAction({
      action: "users.sync.ixc", entity: "users",
      result: "success", reason: `Sincronização de usuários do IXC: ${summary.created} criados, ${summary.updated} atualizados, ${summary.deactivated} desativados`,
      actor: guard.user,
    });
    return NextResponse.json(summary);
  } catch (error) {
    await logUnauthenticatedAction({
      action: "users.sync.ixc", entity: "users", result: "failed",
      reason: "Falha ao sincronizar usuários do IXC", actor: guard.user,
    });
    return NextResponse.json(
      { error: "Não foi possível consultar o IXC", detail: error instanceof Error ? error.message : "desconhecido" },
      { status: 503 },
    );
  }
}
