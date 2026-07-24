export type LzrEnvironment = "local" | "test" | "staging" | "production";
export type IxcMode = "disabled" | "mock" | "staging-readonly" | "production-readonly";
export type IxcTransportMode = "disabled" | "direct" | "relay";
export type PilotMode = "disabled" | "internal";

export interface RuntimeConfig {
  environment: LzrEnvironment;
  ixcMode: IxcMode;
  ixcTransport: IxcTransportMode;
  ixcBaseUrl?: string;
  ixcToken?: string;
  ixcRelayUrl?: string;
  ixcRelayHmacSecret?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  ixcAllowlist: string[];
  ixcTimeoutMs: number;
  ixcRetryLimit: number;
  ixcCacheTtlSeconds: number;
  ixcRateLimitPerMinute: number;
  scheduledSyncEnabled: boolean;
  stagingJobSecret?: string;
  pilotMode: PilotMode;
  pilotAllowedUserIds: string[];
  writeEnabled: false;
}

const environments = new Set<LzrEnvironment>(["local", "test", "staging", "production"]);
const ixcModes = new Set<IxcMode>(["disabled", "mock", "staging-readonly", "production-readonly"]);
const ixcTransports = new Set<IxcTransportMode>(["disabled", "direct", "relay"]);

function integer(name: string, value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = value ? Number(value) : fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} inválido`);
  return parsed;
}

export function parseAllowlist(value = "") {
  const ids = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (ids.length > 10) throw new Error("IXC_ALLOWLIST_IDS aceita no máximo 10 cadastros");
  if (ids.some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id))) throw new Error("IXC_ALLOWLIST_IDS contém identificador inválido");
  return ids;
}

export function loadRuntimeConfig(source: Record<string, string | undefined> = process.env): RuntimeConfig {
  const environment = (source.LZR_ENV ?? "local") as LzrEnvironment;
  const ixcMode = (source.IXC_MODE ?? "disabled") as IxcMode;
  const ixcTransport = (source.IXC_TRANSPORT ?? (ixcMode === "staging-readonly" ? "direct" : "disabled")) as IxcTransportMode;
  if (!environments.has(environment)) throw new Error("LZR_ENV inválido");
  if (!ixcModes.has(ixcMode)) throw new Error("IXC_MODE inválido");
  if (!ixcTransports.has(ixcTransport)) throw new Error("IXC_TRANSPORT inválido");
  if ((source.IXC_WRITE_ENABLED ?? "false") !== "false") throw new Error("Escrita no IXC é proibida na Fase 3A");
  if ((source.FEATURE_IXC_WRITE ?? "false") !== "false") throw new Error("FEATURE_IXC_WRITE deve permanecer false");
  if (environment === "production" && ixcTransport === "direct") throw new Error("Produção proíbe transporte IXC direto");
  if (ixcMode === "production-readonly" && (environment !== "production" || ixcTransport !== "relay")) throw new Error("production-readonly exige relay em produção");
  if (ixcMode === "disabled" && ixcTransport !== "disabled") throw new Error("IXC_MODE disabled exige transporte disabled");
  if (ixcMode === "mock" && ixcTransport !== "disabled") throw new Error("IXC_MODE mock não usa transporte externo");
  if (ixcTransport === "disabled" && !["disabled","mock"].includes(ixcMode)) throw new Error("Modo IXC readonly exige transporte explícito");
  const ixcAllowlist = parseAllowlist(source.IXC_ALLOWED_CUSTOMER_IDS ?? source.IXC_ALLOWLIST_IDS);
  const pilotMode=(source.PILOT_MODE??"disabled") as PilotMode;if(!["disabled","internal"].includes(pilotMode))throw new Error("PILOT_MODE inválido");
  const pilotAllowedUserIds=[...new Set((source.PILOT_ALLOWED_USER_IDS??"").split(",").map((item)=>item.trim()).filter(Boolean))];if(pilotAllowedUserIds.length>3)throw new Error("Piloto aceita no máximo 3 usuários");if(pilotMode==="internal"&&(pilotAllowedUserIds.length<2||!source.STAGING_JOB_SECRET))throw new Error("Piloto interno exige 2 a 3 usuários e segredo administrativo");
  if (ixcMode === "staging-readonly") {
    if (environment !== "staging") throw new Error("staging-readonly exige LZR_ENV=staging");
    if (ixcAllowlist.length === 0) throw new Error("IXC staging exige allowlist explícita");
  }
  if (ixcTransport === "direct" && (!source.IXC_BASE_URL || !source.IXC_API_TOKEN)) throw new Error("Transporte direto exige URL e token IXC");
  if (ixcTransport === "relay") {
    if (!source.IXC_RELAY_URL || !source.IXC_RELAY_HMAC_SECRET || !source.CF_ACCESS_CLIENT_ID || !source.CF_ACCESS_CLIENT_SECRET) {
      throw new Error("Transporte relay exige URL, HMAC e credenciais Access");
    }
    if (environment === "production" && source.IXC_API_TOKEN) throw new Error("Token IXC não pode existir no Worker em produção");
    if (ixcAllowlist.length === 0) throw new Error("Transporte relay exige allowlist explícita");
  }
  return {
    environment,
    ixcMode,
    ixcTransport,
    ixcBaseUrl: source.IXC_BASE_URL,
    ixcToken: source.IXC_API_TOKEN,
    ixcRelayUrl: source.IXC_RELAY_URL,
    ixcRelayHmacSecret: source.IXC_RELAY_HMAC_SECRET,
    cfAccessClientId: source.CF_ACCESS_CLIENT_ID,
    cfAccessClientSecret: source.CF_ACCESS_CLIENT_SECRET,
    ixcAllowlist,
    ixcTimeoutMs: integer("IXC_TIMEOUT_MS", source.IXC_TIMEOUT_MS, 3500, 500, 10000),
    ixcRetryLimit: integer("IXC_RETRY_LIMIT", source.IXC_RETRY_LIMIT, 1, 0, 1),
    ixcCacheTtlSeconds: integer("IXC_CACHE_TTL_SECONDS", source.IXC_CACHE_TTL_SECONDS, 300, 30, 3600),
    ixcRateLimitPerMinute: integer("IXC_RATE_LIMIT_PER_MINUTE", source.IXC_RATE_LIMIT_PER_MINUTE, 30, 1, 120),
    scheduledSyncEnabled: environment === "staging" && source.IXC_SYNC_SCHEDULE_ENABLED === "true",
    stagingJobSecret: source.STAGING_JOB_SECRET,
    pilotMode,
    pilotAllowedUserIds,
    writeEnabled: false,
  };
}
