import { NextResponse } from "next/server";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { summarizeBilling } from "@/lib/platform/billing-service";
import { authorize } from "@/lib/platform/session-guard";

const PERIODS: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30 };

/**
 * Posição financeira real. Sem IXC ligado não existe fonte de fatura nenhuma —
 * a resposta diz indisponível em vez de devolver zero, que seria lido como
 * "ninguém deve nada".
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const period = new URL(request.url).searchParams.get("period") ?? "30d";
  const days = PERIODS[period];
  if (!days) return NextResponse.json({ error: "Período inválido. Use 24h, 7d ou 30d." }, { status: 400 });

  let runtime;
  try { runtime = getIxcRuntime(); } catch { runtime = undefined; }
  if (!runtime?.provider) {
    return NextResponse.json({ available: false, detail: "IXC desligado: sem fonte de faturas", period, summary: null });
  }

  const settled = await Promise.allSettled(runtime.config.ixcAllowlist.map((id) => runtime.provider!.getSnapshot(id, crypto.randomUUID())));
  const snapshots = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const unavailable = settled.length - snapshots.length;
  if (snapshots.length === 0) {
    return NextResponse.json({ available: false, detail: "Nenhum cadastro do IXC respondeu", period, summary: null });
  }

  const summary = summarizeBilling(snapshots, {
    now: new Date(),
    unavailable,
    paymentsSinceIso: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
  });
  return NextResponse.json({ available: true, period, allowlistSize: runtime.config.ixcAllowlist.length, summary });
}
