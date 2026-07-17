export type Intent =
  | "technical_no_connection"
  | "technical_slow"
  | "technical_wifi"
  | "technical_restart"
  | "technical_ticket"
  | "technical_visit"
  | "financial_invoice"
  | "financial_pix"
  | "financial_payment"
  | "financial_unlock"
  | "complaint"
  | "cancellation_risk"
  | "human_handoff"
  | "unauthorized_request"
  | "out_of_scope"
  | "general_information";

export type ConversationState =
  | "understanding"
  | "executing"
  | "delivered"
  | "waiting_customer"
  | "handoff"
  | "blocked";

export type ToolOutcome =
  | "success"
  | "simulated"
  | "partial"
  | "unavailable"
  | "timeout"
  | "forbidden"
  | "invalid"
  | "not_found"
  | "requires_human"
  | "error";

export type AgentFinalStatus =
  | "resolved"
  | "simulated"
  | "waiting_customer"
  | "handoff"
  | "blocked"
  | "failed";

export type AgentSimulationProfile =
  | "default"
  | "onu_offline"
  | "pppoe_offline"
  | "optical_critical"
  | "regional_incident"
  | "regional_reports_unconfirmed"
  | "diagnostic_inconclusive"
  | "tool_unavailable"
  | "tool_timeout"
  | "tool_empty"
  | "tool_error"
  | "tool_contradictory"
  | "wifi_slow"
  | "cable_slow"
  | "payment_recognized"
  | "payment_unrecognized"
  | "contract_blocked"
  | "multiple_invoices"
  | "multiple_contracts"
  | "ticket_failure"
  | "schedule_unavailable"
  | "action_disabled";

export interface AgentContext {
  simulationProfile?: AgentSimulationProfile;
  channel?: "training" | "test" | "service";
}

export interface ChatMessage {
  role: "customer" | "agent";
  content: string;
}

export interface ResponseFingerprint {
  normalizedText: string;
  intent: Intent;
  goal: string;
  actions: string[];
  artifacts: string[];
  at: string;
}

export interface PersistedConversationState {
  activeGoal: string;
  step: string;
  collectedData: string[];
  pendingQuestion: string | null;
  suppliedInformation: string[];
  promisedActions: string[];
  executedActions: string[];
  artifacts: string[];
  blocker: string | null;
  nextStep: string;
  fingerprints: ResponseFingerprint[];
}

export interface ToolEvidence {
  id: string;
  kind: "lookup" | "diagnostic" | "document" | "protocol" | "knowledge";
  source: string;
  summary: string;
  valid: boolean;
  simulated: boolean;
  confirmedAt: string;
}

export interface ToolReceipt {
  tool: string;
  /** Compatibilidade com os consumidores existentes. */
  status: "completed" | "failed";
  /** Resultado operacional detalhado usado pelas regras de evidência. */
  outcome: ToolOutcome;
  summary: string;
  evidence?: ToolEvidence;
  artifact?: {
    type: "pix" | "invoice" | "protocol";
    label: string;
    value: string;
    simulated?: boolean;
  };
  realAction: boolean;
  simulated: boolean;
  errorCode?: string;
}

export interface HandoffDecision {
  required: boolean;
  reason: string | null;
  summary: string | null;
}

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
  finalStatus: AgentFinalStatus;
  response: string;
  tools: ToolReceipt[];
  pendingTools: string[];
  evidence: ToolEvidence[];
  actionExecuted: boolean;
  simulationOnly: boolean;
  handoff: HandoffDecision;
  safetyAlerts: string[];
  conversationSummary: string;
  nextStep: string;
  evaluation: QualityEvaluation;
  conversationState: PersistedConversationState;
  correlationId: string;
}
