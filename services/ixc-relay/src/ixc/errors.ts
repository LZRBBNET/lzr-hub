export class RelayError extends Error {
  readonly code: string;
  readonly status: number;
  readonly safeMessage: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    status: number,
    safeMessage: string,
    retryable = false,
  ) {
    super(code);
    this.name = "RelayError";
    this.code = code;
    this.status = status;
    this.safeMessage = safeMessage;
    this.retryable = retryable;
  }
}

export function asRelayError(error: unknown) {
  if (error instanceof RelayError) return error;
  const code = error instanceof Error ? error.message : "";
  const known: Record<string, [number, string]> = {
    RELAY_REQUEST_INVALID: [400, "Solicitação inválida"],
    RELAY_PARAMETERS_INVALID: [400, "Parâmetros inválidos"],
    RELAY_IDENTIFIER_INVALID: [400, "Identificador inválido"],
    RELAY_PAGE_SIZE_INVALID: [400, "Paginação inválida"],
    RELAY_CUSTOMER_REQUIRED: [400, "Cadastro obrigatório"],
    RELAY_PLAN_REQUIRED: [400, "Plano obrigatório"],
    RELAY_PARAMETER_REQUIRED: [400, "Parâmetro obrigatório"],
    RELAY_FIELD_FORBIDDEN: [403, "Campo não permitido"],
    RELAY_OPERATION_FORBIDDEN: [403, "Operação não permitida"],
    RELAY_CUSTOMER_NOT_ALLOWED: [403, "Cadastro não autorizado"],
    RELAY_RATE_LIMITED: [429, "Limite temporário excedido"],
    RELAY_CONCURRENCY_LIMITED: [503, "Serviço temporariamente indisponível"],
    RELAY_CIRCUIT_OPEN: [503, "Serviço temporariamente indisponível"],
    IXC_TIMEOUT: [504, "Serviço temporariamente indisponível"],
    IXC_NETWORK_ERROR: [503, "Serviço temporariamente indisponível"],
    IXC_IP_NOT_ALLOWED: [503, "Serviço temporariamente indisponível"],
    IXC_AUTHENTICATION_FAILED: [503, "Serviço temporariamente indisponível"],
    IXC_PERMISSION_DENIED: [503, "Serviço temporariamente indisponível"],
    IXC_API_ERROR: [503, "Serviço temporariamente indisponível"],
    IXC_RESPONSE_INVALID: [502, "Resposta inválida do serviço"],
  };
  if (/^IXC_HTTP_\d{3}$/.test(code)) return new RelayError(code, 503, "Serviço temporariamente indisponível");
  const mapped = known[code];
  return mapped
    ? new RelayError(code, mapped[0], mapped[1])
    : new RelayError("RELAY_UPSTREAM_UNAVAILABLE", 503, "Serviço temporariamente indisponível");
}
