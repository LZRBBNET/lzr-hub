import { sanitizeTelemetry } from "../integrations/ixc/masking.ts";
import { getObservabilityProvider } from "./runtime.ts";
import type { AgentResult } from "../agent/types.ts";

/**
 * Manda um rastro do atendimento pro Langfuse — nunca a mensagem do cliente
 * nem a resposta da IA (podem conter dado pessoal digitado por alguém).
 * Só campos estruturados: intenção, ferramentas usadas (nome + resultado,
 * sem o resumo em texto livre), desfecho, transbordo e notas de qualidade.
 *
 * Best-effort: nunca lança. Uma falha aqui não pode derrubar a resposta ao
 * cliente nem o teste que chamou o pipeline.
 */
export async function traceAgentResult(
  result: AgentResult,
  context: { channel: string; correlationId: string },
): Promise<void> {
  const provider = getObservabilityProvider();
  if (!provider) return;
  try {
    const attributes = sanitizeTelemetry({
      channel: context.channel,
      intent: result.intent,
      confidence: result.confidence,
      state: result.state,
      finalStatus: result.finalStatus,
      actionExecuted: result.actionExecuted,
      simulationOnly: result.simulationOnly,
      handoffRequired: result.handoff.required,
      handoffReason: result.handoff.reason,
      safetyAlerts: result.safetyAlerts,
      tools: result.tools.map((tool) => ({ tool: tool.tool, outcome: tool.outcome, realAction: tool.realAction, simulated: tool.simulated })),
      evidenceCount: result.evidence.length,
      qualityScore: result.evaluation.score,
    }) as Record<string, unknown>;
    await provider.trace("agent.pipeline", attributes);
  } catch {
    // Observabilidade é best-effort; nunca pode quebrar o atendimento.
  }
}
