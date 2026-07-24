import type { IxcReadOperation } from "./types.ts";

const allowed = new Set<IxcReadOperation>(["testConnection","getCustomer","listContracts","getPlan","listInvoices","listPayments","listServiceOrders","getConnection"]);
const writeWords = /(insert|update|delete|write|unlock|unblock|change|generate|settle|open|close|send|command|alterar|inserir|excluir|desbloquear|baixar|gerar|abrir|encerrar|enviar)/i;

export class ReadonlyIxcGuard {
  private readonly customerIds: Set<string>;
  constructor(ids: string[]) {
    if (ids.length > 10) throw new Error("Allowlist IXC excede 10 cadastros");
    this.customerIds = new Set(ids);
  }
  assertOperation(operation: string): asserts operation is IxcReadOperation {
    if (writeWords.test(operation) || !allowed.has(operation as IxcReadOperation)) throw new IxcWriteBlockedError(operation);
  }
  assertCustomer(customerId: string) {
    if (!this.customerIds.has(customerId)) throw new IxcCustomerNotAllowedError();
  }
  isAllowed(customerId: string) { return this.customerIds.has(customerId); }
  listMasked() { return [...this.customerIds].map((id)=>`${id.slice(0,3)}***${id.slice(-2)}`); }
}

export class IxcWriteBlockedError extends Error { constructor(operation:string){super(`Operação IXC bloqueada: ${operation}`);this.name="IxcWriteBlockedError";} }
export class IxcCustomerNotAllowedError extends Error { constructor(){super("Cadastro fora da allowlist de homologação");this.name="IxcCustomerNotAllowedError";} }
