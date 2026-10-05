import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { authorize } from "@/lib/platform/session-guard";

/**
 * Quem é o cliente desta conversa no IXC, pelo telefone.
 *
 * A regra é a de `findCustomerByPhone`: **exatamente um cadastro, ou nada**.
 * Buscar pelo final do número trouxe quatro clientes diferentes na base real, e
 * identificar o cliente errado é pior que não identificar.
 *
 * Fica numa rota separada da conversa de propósito: a conversa é atualizada a
 * cada poucos segundos, e o IXC tem limite de consultas por minuto. Esta é
 * chamada uma vez, quando o atendente abre a conversa.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const phone = (new URL(request.url).searchParams.get("id") ?? "").trim();
  if (!/^\d{10,15}$/.test(phone)) return NextResponse.json({ error: "Informe o telefone da conversa" }, { status: 400 });

  const runtime = getIxcRuntime();
  if (!runtime.provider) return NextResponse.json({ available: false, detail: "Integração com o IXC desligada neste ambiente." });

  try {
    const customer = await runtime.provider.findCustomerByPhone(phone, randomUUID());
    // Só o necessário para reconhecer o cliente. Documento, e-mail e endereço
    // completo ficam na tela de Clientes, que tem as próprias regras.
    return NextResponse.json({
      available: true,
      customer: customer ? {
        id: customer.id,
        name: customer.name,
        // O IXC guarda `ativo` como S/N.
        status: customer.status === "S" ? "Ativo" : customer.status === "N" ? "Inativo" : customer.status,
        // `cidade` costuma vir como código interno do IXC ("1759"), não como nome.
        // Mostrar o código seria pior que não mostrar.
        city: /^\d+$/.test(customer.city) ? "" : customer.city,
        neighborhood: customer.neighborhood,
      } : null,
    });
  } catch {
    return NextResponse.json({ available: false, detail: "O IXC não respondeu agora." });
  }
}
