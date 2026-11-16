import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { openServiceOrder } from "@/lib/integrations/ixc/write-client";
import { DbIxcWriteOperationsRepository, requestServiceOrderOpen, serviceOrderLedgerResult } from "@/lib/platform/ixc-write-service";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";

/** Fechada é `F`; qualquer outro status conta como aberta para a regra de repetição. */
const CLOSED_STATUS = "F";

/**
 * Abertura de ordem de serviço no IXC (issue #20, segunda operação do catálogo).
 *
 * O GET devolve o catálogo real do ERP — 159 assuntos e 12 setores na base da
 * BBNET. Ele existe porque a tela **não pode** oferecer uma lista inventada:
 * quem escolhe o assunto está escolhendo qual fila recebe o chamado.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const key = new URL(request.url).searchParams.get("idempotencyKey");
  if (key) {
    const writeGuard = await authorize(request, "ixc.write");
    if (!writeGuard.allowed) return NextResponse.json({ error: writeGuard.error }, { status: writeGuard.status });
    if (!writeGuard.user?.email) return NextResponse.json({ error: "Sessão autenticada obrigatória" }, { status: 401 });
    const row = await new DbIxcWriteOperationsRepository(await getDb()).findByIdempotencyKey("service_order.open", key);
    if (!row || row.requestedBy !== writeGuard.user?.email) return NextResponse.json({ status: "unknown", detail: "Resultado não localizado para este operador. Não reenviar; confira a operação com o administrador." }, { headers: { "Cache-Control": "no-store" } });
    const result = serviceOrderLedgerResult(row);
    if (result.status === "success" && result.serviceOrderId && result.contractId) {
      try {
        const provider = getIxcRuntime().provider;
        if (!provider) throw new Error("IXC_UNAVAILABLE");
        const order = await provider.reconcileServiceOrder(row.customerId, result.contractId, result.serviceOrderId, randomUUID());
        return NextResponse.json({ ...result, order, remoteMatch: true, correlationId: row.correlationId }, { headers: { "Cache-Control": "no-store" } });
      } catch {
        return NextResponse.json({ status: "unknown", remoteMatch: false, detail: "Não foi possível confirmar OS, cliente e contrato no IXC. Não reenviar." }, { headers: { "Cache-Control": "no-store" } });
      }
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  }

  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) {
    return NextResponse.json({ available: false, detail: "IXC desligado — sem catálogo de assuntos e setores", subjects: [], sectors: [] });
  }

  const correlationId = randomUUID();
  try {
    const [subjects, sectors] = await Promise.all([
      runtime.provider.listOsSubjects(correlationId),
      runtime.provider.listSectors(correlationId),
    ]);
    return NextResponse.json({ available: true, subjects, sectors, writeEnabled: process.env.FEATURE_IXC_WRITE === "true" });
  } catch {
    // Sem catálogo, a tela não deve deixar abrir OS. Lista vazia com aviso é
    // melhor do que uma lista de exemplo que produziria chamado na fila errada.
    return NextResponse.json({ available: false, detail: "O IXC não devolveu o catálogo de assuntos e setores", subjects: [], sectors: [] });
  }
}

export async function POST(request: Request) {
  const guard = await authorize(request, "ixc.write");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  if (!guard.user?.email) return NextResponse.json({ error: "Sessão autenticada obrigatória" }, { status: 401 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const text = (key: string) => typeof body?.[key] === "string" ? (body[key] as string).trim() : "";
  const customerId = text("customerId");
  const contractId = text("contractId");
  const subjectId = text("subjectId");
  const sectorId = text("sectorId");
  const message = text("message");
  const idempotencyKey = text("idempotencyKey");
  // Preserve the existing collection value. Official wiki uses N instead of 1;
  // equivalence is unresolved and must be checked before a real pilot write.
  const priority = text("priority") || "1";
  if (!customerId || !/^[1-9]\d{0,31}$/.test(contractId) || !subjectId || !sectorId || !idempotencyKey) {
    return NextResponse.json({ error: "Campos obrigatórios: customerId, contractId (contrato selecionado), subjectId, sectorId, idempotencyKey" }, { status: 400 });
  }

  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) return NextResponse.json({ error: "IXC indisponível — sem fonte para confirmar o cadastro" }, { status: 503 });

  const correlationId = randomUUID();
  // Tudo que a política usa é relido do IXC agora: filial do cliente, catálogo
  // e OS já abertas. Aceitar qualquer um deles do corpo deixaria quem chama
  // contornar a regra dizendo o que lhe convém.
  const [snapshot, subjects, sectors, confirmedContract] = await Promise.all([
    runtime.provider.getSnapshot(customerId, correlationId).catch(() => null),
    runtime.provider.listOsSubjects(correlationId).catch(() => null),
    runtime.provider.listSectors(correlationId).catch(() => null),
    runtime.provider.getServiceOrderContract(customerId, contractId, correlationId).catch(() => null),
  ]);
  if (!confirmedContract) return NextResponse.json({ error: "Contrato ativo pertencente ao cliente não confirmado no IXC" }, { status: 409 });
  if (!snapshot) return NextResponse.json({ error: "Cadastro não encontrado no IXC" }, { status: 404 });
  if (!subjects || !sectors) return NextResponse.json({ error: "O IXC não devolveu o catálogo — não dá para validar assunto e setor" }, { status: 503 });

  const openSubjects = new Set(
    snapshot.serviceOrders.filter((order) => order.status !== CLOSED_STATUS).map((order) => order.subject),
  );
  const subjectName = subjects.find((item) => item.id === subjectId)?.name ?? "";
  // O snapshot traz o **nome** do assunto na OS, não o id. Comparar pelo nome é
  // o que dá para fazer com o dado que existe — e é por isso que a regra de
  // repetição é uma barreira a mais, não a única.
  const alreadyOpen = new Set(subjectName && openSubjects.has(subjectName) ? [subjectId] : []);

  const result = await requestServiceOrderOpen(
    {
      customerId, contractId, confirmedContract, subjectId, sectorId, priority, message, idempotencyKey, correlationId,
      branchId: snapshot.customer.branchId,
      requestedBy: guard.user?.email ?? "não identificado",
      knownSubjectIds: new Set(subjects.map((item) => item.id)),
      knownSectorIds: new Set(sectors.map((item) => item.id)),
      openSubjects: alreadyOpen,
    },
    new DbIxcWriteOperationsRepository(await getDb()),
    (corr) => openServiceOrder(
      { baseUrl: runtime.config.ixcBaseUrl!, token: runtime.config.ixcToken! },
      { customerId, contractId, subjectId, sectorId, branchId: snapshot.customer.branchId ?? "", priority, message },
      corr,
    ),
  );

  await logUnauthenticatedAction({
    action: "ixc.write.service_order_open", entity: `customer:${customerId}`, result: result.status,
    reason: `Abertura de OS (assunto ${subjectId}${subjectName ? ` — ${subjectName}` : ""}): ${result.detail}`,
    correlationId, actor: guard.user,
  });

  return NextResponse.json(result, { status: result.status === "success" ? 201 : 200 });
}
