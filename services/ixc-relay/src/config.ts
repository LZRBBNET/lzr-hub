import { ALL_OPERATION_NAMES, type RelayOperationName } from "./ixc/operations.ts";

export interface RelayConfig {
  environment: "test" | "staging" | "production";
  host: "127.0.0.1";
  port: number;
  logLevel: "error" | "warn" | "info";
  upstreamBaseUrl: string;
  apiToken: string;
  allowedCustomerIds: Set<string>;
  timeoutMs: number;
  retryLimit: 0 | 1;
  rateLimitPerMinute: number;
  hmacSecret: string;
  maxClockSkewSeconds: number;
  nonceTtlSeconds: number;
  maxBodyBytes: number;
  maxConcurrency: number;
  allowedOperations: Set<RelayOperationName>;
}

export function loadRelayConfig(source: Record<string, string | undefined> = process.env): RelayConfig {
  const environment = source.RELAY_ENV ?? "production";
  if (!["test", "staging", "production"].includes(environment)) throw new Error("RELAY_ENV_INVALID");
  const host = source.RELAY_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("RELAY_HOST_MUST_BE_LOOPBACK");
  const logLevel = source.RELAY_LOG_LEVEL ?? "info";
  if (!["error", "warn", "info"].includes(logLevel)) throw new Error("RELAY_LOG_LEVEL_INVALID");
  if ((source.IXC_WRITE_ENABLED ?? "false") !== "false" || (source.FEATURE_IXC_WRITE ?? "false") !== "false") {
    throw new Error("RELAY_WRITE_MUST_REMAIN_DISABLED");
  }

  const upstreamBaseUrl = required(source.IXC_UPSTREAM_BASE_URL, "IXC_UPSTREAM_BASE_URL_REQUIRED");
  const parsedUrl = new URL(upstreamBaseUrl);
  if (parsedUrl.protocol !== "https:") throw new Error("IXC_UPSTREAM_HTTPS_REQUIRED");
  if (parsedUrl.username || parsedUrl.password || parsedUrl.hash) throw new Error("IXC_UPSTREAM_URL_INVALID");

  const allowedCustomerIds = parseIdentifiers(source.IXC_ALLOWED_CUSTOMER_IDS, 10);
  if (allowedCustomerIds.size === 0) throw new Error("IXC_ALLOWLIST_REQUIRED");
  const allowedOperations = parseOperations(source.IXC_RELAY_ALLOWED_OPERATIONS);
  if (allowedOperations.size === 0) throw new Error("RELAY_OPERATIONS_REQUIRED");

  return {
    environment: environment as RelayConfig["environment"],
    host,
    port: integer(source.RELAY_PORT, 8788, 1, 65535, "RELAY_PORT_INVALID"),
    logLevel: logLevel as RelayConfig["logLevel"],
    upstreamBaseUrl: parsedUrl.toString().replace(/\/$/, ""),
    apiToken: required(source.IXC_API_TOKEN, "IXC_API_TOKEN_REQUIRED"),
    allowedCustomerIds,
    timeoutMs: integer(source.IXC_TIMEOUT_MS, 3500, 500, 10000, "IXC_TIMEOUT_INVALID"),
    retryLimit: integer(source.IXC_RETRY_LIMIT, 1, 0, 1, "IXC_RETRY_INVALID") as 0 | 1,
    rateLimitPerMinute: integer(source.IXC_RATE_LIMIT_PER_MINUTE, 30, 1, 120, "IXC_RATE_LIMIT_INVALID"),
    hmacSecret: strongSecret(source.IXC_RELAY_HMAC_SECRET),
    maxClockSkewSeconds: integer(source.IXC_RELAY_MAX_CLOCK_SKEW_SECONDS, 60, 10, 300, "RELAY_CLOCK_SKEW_INVALID"),
    nonceTtlSeconds: integer(source.IXC_RELAY_NONCE_TTL_SECONDS, 120, 60, 600, "RELAY_NONCE_TTL_INVALID"),
    maxBodyBytes: integer(source.IXC_RELAY_MAX_BODY_BYTES, 32768, 1024, 65536, "RELAY_BODY_LIMIT_INVALID"),
    maxConcurrency: integer(source.IXC_RELAY_MAX_CONCURRENCY, 8, 1, 64, "RELAY_CONCURRENCY_INVALID"),
    allowedOperations,
  };
}

function parseOperations(value: string | undefined) {
  const names = value
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [...ALL_OPERATION_NAMES];
  const result = new Set<RelayOperationName>();
  for (const name of names) {
    if (!ALL_OPERATION_NAMES.includes(name as RelayOperationName)) throw new Error("RELAY_OPERATION_INVALID");
    result.add(name as RelayOperationName);
  }
  return result;
}

function parseIdentifiers(value: string | undefined, maximum: number) {
  const result = new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  if (result.size > maximum) throw new Error("IXC_ALLOWLIST_TOO_LARGE");
  if ([...result].some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id))) throw new Error("IXC_ALLOWLIST_INVALID");
  return result;
}

function required(value: string | undefined, code: string) {
  if (!value?.trim()) throw new Error(code);
  return value.trim();
}

function strongSecret(value: string | undefined) {
  const secret = required(value, "RELAY_HMAC_SECRET_REQUIRED");
  if (secret.length < 32) throw new Error("RELAY_HMAC_SECRET_TOO_SHORT");
  return secret;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, code: string) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(code);
  return parsed;
}
