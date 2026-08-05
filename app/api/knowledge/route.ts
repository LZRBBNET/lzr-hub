import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { DbKnowledgeRepository, KnowledgeValidationError, parseKnowledgeInput, searchDocuments } from "@/lib/platform/knowledge-service";
import { authorize } from "@/lib/platform/session-guard";

const LIST_LIMIT = 200;

export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const query = new URL(request.url).searchParams.get("q");
  try {
    const documents = await new DbKnowledgeRepository(await getDb()).list(LIST_LIMIT);
    return NextResponse.json(query ? { available: true, results: searchDocuments(documents, query) } : { available: true, items: documents });
  } catch {
    // Sem banco não há base de conhecimento — dizer isso é melhor do que devolver
    // lista vazia, que se leria como "nenhum documento cadastrado".
    return NextResponse.json({ available: false, detail: "Base de conhecimento indisponível", items: [], results: [] });
  }
}

export async function POST(request: Request) {
  const guard = await authorize(request, "knowledge.publish");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Solicitação inválida" }, { status: 400 });

  try {
    const repository = new DbKnowledgeRepository(await getDb());

    if (body.action === "publish") {
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) return NextResponse.json({ error: "Informe o documento" }, { status: 400 });
      const published = await repository.publish(id);
      await logUnauthenticatedAction({ action: "knowledge.publish", entity: `document:${id}`, result: published ? "success" : "not_found", reason: "Publicação de documento de conhecimento", actor: guard.user });
      return published ? NextResponse.json(published) : NextResponse.json({ error: "Documento não encontrado" }, { status: 404 });
    }

    if (body.action === "ingest") {
      const created = await repository.create(parseKnowledgeInput(body));
      await logUnauthenticatedAction({ action: "knowledge.ingest", entity: `document:${created.id}`, result: "success", reason: `Ingestão de rascunho: "${created.title}"`, actor: guard.user });
      return NextResponse.json(created, { status: 201 });
    }

    return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
  } catch (error) {
    if (error instanceof KnowledgeValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "Base de conhecimento indisponível" }, { status: 503 });
  }
}
