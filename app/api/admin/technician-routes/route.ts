import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";
import { DbTechnicianRoutesRepository, validateRoutes } from "@/lib/platform/technician-routes-service";

/**
 * Cidade → técnicos (moto/carro) para a OS que a IA abre. GET lista; PUT troca a lista inteira.
 * Exige `users.manage`. A tabela tem nome de funcionário, por isso mora no banco e não no código
 * (o repositório é público). Cada troca vai para a auditoria com quem fez e quantas linhas ficaram.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "users.manage");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  try {
    const routes = await new DbTechnicianRoutesRepository(await getDb()).list();
    return NextResponse.json({ routes });
  } catch {
    return NextResponse.json({ error: "Banco indisponível" }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const guard = await authorize(request, "users.manage");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const body = await request.json().catch(() => null) as { routes?: unknown } | null;
  const checked = validateRoutes(body?.routes);
  if (!checked.ok) return NextResponse.json({ error: checked.reason }, { status: 400 });
  try {
    await new DbTechnicianRoutesRepository(await getDb()).replaceAll(checked.routes, guard.user?.email ?? "desconhecido");
  } catch {
    return NextResponse.json({ error: "Banco indisponível" }, { status: 503 });
  }
  const cities = new Set(checked.routes.map((route) => route.cityId)).size;
  await logUnauthenticatedAction({
    action: "os.technician_routes.replace", entity: "technician_routes", result: "ok", actor: guard.user,
    reason: `Tabela de técnicos da OS pela IA trocada: ${checked.routes.length} linhas em ${cities} cidades.`,
  }).catch(() => undefined);
  return NextResponse.json({ saved: checked.routes.length, cities });
}
