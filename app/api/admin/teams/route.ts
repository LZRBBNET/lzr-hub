import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { listUsers } from "@/lib/platform/auth";
import {
  DbTeamsRepository, TeamValidationError, parseTeamInput, summarizeTeamLoad, unclaimedReasons,
} from "@/lib/platform/teams-service";
import { authorize } from "@/lib/platform/session-guard";

const PERIODS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

/**
 * Equipes de atendimento e a carga medida de cada uma.
 *
 * Gerenciar equipe é ato administrativo: exige `users.manage`, o mesmo perfil
 * que cria conta. Ler exige apenas `customer.read`, para que a operação possa
 * consultar quem atende o quê.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const period = new URL(request.url).searchParams.get("period") ?? "7d";
  const days = PERIODS[period];
  if (!days) return NextResponse.json({ error: "Período inválido. Use 7d, 30d ou 90d." }, { status: 400 });

  try {
    const db = await getDb();
    const repository = new DbTeamsRepository(db);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const [list, counts, people] = await Promise.all([
      repository.list(),
      repository.loadSince(since),
      // A tela precisa da lista de gente para vincular; são contas reais.
      // `listUsers` recebe a instância do banco, não um repositório.
      listUsers(db),
    ]);
    return NextResponse.json({
      available: true, period, teams: list,
      load: summarizeTeamLoad(list, counts),
      unclaimed: unclaimedReasons(list, counts),
      totalHandoffs: counts.reduce((sum, row) => sum + row.count, 0),
      people: people.map((person) => ({ id: person.id, name: person.name, email: person.email, role: person.role, active: person.active })),
    });
  } catch {
    // "não configurado" mandaria alguém conferir variável de ambiente à toa: a
    // causa mais comum é o banco não responder, não faltar configuração.
    return NextResponse.json({ available: false, detail: "Equipes indisponíveis: o banco não respondeu", period, teams: [], load: [], unclaimed: [], totalHandoffs: 0, people: [] });
  }
}

export async function POST(request: Request) {
  const guard = await authorize(request, "users.manage");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });

  const action = String(body.action ?? "create");
  try {
    const repository = new DbTeamsRepository(await getDb());

    if (action === "add-member" || action === "remove-member") {
      const teamId = String(body.teamId ?? "");
      const userId = String(body.userId ?? "");
      if (!teamId || !userId) return NextResponse.json({ error: "Equipe e pessoa são obrigatórias" }, { status: 400 });
      const done = action === "add-member" ? await repository.addMember(teamId, userId) : await repository.removeMember(teamId, userId);
      if (!done) return NextResponse.json({ error: action === "add-member" ? "A pessoa já está nesta equipe" : "A pessoa não está nesta equipe" }, { status: 409 });
      await logUnauthenticatedAction({
        action: `team.member.${action === "add-member" ? "add" : "remove"}`, entity: `team:${teamId}`, result: "success",
        reason: `${action === "add-member" ? "Vínculo criado" : "Vínculo removido"} para a conta ${userId}`, actor: guard.user,
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "set-active") {
      const id = String(body.id ?? "");
      const active = body.active === true;
      if (!await repository.setActive(id, active)) return NextResponse.json({ error: "Equipe não encontrada" }, { status: 404 });
      await logUnauthenticatedAction({
        action: "team.set-active", entity: `team:${id}`, result: "success",
        reason: active ? "Equipe reativada" : "Equipe desativada", actor: guard.user,
      });
      return NextResponse.json({ ok: true });
    }

    const input = parseTeamInput(body);
    if (action === "update") {
      const id = String(body.id ?? "");
      const updated = await repository.update(id, input);
      if (!updated) return NextResponse.json({ error: "Equipe não encontrada" }, { status: 404 });
      await logUnauthenticatedAction({
        action: "team.update", entity: `team:${id}`, result: "success",
        reason: `Equipe "${input.name}" atualizada (fila ${input.queue}, ${input.handoffReasons.length} motivo(s))`, actor: guard.user,
      });
      return NextResponse.json(updated);
    }

    const created = await repository.create(input);
    await logUnauthenticatedAction({
      action: "team.create", entity: `team:${created.id}`, result: "success",
      reason: `Equipe "${created.name}" criada na fila ${created.queue}`, actor: guard.user,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof TeamValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Não foi possível salvar a equipe" }, { status: 503 });
  }
}
