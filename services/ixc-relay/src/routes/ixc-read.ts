import type { RelayConfig } from "../config.ts";
import type { RelayIxcClient } from "../ixc/client.ts";
import { RelayError, asRelayError } from "../ixc/errors.ts";
import { parseOperationRequest } from "../ixc/operations.ts";
import type { RelayMetrics } from "../observability/logger.ts";
import { authenticateRequest } from "../security/authentication.ts";
import type { NonceStore } from "../security/replay-protection.ts";

export interface ReadRouteDependencies {
  config: RelayConfig;
  client: RelayIxcClient;
  nonces: NonceStore;
  metrics: RelayMetrics;
  log: (event: Record<string, unknown>) => void;
  now?: () => number;
}

export async function handleIxcRead(request: Request, dependencies: ReadRouteDependencies) {
  const started = (dependencies.now ?? (() => Date.now()))();
  let correlationId = "unavailable";
  let operation = "unparsed";
  dependencies.metrics.relay_requests_total += 1;
  try {
    if (request.method !== "POST") throw new RelayError("RELAY_METHOD_NOT_ALLOWED", 405, "Método não permitido");
    const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") throw new RelayError("RELAY_CONTENT_TYPE_INVALID", 415, "Content-Type inválido");
    const lengthHeader = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(lengthHeader) && lengthHeader > dependencies.config.maxBodyBytes) throw new RelayError("RELAY_BODY_TOO_LARGE", 413, "Corpo acima do limite");
    const body = await readBodyLimited(request, dependencies.config.maxBodyBytes);
    const auth = authenticateRequest(
      request,
      body,
      dependencies.config,
      dependencies.nonces,
      dependencies.now,
    );
    correlationId = auth.correlationId;
    if ([...new URL(request.url).searchParams].length > 0) {
      throw new RelayError("RELAY_FIELD_FORBIDDEN", 403, "Campo não permitido");
    }
    const parsed = JSON.parse(body) as unknown;
    const operationRequest = parseOperationRequest(parsed);
    operation = operationRequest.operation;

    const pathname = new URL(request.url).pathname;
    if (pathname === "/v1/ixc/test-connection" && operation !== "testConnection") {
      throw new RelayError("RELAY_OPERATION_FORBIDDEN", 403, "Operação não permitida");
    }
    if (pathname === "/v1/ixc/read" && operation === "testConnection") {
      throw new RelayError("RELAY_OPERATION_FORBIDDEN", 403, "Operação não permitida");
    }
    if (!dependencies.config.allowedOperations.has(operationRequest.operation)) {
      throw new RelayError("RELAY_OPERATION_FORBIDDEN", 403, "Operação não permitida");
    }
    const customerId = operationRequest.parameters.customerId;
    if (customerId && !dependencies.config.allowedCustomerIds.has(customerId)) {
      throw new RelayError("RELAY_CUSTOMER_NOT_ALLOWED", 403, "Cadastro não autorizado");
    }

    const result = await dependencies.client.execute(operationRequest, correlationId);
    const durationMs = (dependencies.now ?? (() => Date.now()))() - started;
    dependencies.metrics.relay_success_total += 1;
    dependencies.metrics.relay_latency_ms = durationMs;
    dependencies.metrics.relay_circuit_breaker_state = dependencies.client.circuitState();
    dependencies.log({
      correlationId,
      operation,
      status: "success",
      durationMs,
      attempt: result.attempt,
      recordCount: result.records.length,
      cache: "not_applicable",
    });
    return Response.json({
      ok: true,
      data: result.records,
      meta: {
        correlationId,
        operation,
        durationMs,
        source: "ixc-relay",
      },
    });
  } catch (error) {
    const failure = error instanceof SyntaxError
      ? new RelayError("RELAY_JSON_INVALID", 400, "JSON inválido")
      : asRelayError(error);
    const durationMs = (dependencies.now ?? (() => Date.now()))() - started;
    dependencies.metrics.relay_errors_total += 1;
    dependencies.metrics.relay_latency_ms = durationMs;
    if (failure.code.startsWith("RELAY_") && [
      "RELAY_UNAUTHORIZED",
      "RELAY_SIGNATURE_INVALID",
      "RELAY_TIMESTAMP_INVALID",
      "RELAY_NONCE_INVALID",
    ].includes(failure.code)) dependencies.metrics.relay_auth_failures_total += 1;
    if (failure.code === "RELAY_REPLAY_DETECTED") dependencies.metrics.relay_replay_blocked_total += 1;
    if (failure.code === "IXC_TIMEOUT") dependencies.metrics.relay_ixc_timeout_total += 1;
    if (failure.code === "IXC_IP_NOT_ALLOWED") dependencies.metrics.relay_ixc_ip_not_allowed_total += 1;
    dependencies.metrics.relay_circuit_breaker_state = dependencies.client.circuitState();
    dependencies.log({
      correlationId,
      operation,
      status: "failed",
      durationMs,
      errorCode: failure.code,
    });
    return Response.json({
      ok: false,
      error: {
        code: failure.code,
        message: failure.safeMessage,
      },
      meta: { correlationId },
    }, { status: failure.status });
  }
}

async function readBodyLimited(request: Request, maximumBytes: number) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let value = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) throw new RelayError("RELAY_BODY_TOO_LARGE", 413, "Corpo acima do limite");
      value += decoder.decode(chunk.value, { stream: true });
    }
    return value + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
