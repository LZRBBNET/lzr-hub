import type { IxcReadOperation } from "./types.ts";

export interface IxcTransportRequest {
  operation: Exclude<IxcReadOperation, "findCustomer">;
  parameters: {
    customerId?: string;
    planId?: string;
    pageSize?: number;
  };
  correlationId: string;
}

export interface IxcTransportResponse {
  records: Record<string, unknown>[];
}

export interface IxcTransport {
  readonly kind: "direct" | "relay";
  execute(request: IxcTransportRequest): Promise<IxcTransportResponse>;
}

export class IxcTransportError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable = false) {
    super(code);
    this.name = "IxcTransportError";
    this.code = code;
    this.retryable = retryable;
  }
}

type DirectOperation = {
  resource: string;
  qtype: string;
  query: (parameters: IxcTransportRequest["parameters"]) => string;
};

const directOperations: Record<IxcTransportRequest["operation"], DirectOperation> = {
  testConnection: { resource: "cliente", qtype: "id", query: () => "0" },
  getCustomer: { resource: "cliente", qtype: "id", query: ({ customerId }) => required(customerId) },
  listContracts: { resource: "cliente_contrato", qtype: "id_cliente", query: ({ customerId }) => required(customerId) },
  getPlan: { resource: "vd_contratos", qtype: "id", query: ({ planId }) => required(planId) },
  listInvoices: { resource: "fn_areceber", qtype: "id_cliente", query: ({ customerId }) => required(customerId) },
  listPayments: { resource: "fn_movim_finan", qtype: "id_cliente", query: ({ customerId }) => required(customerId) },
  listServiceOrders: { resource: "su_oss_chamado", qtype: "id_cliente", query: ({ customerId }) => required(customerId) },
  getConnection: { resource: "radusuarios", qtype: "id_cliente", query: ({ customerId }) => required(customerId) },
};

export interface DirectIxcTransportOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export class DirectIxcTransport implements IxcTransport {
  readonly kind = "direct" as const;
  private readonly options: DirectIxcTransportOptions;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DirectIxcTransportOptions) {
    this.options = options;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 3500;
  }

  async execute(request: IxcTransportRequest): Promise<IxcTransportResponse> {
    const definition = directOperations[request.operation];
    if (!definition) throw new IxcTransportError("IXC_OPERATION_FORBIDDEN");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(
        `${this.options.baseUrl.replace(/\/$/, "")}/webservice/v1/${definition.resource}`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Basic ${basicCredential(this.options.token)}`,
            "Content-Type": "application/json",
            ixcsoft: "listar",
            "x-correlation-id": request.correlationId,
          },
          body: JSON.stringify({
            qtype: definition.qtype,
            query: definition.query(request.parameters),
            oper: "=",
            page: "1",
            rp: String(request.parameters.pageSize ?? 20),
            sortname: "id",
            sortorder: "asc",
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new IxcTransportError(
          `IXC_HTTP_${response.status}`,
          response.status === 429 || response.status >= 500,
        );
      }
      return normalizeIxcResponse(await response.json());
    } catch (error) {
      if (error instanceof IxcTransportError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new IxcTransportError("IXC_TIMEOUT", true);
      }
      throw new IxcTransportError("IXC_NETWORK_ERROR", true);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface RelayIxcTransportOptions {
  relayUrl: string;
  hmacSecret: string;
  accessClientId: string;
  accessClientSecret: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}

export class RelayIxcTransport implements IxcTransport {
  readonly kind = "relay" as const;
  private readonly options: RelayIxcTransportOptions;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly nonce: () => string;

  constructor(options: RelayIxcTransportOptions) {
    this.options = options;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 3500;
    this.now = options.now ?? (() => Date.now());
    this.nonce = options.nonce ?? (() => crypto.randomUUID());
  }

  async execute(request: IxcTransportRequest): Promise<IxcTransportResponse> {
    const path = request.operation === "testConnection"
      ? "/v1/ixc/test-connection"
      : "/v1/ixc/read";
    const url = new URL(path, ensureTrailingSlash(this.options.relayUrl));
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new IxcTransportError("RELAY_URL_INVALID");
    }

    const body = JSON.stringify({
      operation: request.operation,
      parameters: request.parameters,
    });
    const timestamp = String(Math.floor(this.now() / 1000));
    const nonce = this.nonce();
    const signature = await signRelayRequest({
      secret: this.options.hmacSecret,
      timestamp,
      nonce,
      method: "POST",
      pathname: path,
      body,
      correlationId: request.correlationId,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetcher(url, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "CF-Access-Client-Id": this.options.accessClientId,
          "CF-Access-Client-Secret": this.options.accessClientSecret,
          "X-LZR-Timestamp": timestamp,
          "X-LZR-Nonce": nonce,
          "X-LZR-Signature": signature,
          "X-Correlation-Id": request.correlationId,
        },
        body,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as {
        ok?: unknown;
        data?: unknown;
        error?: { code?: unknown };
      } | null;
      if (!response.ok || payload?.ok !== true) {
        const code = typeof payload?.error?.code === "string"
          ? payload.error.code
          : `RELAY_HTTP_${response.status}`;
        throw new IxcTransportError(code, response.status === 429 || response.status >= 500);
      }
      return {
        records: Array.isArray(payload.data)
          ? payload.data.filter(isRecord)
          : [],
      };
    } catch (error) {
      if (error instanceof IxcTransportError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new IxcTransportError("IXC_TIMEOUT", false);
      }
      throw new IxcTransportError("RELAY_UPSTREAM_UNAVAILABLE", false);
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function signRelayRequest(input: {
  secret: string;
  timestamp: string;
  nonce: string;
  method: string;
  pathname: string;
  body: string;
  correlationId: string;
}) {
  const bodyHash = await sha256Hex(input.body);
  const canonical = [
    "v1",
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.pathname,
    bodyHash,
    input.correlationId,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonical),
  );
  return bytesToHex(new Uint8Array(signature));
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeIxcResponse(value: unknown): IxcTransportResponse {
  const body = isRecord(value) ? value : {};
  if (body.type === "error") {
    const message = String(body.message ?? "").toLocaleLowerCase("pt-BR");
    if (message.includes("ip") && (message.includes("liberad") || message.includes("permitid"))) {
      throw new IxcTransportError("IXC_IP_NOT_ALLOWED");
    }
    if (message.includes("token") || message.includes("autentica") || message.includes("login")) {
      throw new IxcTransportError("IXC_AUTHENTICATION_FAILED");
    }
    if (message.includes("permiss")) throw new IxcTransportError("IXC_PERMISSION_DENIED");
    throw new IxcTransportError("IXC_API_ERROR");
  }
  return {
    records: Array.isArray(body.registros)
      ? body.registros.filter(isRecord)
      : [],
  };
}

function basicCredential(token: string) {
  const value = token.trim();
  return /^\d+:[A-Fa-f0-9]{32,}$/.test(value) ? btoa(value) : value;
}

function required(value: string | undefined) {
  if (!value) throw new IxcTransportError("IXC_REQUEST_INVALID");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}
