import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { createCustomer } from "@/lib/integrations/ixc/write-client";
import { DbIxcWriteOperationsRepository, requestCustomerCreate } from "@/lib/platform/ixc-write-service";
import { DbCrmRepository } from "@/lib/platform/crm-service";
import { checkDocument } from "@/lib/platform/document-check";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";

/**
 * Cadastra no IXC o cliente que um lead ganho virou (issue #20, quarta e última
 * operação do catálogo).
 *
 * Esta operação estava parada por falta de **gatilho legítimo**: sem CRM, um
 * cadastro novo não teria de onde vir, e cadastrar cliente sem origem de venda
 * cria duplicata. Com o funil da issue #17 de pé, a origem existe — é um lead
 * que chegou a "Ganho".
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const ufId = new URL(request.url).searchParams.get("uf")?.trim() ?? "";
  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) return NextResponse.json({ available: false, detail: "IXC desligado — sem catálogo de cidades", ufs: [], cities: [] });

  const correlationId = randomUUID();
  try {
    const ufs = await runtime.provider.listUfs(correlationId);
    // Cidade só depois de escolher a UF: são milhares no país inteiro, e uma
    // lista dessas na tela é lista que ninguém lê.
    const cities = ufId ? await runtime.provider.listCities(ufId, correlationId) : [];
    return NextResponse.json({ available: true, ufs, cities, writeEnabled: process.env.FEATURE_IXC_WRITE === "true" });
  } catch {
    return NextResponse.json({ available: false, detail: "O IXC não devolveu o catálogo de cidades", ufs: [], cities: [] });
  }
}

export async function POST(request: Request) {
  const guard = await authorize(request, "ixc.write");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const text = (key: string) => typeof body?.[key] === "string" ? (body[key] as string).trim() : "";
  const leadId = text("leadId");
  const document = text("document");
  const cityId = text("cityId");
  const ufId = text("ufId");
  const idempotencyKey = text("idempotencyKey");
  if (!leadId || !document || !cityId || !ufId || !idempotencyKey) {
    return NextResponse.json({ error: "Campos obrigatórios: leadId, document, ufId, cityId, idempotencyKey" }, { status: 400 });
  }

  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) return NextResponse.json({ error: "IXC indisponível — sem como checar duplicata" }, { status: 503 });

  const crm = new DbCrmRepository(await getDb());
  const lead = await crm.get(leadId);
  if (!lead) return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });

  const correlationId = randomUUID();
  const checked = checkDocument(document);
  // A duplicata é checada contra o IXC **agora**, não contra o que a tela sabia.
  // Só faz sentido perguntar se o documento é válido — número inválido nunca
  // acharia nada e o "não existe" seria falso conforto.
  const [existing, cities] = await Promise.all([
    checked.valid ? runtime.provider.findCustomerByDocument(document, correlationId).catch(() => undefined) : Promise.resolve(undefined),
    runtime.provider.listCities(ufId, correlationId).catch(() => null),
  ]);
  if (!cities) return NextResponse.json({ error: "O IXC não devolveu as cidades — não dá para validar o endereço" }, { status: 503 });

  const street = text("street");
  const number = text("number");
  const cep = text("cep");
  const name = text("name") || lead.name;
  const neighborhood = text("neighborhood") || lead.neighborhood;

  const result = await requestCustomerCreate(
    {
      leadId, idempotencyKey, correlationId,
      requestedBy: guard.user?.email ?? "não identificado",
      policy: {
        documentValid: checked.valid,
        existingCustomerId: existing?.id,
        leadStage: lead.stage,
        leadAlreadyLinked: lead.ixcCustomerId,
        cityId, knownCityIds: new Set(cities.map((city) => city.id)),
        street, number, cep,
      },
    },
    new DbIxcWriteOperationsRepository(await getDb()),
    (corr) => createCustomer(
      { baseUrl: runtime.config.ixcBaseUrl!, token: runtime.config.ixcToken! },
      {
        name, document: checked.masked ?? document, personKind: checked.kind ?? "F",
        cep, street, number, neighborhood, cityId, ufId,
        phone: text("phone"), email: text("email"),
      },
      corr,
    ),
    (customerId) => crm.linkCustomer(leadId, customerId),
  );

  await logUnauthenticatedAction({
    action: "ixc.write.customer_create", entity: `lead:${leadId}`, result: result.status,
    // Sem o documento na auditoria: ela é lida por quem não participou da venda.
    reason: `Cadastro de cliente a partir de lead ganho: ${result.detail}`,
    correlationId, actor: guard.user,
  });

  return NextResponse.json(result, { status: result.status === "success" ? 201 : 200 });
}
