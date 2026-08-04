import { NextResponse } from "next/server";
import { runAgentPipeline } from "@/lib/agent/pipeline";
import type { ChatMessage } from "@/lib/agent/types";
import { traceAgentResult } from "@/lib/observability/trace-agent-result";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";

const protectedBodyFields = new Set([
  "simulationProfile",
  "simulation_profile",
  "channel",
  "environment",
  "agentContext",
  "internalContext",
  "origin",
  "role",
]);

const protectedQueryFields = new Set([
  "simulationprofile",
  "simulation_profile",
  "channel",
  "environment",
  "agentcontext",
  "internalcontext",
  "origin",
  "role",
]);

const protectedHeaders = [
  "x-agent-simulation-profile",
  "x-simulation-profile",
  "x-agent-channel",
  "x-internal-channel",
  "x-lzr-channel",
  "x-agent-context",
];

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

function hasUntrustedOperationalContext(
  request: Request,
  body: Record<string, unknown> | null,
): boolean {
  if (body && [...protectedBodyFields].some((field) => Object.hasOwn(body, field))) return true;
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => protectedQueryFields.has(key.toLowerCase()))) return true;
  return protectedHeaders.some((header) => request.headers.has(header));
}

export async function POST(request: Request) {
  const guard = await authorize(request, "customer.read");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const parsed = await request.json().catch(() => null) as unknown;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;

  if (hasUntrustedOperationalContext(request, body)) {
    return NextResponse.json(
      { error: "Contexto operacional não autorizado", errorCode: "UNTRUSTED_AGENT_CONTEXT" },
      { status: 403 },
    );
  }

  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "Mensagem inválida" }, { status: 400 });
  if (message.length > 5000) return NextResponse.json({ error: "Mensagem acima do limite" }, { status: 413 });
  if (body?.history !== undefined && !validHistory(body.history)) return NextResponse.json({ error: "Histórico inválido" }, { status: 400 });

  const result = runAgentPipeline(
    message,
    ((body?.history as ChatMessage[] | undefined) ?? []).slice(-40),
    { channel: "web" },
  );

  // A mensagem em si não entra no rastro: só intenção e desfecho, já sem dado pessoal.
  await logUnauthenticatedAction({
    action: "agent.message.processed",
    entity: "conversation:web",
    result: result.finalStatus,
    reason: `Intenção: ${result.intent}. ${result.handoff.required ? "Transbordo solicitado." : "Resolvido pela IA."}`,
    correlationId: result.correlationId,
    actor: guard.user,
  });
  await traceAgentResult(result, { channel: "web", correlationId: result.correlationId });

  return NextResponse.json(result);
}
