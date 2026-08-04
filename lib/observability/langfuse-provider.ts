import { randomBytes } from "node:crypto";
import type { ObservabilityProvider, ProviderHealth } from "../integrations/contracts.ts";

/**
 * Envia rastros ao Langfuse pelo endpoint OTLP/HTTP (padrão OpenTelemetry).
 *
 * A API de ingestão antiga do Langfuse (lote de eventos `trace-create`) foi
 * descontinuada — a atual exige o formato OTLP, com trace/span ID em hex e
 * timestamps em nanosegundos. Implementado à mão (sem SDK) para manter o
 * mesmo padrão de cliente enxuto usado no resto do projeto (ex.: IXC).
 */
export interface LangfuseOptions {
  publicKey: string;
  secretKey: string;
  /** URL base da região do Langfuse. Padrão: nuvem EU. */
  baseUrl?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

function hexId(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function nowUnixNano(): string {
  // BigInt evita perda de precisão que Number teria em nanosegundos.
  // Literal BigInt (123n) exige target ES2020+; o projeto mira ES2017, então usa BigInt(...) explícito.
  return (BigInt(Date.now()) * BigInt(1_000_000)).toString();
}

/** OTLP só aceita valores de atributo como string/number/boolean; objetos viram JSON. */
function toAttributeValue(value: unknown): { stringValue: string } | { intValue: string } | { boolValue: boolean } {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number" && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === "string") return { stringValue: value };
  return { stringValue: JSON.stringify(value) };
}

export class LangfuseObservabilityProvider implements ObservabilityProvider {
  private readonly options: LangfuseOptions;
  private readonly fetcher: typeof fetch;
  private readonly endpoint: string;

  constructor(options: LangfuseOptions) {
    this.options = options;
    this.fetcher = options.fetcher ?? fetch;
    this.endpoint = `${(options.baseUrl ?? "https://cloud.langfuse.com").replace(/\/$/, "")}/api/public/otel/v1/traces`;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.options.publicKey}:${this.options.secretKey}`).toString("base64")}`;
  }

  /**
   * Só confirma que o endpoint de ingestão responde alguma coisa (não que a
   * requisição em si seria aceita) — o formato exato de um "ping" de saúde
   * não é documentado publicamente pelo Langfuse, então não presumimos
   * semântica de código de status além de "o servidor respondeu".
   */
  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 3500);
      const response = await this.fetcher(this.endpoint, {
        method: "OPTIONS",
        headers: { Authorization: this.authHeader() },
        signal: controller.signal,
      });
      clearTimeout(timer);
      return {
        service: "Langfuse", mode: "production-readonly", state: "healthy",
        latencyMs: Date.now() - started, checkedAt,
        detail: `Ingestão OTLP alcançável (HTTP ${response.status})`,
      };
    } catch (error) {
      return {
        service: "Langfuse", mode: "production-readonly", state: "degraded",
        latencyMs: Date.now() - started, checkedAt,
        detail: error instanceof Error ? error.name : "unknown",
      };
    }
  }

  /**
   * Cria um rastro de um único span. `attributes` deve já vir sanitizado por
   * quem chama — este cliente não faz mascaramento de PII sozinho.
   */
  async trace(name: string, attributes: Record<string, unknown>): Promise<void> {
    const traceId = hexId(16);
    const spanId = hexId(8);
    const timestamp = nowUnixNano();

    const body = {
      resourceSpans: [{
        resource: { attributes: [] },
        scopeSpans: [{
          spans: [{
            traceId, spanId, name,
            startTimeUnixNano: timestamp,
            endTimeUnixNano: timestamp,
            attributes: [
              { key: "langfuse.trace.name", value: { stringValue: name } },
              ...Object.entries(attributes).map(([key, value]) => ({
                key: `langfuse.trace.metadata.${key}`,
                value: toAttributeValue(value),
              })),
            ],
          }],
        }],
      }],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 3500);
    try {
      await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/json",
          "x-langfuse-ingestion-version": "4",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
