export const stagingDemoRequirements = {
  LZR_ENV: "staging",
  NEXT_PUBLIC_LZR_ENV: "staging",
  LZR_RUNTIME_MODE: "mock",
  IXC_MODE: "disabled",
  IXC_TRANSPORT: "disabled",
  IXC_WRITE_ENABLED: "false",
  FEATURE_IXC_WRITE: "false",
  PILOT_MODE: "disabled",
  FEATURE_LANGFUSE: "false",
  FEATURE_CHATWOOT: "false",
  FEATURE_EVOLUTION: "false",
  FEATURE_META_WHATSAPP: "false",
  FEATURE_QUEUES: "false",
  FEATURE_PGVECTOR: "false",
  FEATURE_AGENT_HOMOLOGATION_PROFILES: "false",
} as const;

export interface StagingDemoConfig {
  environment: "staging";
  runtimeMode: "mock";
  ixc: "disabled";
  externalWrites: false;
}

export function loadStagingDemoConfig(
  source: Record<string, string | undefined> = process.env,
): StagingDemoConfig {
  for (const [name, expected] of Object.entries(stagingDemoRequirements)) {
    if (source[name] !== expected) {
      throw new Error(`${name} deve ser ${expected} na demo de staging`);
    }
  }
  return { environment: "staging", runtimeMode: "mock", ixc: "disabled", externalWrites: false };
}

export function stagingDemoHealth(
  source: Record<string, string | undefined> = process.env,
) {
  try {
    const config = loadStagingDemoConfig(source);
    return { status: "ok" as const, ...config };
  } catch {
    return {
      status: "degraded" as const,
      environment: source.LZR_ENV === "staging" ? "staging" : "unconfigured",
      runtimeMode: source.LZR_RUNTIME_MODE === "mock" ? "mock" : "blocked",
      ixc: "disabled" as const,
      externalWrites: false as const,
    };
  }
}
