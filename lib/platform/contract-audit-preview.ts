import { evaluateContact, readAuditContact, type ContractIssueCode } from "./contract-audit-shared.ts";

type Row = Record<string, unknown>;
type PreviewProvider = {
  getContractForAudit(customerId: string, contractId: string, correlationId: string): Promise<Row | undefined>;
  getCustomerRecord(customerId: string, correlationId: string): Promise<Row | undefined>;
  rateLimitRemaining(): number;
};

export const validAuditId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,31}$/.test(value);
/** O resultado não contém cadastro, dados financeiros nem valores de contato. */
export async function previewContract(provider: PreviewProvider, customerId: string, contractId: string, correlationId: string, now = () => new Date()) {
  const unverified = (detail: string) => ({ status: "unverified" as const, detail, checkedAt: now().toISOString(), issues: [] as ContractIssueCode[] });
  if (!validAuditId(customerId) || !validAuditId(contractId)) return unverified("Identificadores inválidos.");
  if (provider.rateLimitRemaining() <= 10) return unverified("Consulta adiada para preservar o atendimento.");
  try {
    const contract = await provider.getContractForAudit(customerId, contractId, correlationId);
    if (!contract || String(contract.id) !== contractId || String(contract.id_cliente) !== customerId) {
      return unverified("O vínculo atual do contrato não foi confirmado no IXC.");
    }
    if (provider.rateLimitRemaining() <= 10) return unverified("Consulta adiada para preservar o atendimento.");
    const customer = await provider.getCustomerRecord(customerId, correlationId);
    if (!customer || String(customer.id) !== customerId) return unverified("O cadastro correspondente não foi confirmado no IXC.");
    const contact = readAuditContact(customer);
    if (!contact) return unverified("O IXC não forneceu todos os campos necessários para a conferência.");
    const issues = evaluateContact(contact).map(({code}) => code);
    return { status: issues.length ? "pending" as const : "ok" as const, checkedAt: now().toISOString(), issues };
  } catch {
    return unverified("Consulta não concluída. Verifique a integração e o acesso ao cadastro de homologação.");
  }
}
