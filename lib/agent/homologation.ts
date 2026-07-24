import { loadRuntimeConfig } from "../runtime/environment.ts";
import { runAgentPipeline } from "./pipeline.ts";
import type { AgentResult, AgentSimulationProfile, ChatMessage } from "./types.ts";

export class AgentHomologationForbiddenError extends Error {
  constructor() {
    super("AGENT_HOMOLOGATION_FORBIDDEN");
    this.name = "AgentHomologationForbiddenError";
  }
}

export interface TrustedHomologationInput {
  message: string;
  history?: ChatMessage[];
  simulationProfile: AgentSimulationProfile;
  runtimeSource?: Record<string, string | undefined>;
}

/**
 * Executor interno sem transporte HTTP. A própria chamada de módulo é o limite
 * de confiança; a flag e o ambiente continuam obrigatórios.
 */
export function runTrustedAgentHomologation(
  input: TrustedHomologationInput,
): AgentResult {
  const config = loadRuntimeConfig(input.runtimeSource);
  if (!config.agentHomologationProfilesEnabled) {
    throw new AgentHomologationForbiddenError();
  }
  return runAgentPipeline(input.message, input.history ?? [], {
    channel: "homologation",
    simulationProfile: input.simulationProfile,
  });
}
