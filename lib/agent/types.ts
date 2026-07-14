export type Intent =
  | "technical_no_connection"
  | "technical_slow"
  | "technical_wifi"
  | "financial_invoice"
  | "financial_pix"
  | "financial_unlock"
  | "human_handoff"
  | "general_information";

export type ConversationState = "understanding" | "executing" | "delivered" | "waiting_customer" | "handoff";

export interface ChatMessage { role: "customer" | "agent"; content: string }
export interface ResponseFingerprint { normalizedText:string; intent:Intent; goal:string; actions:string[]; artifacts:string[]; at:string }
export interface PersistedConversationState { activeGoal:string; step:string; collectedData:string[]; pendingQuestion:string|null; suppliedInformation:string[]; promisedActions:string[]; executedActions:string[]; artifacts:string[]; blocker:string|null; nextStep:string; fingerprints:ResponseFingerprint[] }
export interface ToolReceipt { tool: string; status: "completed" | "failed"; summary: string; artifact?: { type: "pix" | "invoice" | "protocol"; label: string; value: string } }
export interface QualityEvaluation {
  score: number;
  naturalness: number;
  precision: number;
  empathy: number;
  safety: number;
  continuity: number;
  memory: number;
  repetitionScore: number;
  noveltyScore: number;
  progressScore: number;
  answeredUserQuestion: boolean;
  unnecessaryQuestion: boolean;
  falseActionClaim: boolean;
  contextContinuity: number;
  suggestion: string;
  idealResponse: string;
}
export interface AgentResult {
  intent: Intent;
  confidence: number;
  goal: string;
  state: ConversationState;
  response: string;
  tools: ToolReceipt[];
  pendingTools: string[];
  conversationSummary: string;
  nextStep: string;
  evaluation: QualityEvaluation;
  conversationState: PersistedConversationState;
  correlationId: string;
}
