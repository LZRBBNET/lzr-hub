import { NextResponse } from "next/server";
import { runAgentPipeline } from "@/lib/agent/pipeline";
import type { AgentContext, AgentSimulationProfile, ChatMessage } from "@/lib/agent/types";

const profiles = new Set<AgentSimulationProfile>([
  "default", "onu_offline", "pppoe_offline", "optical_critical", "regional_incident",
  "regional_reports_unconfirmed", "diagnostic_inconclusive", "tool_unavailable", "tool_timeout",
  "tool_empty", "tool_error", "tool_contradictory", "wifi_slow", "cable_slow",
  "payment_recognized", "payment_unrecognized", "contract_blocked", "multiple_invoices",
  "multiple_contracts", "ticket_failure", "schedule_unavailable", "action_disabled",
]);

function validHistory(value: unknown): value is ChatMessage[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Record<string, unknown>;
    return (candidate.role === "customer" || candidate.role === "agent")
      && typeof candidate.content === "string"
      && candidate.content.trim().length > 0
      && candidate.content.length <= 5000;
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { message?: unknown; history?: unknown; simulationProfile?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Mensagem inválida" }, { status: 400 });
  if (message.length > 5000) return NextResponse.json({ error: "Mensagem acima do limite" }, { status: 413 });
  if (body?.history !== undefined && !validHistory(body.history)) return NextResponse.json({ error: "Histórico inválido" }, { status: 400 });
  if (body?.simulationProfile !== undefined && (typeof body.simulationProfile !== "string" || !profiles.has(body.simulationProfile as AgentSimulationProfile))) {
    return NextResponse.json({ error: "Perfil de homologação inválido" }, { status: 400 });
  }
  const context: AgentContext = {
    simulationProfile: (body?.simulationProfile as AgentSimulationProfile | undefined) ?? "default",
    channel: "test",
  };
  return NextResponse.json(runAgentPipeline(message, (body?.history ?? []).slice(-40), context));
}
