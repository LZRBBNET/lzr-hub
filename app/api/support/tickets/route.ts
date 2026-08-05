import { NextResponse } from "next/server";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { authorize } from "@/lib/platform/session-guard";

/**
 * Chamados reais são as ordens de serviço do IXC. O ERP não deixa listar a base
 * inteira sob a allowlist de homologação, então a fila mostra as OS dos
 * cadastros liberados — e diz isso, em vez de dar a impressão de ser a fila toda.
 *
 * Reaproveita o snapshot já cacheado do Customer 360: abrir esta tela não
 * dispara uma nova rajada de chamadas ao IXC.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) {
    return NextResponse.json({ available: false, detail: "IXC desligado: sem fonte de chamados", scope: "none", items: [] });
  }

  // Base liberada: a fila é paginada direto no IXC. Percorrer 27 mil cadastros
  // para montar a fila seria impossível, e mostrar só a allowlist daria a
  // impressão de que o provedor tem 48 chamados.
  if (runtime.config.ixcFullBase) {
    const url = new URL(request.url);
    const page = Math.max(Number(url.searchParams.get("page") ?? 1) || 1, 1);
    try {
      const result = await runtime.provider.listOpenServiceOrders(page, 25, crypto.randomUUID());
      return NextResponse.json({
        available: true, scope: "full-base", total: result.total, page: result.page, pageSize: result.pageSize,
        items: result.items.map((order) => ({
          id: order.id, customerId: order.customerId, customerName: null,
          city: null, address: order.address ?? null, subject: order.subject,
          status: order.status, openedAt: order.openedAt ?? null, closedAt: order.closedAt ?? null,
        })),
      });
    } catch {
      return NextResponse.json({ available: false, detail: "Fila de chamados do IXC indisponível", scope: "full-base", items: [] });
    }
  }

  const ids = runtime.config.ixcAllowlist;
  const settled = await Promise.allSettled(ids.map((id) => runtime.provider!.getSnapshot(id, crypto.randomUUID())));
  const items = settled.flatMap((result) => {
    if (result.status !== "fulfilled") return [];
    const snapshot = result.value;
    return snapshot.serviceOrders.map((order) => ({
      id: order.id,
      customerId: snapshot.customer.id,
      customerName: snapshot.customer.name,
      city: snapshot.customer.city,
      subject: order.subject,
      status: order.status,
      openedAt: order.openedAt ?? null,
      closedAt: order.closedAt ?? null,
    }));
  });
  // Mais recente primeiro; OS sem data de abertura vai para o fim em vez de sumir.
  items.sort((a, b) => (b.openedAt ?? "").localeCompare(a.openedAt ?? ""));

  const failed = settled.filter((result) => result.status === "rejected").length;
  return NextResponse.json({
    available: true,
    scope: "allowlist",
    allowlistSize: ids.length,
    unavailableCustomers: failed,
    items,
  });
}
