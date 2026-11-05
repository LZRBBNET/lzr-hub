import { stagingDemoRequirements } from "./staging-demo.ts";

/** Provider/admin credentials the isolated demo must not inherit, even with flags off. */
export const STAGING_FORBIDDEN_CREDENTIALS = [
  "IXC_API_TOKEN", "IXC_RELAY_TOKEN", "GROQ_API_KEY",
  "META_ACCESS_TOKEN", "META_APP_SECRET", "META_VERIFY_TOKEN",
  "N8N_CHANNEL_SECRET", "TELEGRAM_WEBHOOK_SECRET", "EVOLUTION_WEBHOOK_SECRET",
  "EVOLUTION_API_KEY", "CHATWOOT_API_TOKEN",
  "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY",
  "STAGING_JOB_SECRET", "CONTRACT_AUDIT_JOB_SECRET", "QUEUE_SERVICE_SECRET",
] as const;

export type StagingReadinessBlocker = {
  code: "CONFIG_MISMATCH" | "EXTERNAL_CREDENTIAL_PRESENT" | "INVALID_AUTH_FLAG";
  variable: string;
};

/** Values are deliberately absent: this result is safe to keep with test evidence. */
export interface StagingReadiness {
  schemaVersion: 1;
  scope: "configuration_only";
  status: "blocked" | "configuration_valid";
  readyForProduction: false;
  applicationAuth: "required" | "not_enforced";
  databaseConnectionConfigured: boolean;
  blockers: StagingReadinessBlocker[];
  requiredEvidence: readonly ["access_control", "synthetic_database", "runtime_environment", "no_real_delivery"];
}

const present = (value: string | undefined) => typeof value === "string" && value.trim().length > 0;

/**
 * Read-only preflight, not authorization to publish. No files, DB, network,
 * credentials creation, or environment mutation. A clean config still needs
 * access/isolation evidence from the actual environment that will serve it.
 */
export function assessStagingReadiness(source: Record<string, string | undefined>): StagingReadiness {
  const blockers: StagingReadinessBlocker[] = [];
  for (const [variable, expected] of Object.entries(stagingDemoRequirements)) {
    if (source[variable] !== expected) blockers.push({ code: "CONFIG_MISMATCH", variable });
  }
  for (const variable of STAGING_FORBIDDEN_CREDENTIALS) {
    if (typeof source[variable] === "string" && source[variable] !== "") blockers.push({ code: "EXTERNAL_CREDENTIAL_PRESENT", variable });
  }
  if (source.FEATURE_AUTH !== undefined && source.FEATURE_AUTH !== "true" && source.FEATURE_AUTH !== "false") {
    blockers.push({ code: "INVALID_AUTH_FLAG", variable: "FEATURE_AUTH" });
  }
  return {
    schemaVersion: 1,
    scope: "configuration_only",
    status: blockers.length ? "blocked" : "configuration_valid",
    readyForProduction: false,
    applicationAuth: source.FEATURE_AUTH === "true" ? "required" : "not_enforced",
    databaseConnectionConfigured: present(source.DATABASE_URL),
    blockers,
    requiredEvidence: ["access_control", "synthetic_database", "runtime_environment", "no_real_delivery"],
  };
}
