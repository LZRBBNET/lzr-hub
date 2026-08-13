import type { IxcReadOperation } from "./types.ts";

const allowed = new Set<IxcReadOperation>(["testConnection","findCustomer","getCustomer","listCustomers","listContracts","getPlan","listInvoices","listPayments","listServiceOrders","getConnection","getCity","listOsCatalog","listFinanceCatalog"]);
const writeWords = /(insert|update|delete|write|unlock|unblock|change|generate|settle|open|close|send|command|alterar|inserir|excluir|desbloquear|baixar|gerar|abrir|encerrar|enviar)/i;

export class ReadonlyIxcGuard {
  private readonly customerIds: Set<string>;
  /**
   * Base inteira liberada. Nasce falso: a allowlist é a última barreira antes
   * de o app poder ler qualquer cadastro da BBNET, então abrir isso precisa ser
   * decisão explícita (`FEATURE_IXC_FULL_BASE`), não efeito colateral de config.
   */
  private readonly fullBase: boolean;
  constructor(ids: string[], fullBase = false) {
    if (ids.length > 10) throw new Error("Allowlist IXC excede 10 cadastros");
    this.customerIds = new Set(ids);
    this.fullBase = fullBase;
  }
  assertOperation(operation: string): asserts operation is IxcReadOperation {
    if (writeWords.test(operation) || !allowed.has(operation as IxcReadOperation)) throw new IxcWriteBlockedError(operation);
  }
  assertCustomer(customerId: string) {
    if (!this.isAllowed(customerId)) throw new IxcCustomerNotAllowedError();
  }
  isAllowed(customerId: string) { return this.fullBase || this.customerIds.has(customerId); }
  scope() { return this.fullBase ? "full-base" as const : "allowlist" as const; }
  listMasked() { return this.fullBase ? [] : [...this.customerIds].map((id)=>`${id.slice(0,3)}***${id.slice(-2)}`); }
}

export class IxcWriteBlockedError extends Error { constructor(operation:string){super(`Operação IXC bloqueada: ${operation}`);this.name="IxcWriteBlockedError";} }
export class IxcCustomerNotAllowedError extends Error { constructor(){super("Cadastro fora da allowlist de homologação");this.name="IxcCustomerNotAllowedError";} }
