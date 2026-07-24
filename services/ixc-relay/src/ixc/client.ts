import type { RelayConfig } from "../config.ts";
import { RelayError } from "./errors.ts";
import { OPERATION_DEFINITIONS, type RelayOperationRequest } from "./operations.ts";

export interface IxcClientOptions {
  fetcher?: typeof fetch;
  now?: () => number;
}

export class RelayIxcClient {
  private readonly config: RelayConfig;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private failures = 0;
  private openedAt = 0;
  private calls: number[] = [];
  private inFlight = 0;

  constructor(
    config: RelayConfig,
    options: IxcClientOptions = {},
  ) {
    this.config = config;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  circuitState() {
    return this.canRequest() ? "closed" as const : "open" as const;
  }

  async execute(request: RelayOperationRequest, correlationId: string) {
    if (!this.canRequest()) throw new RelayError("RELAY_CIRCUIT_OPEN", 503, "Serviço temporariamente indisponível");
    this.assertRateLimit();
    if (this.inFlight >= this.config.maxConcurrency) {
      throw new RelayError("RELAY_CONCURRENCY_LIMITED", 503, "Serviço temporariamente indisponível");
    }
    this.inFlight += 1;
    try {
      const attempts = this.config.retryLimit + 1;
      let lastError: RelayError | undefined;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const result = await this.callUpstream(request, correlationId);
          this.failures = 0;
          this.openedAt = 0;
          return { records: result, attempt };
        } catch (error) {
          const relayError = error instanceof RelayError
            ? error
            : new RelayError("IXC_NETWORK_ERROR", 503, "Serviço temporariamente indisponível", true);
          lastError = relayError;
          if (!relayError.retryable || attempt === attempts) break;
        }
      }
      this.failures += 1;
      if (this.failures >= 3) this.openedAt = this.now();
      throw lastError ?? new RelayError("IXC_NETWORK_ERROR", 503, "Serviço temporariamente indisponível");
    } finally {
      this.inFlight -= 1;
    }
  }

  private async callUpstream(request: RelayOperationRequest, correlationId: string) {
    const definition = OPERATION_DEFINITIONS[request.operation];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.fetcher(
        `${this.config.upstreamBaseUrl}/webservice/v1/${definition.resource}`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Basic ${basicCredential(this.config.apiToken)}`,
            "Content-Type": "application/json",
            ixcsoft: "listar",
            "x-correlation-id": correlationId,
          },
          body: JSON.stringify({
            qtype: definition.qtype,
            query: definition.query(request.parameters),
            oper: "=",
            page: "1",
            rp: String(Math.min(request.parameters.pageSize ?? definition.maximumPageSize, definition.maximumPageSize)),
            sortname: "id",
            sortorder: "asc",
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new RelayError(
          `IXC_HTTP_${response.status}`,
          503,
          "Serviço temporariamente indisponível",
          response.status === 429 || response.status >= 500,
        );
      }
      const body = await response.json().catch(() => {
        throw new RelayError("IXC_RESPONSE_INVALID", 502, "Resposta inválida do serviço");
      });
      if (!isRecord(body)) throw new RelayError("IXC_RESPONSE_INVALID", 502, "Resposta inválida do serviço");
      if (body.type === "error") throw classifyIxcApiError(String(body.message ?? ""));
      if (body.registros === undefined) return [];
      if (!Array.isArray(body.registros)) throw new RelayError("IXC_RESPONSE_INVALID", 502, "Resposta inválida do serviço");
      return body.registros.filter(isRecord);
    } catch (error) {
      if (error instanceof RelayError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new RelayError("IXC_TIMEOUT", 504, "Serviço temporariamente indisponível", true);
      }
      throw new RelayError("IXC_NETWORK_ERROR", 503, "Serviço temporariamente indisponível", true);
    } finally {
      clearTimeout(timer);
    }
  }

  private assertRateLimit() {
    const cutoff = this.now() - 60_000;
    this.calls = this.calls.filter((time) => time > cutoff);
    if (this.calls.length >= this.config.rateLimitPerMinute) {
      throw new RelayError("RELAY_RATE_LIMITED", 429, "Limite temporário excedido");
    }
    this.calls.push(this.now());
  }

  private canRequest() {
    if (!this.openedAt) return true;
    if (this.now() - this.openedAt >= 30_000) {
      this.failures = 0;
      this.openedAt = 0;
      return true;
    }
    return false;
  }
}

function classifyIxcApiError(messageValue: string) {
  const message = messageValue.toLocaleLowerCase("pt-BR");
  if (message.includes("ip") && (message.includes("liberad") || message.includes("permitid"))) {
    return new RelayError("IXC_IP_NOT_ALLOWED", 503, "Serviço temporariamente indisponível");
  }
  if (message.includes("token") || message.includes("autentica") || message.includes("login")) {
    return new RelayError("IXC_AUTHENTICATION_FAILED", 503, "Serviço temporariamente indisponível");
  }
  if (message.includes("permiss")) return new RelayError("IXC_PERMISSION_DENIED", 503, "Serviço temporariamente indisponível");
  return new RelayError("IXC_API_ERROR", 503, "Serviço temporariamente indisponível");
}

function basicCredential(token: string) {
  const value = token.trim();
  return /^\d+:[A-Fa-f0-9]{32,}$/.test(value)
    ? Buffer.from(value).toString("base64")
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
