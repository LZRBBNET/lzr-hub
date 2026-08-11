import { NextResponse } from "next/server";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { MISSING_SIGNALS, SCORE_CAVEATS, buildActionQueue, scoreChurnRisk } from "@/lib/platform/churn-risk-service";
import { authorize } from "@/lib/platform/session-guard";

/**
 * Fila de ação por risco de cancelamento (issue #19, item 3).
 *
 * O desenho existe por um limite duro: pontuar a base inteira exigiria um
 * snapshot por cliente — ~15 mil consultas ao IXC a cada abertura de tela.
 * Então o conjunto de candidatos vem de uma consulta **barata** (a fila de OS
 * abertas, que já é paginada), e só os clientes que aparecem lá recebem a
 * consulta cara.
 *
 * Consequência que a tela precisa declarar: quem nunca abriu chamado não é
 * avaliado. Um cliente pode estar prestes a cancelar por atraso de pagamento
 * sem ter chamado nenhum, e não apareceria aqui. Isso é recorte conhecido, não
 * cobertura completa.
 */
const CANDIDATE_PAGE_SIZE = 100;
const MAX_CUSTOMERS = 12;

export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  const provider = runtime?.provider;
  if (!provider) {
    return NextResponse.json({ available: false, detail: "IXC desligado — sem fonte de chamado nem de fatura", queue: [], missingSignals: MISSING_SIGNALS, caveats: SCORE_CAVEATS });
  }
  if (!runtime?.config.ixcFullBase) {
    return NextResponse.json({ available: false, detail: "Exige leitura da base inteira (FEATURE_IXC_FULL_BASE)", queue: [], missingSignals: MISSING_SIGNALS, caveats: SCORE_CAVEATS });
  }

  const correlationId = crypto.randomUUID();
  try {
    // Candidatos: quem tem OS não fechada. Uma consulta paginada, não uma por cliente.
    const open = await provider.listOpenServiceOrders(1, CANDIDATE_PAGE_SIZE, correlationId);
    const byCustomer = new Map<string, number>();
    for (const order of open.items) byCustomer.set(order.customerId, (byCustomer.get(order.customerId) ?? 0) + 1);

    // Só os com mais chamados entram na consulta cara — é onde o sinal é mais forte.
    const candidates = [...byCustomer.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_CUSTOMERS).map(([id]) => id);

    const settled = await Promise.allSettled(candidates.map((id) => provider.getSnapshot(id, crypto.randomUUID())));
    const risks = settled.flatMap((result) => {
      if (result.status !== "fulfilled") return [];
      const snapshot = result.value;
      return [scoreChurnRisk({
        customerId: snapshot.customer.id,
        tickets: snapshot.serviceOrders.map((order) => ({ subject: order.subject, openedAt: order.openedAt })),
        invoices: snapshot.invoices.map((invoice) => ({ status: invoice.status, dueAt: invoice.dueAt })),
        customerSince: snapshot.customer.customerSince,
      })];
    });

    const unavailable = settled.length - risks.length;
    return NextResponse.json({
      available: true,
      queue: buildActionQueue(risks).map((risk) => ({
        ...risk,
        // O nome vem do snapshot que já foi buscado; não custa consulta extra.
        customerName: settled.flatMap((r) => r.status === "fulfilled" && r.value.customer.id === risk.customerId ? [r.value.customer.name] : [])[0] ?? null,
      })),
      scope: {
        candidatesFromOpenTickets: byCustomer.size,
        scored: risks.length,
        unavailable,
        detail: "Só clientes com ordem de serviço aberta são avaliados — quem nunca abriu chamado não entra nesta fila.",
      },
      missingSignals: MISSING_SIGNALS,
      caveats: SCORE_CAVEATS,
    });
  } catch {
    return NextResponse.json({ available: false, detail: "Consulta ao IXC indisponível", queue: [], missingSignals: MISSING_SIGNALS, caveats: SCORE_CAVEATS });
  }
}
