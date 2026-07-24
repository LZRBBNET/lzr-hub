import type { ChatMessage, HandoffDecision, Intent, ToolReceipt } from "./types.ts";
import { isFailedReceipt } from "./tool-engine.ts";

const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function sanitizeHandoffText(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[EMAIL REDACTED]")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[DOCUMENTO REDACTED]")
    .replace(/\b(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}\b/g, "[TELEFONE REDACTED]");
}

function summary(message: string, intent: Intent, tools: ToolReceipt[], reason: string): string {
  const results = tools.map((tool) => `${tool.tool}: ${tool.outcome}`).join(", ") || "nenhuma ferramenta";
  return sanitizeHandoffText(
    `Problema: ${message.slice(0, 240)}. Intenção: ${intent}. Verificações: ${results}. Motivo: ${reason}. Próxima ação: revisão humana segura.`,
  );
}

export function decideHandoff(input: {
  message: string;
  intent: Intent;
  confidence: number;
  tools: ToolReceipt[];
  history: ChatMessage[];
  repeatedWithoutResolution: boolean;
}): HandoffDecision {
  const text = normalize(input.message);
  let reason: string | null = null;
  if (input.intent === "human_handoff") reason = "customer_requested_human";
  else if (input.intent === "complaint") reason = "formal_complaint";
  else if (input.intent === "cancellation_risk") reason = "cancellation_risk";
  else if (input.intent === "unauthorized_request") reason = "unauthorized_request";
  else if (input.intent === "financial_unlock") reason = "sensitive_action";
  else if (input.confidence < 0.6) reason = "low_intent_confidence";
  else if (input.repeatedWithoutResolution) reason = "repetition_without_resolution";
  else if (/idiota|incompetente|raiva|absurdo|porcaria|processo|anatel/.test(text)) reason = "customer_irritated";
  else if (isFailedReceipt(input.tools.find((tool) => tool.outcome === "partial") ?? input.tools.find(isFailedReceipt) ?? ({ status: "completed", outcome: "success" } as ToolReceipt))) {
    const failed = input.tools.find(isFailedReceipt);
    reason = failed?.outcome === "forbidden" ? "action_forbidden" : failed?.outcome === "partial" ? "contradictory_or_partial_data" : "required_tool_failed";
  }
  return {
    required: reason !== null,
    reason,
    summary: reason ? summary(input.message, input.intent, input.tools, reason) : null,
  };
}
