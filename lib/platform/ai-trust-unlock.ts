import type { IxcTrustUnlockFacts } from "../integrations/ixc/types.ts";
import type { IxcWriteOperationsRepository } from "./ixc-write-service.ts";
import { DEBT_BLOCK_STATUSES, TRUST_UNLOCK_TEXT, trustUnlockDecision, type TrustUnlockReason } from "./trust-unlock-shared.ts";

/**
 * A IA libera a internet em confiança no IXC (modo autônomo, `FEATURE_AI_TRUST_UNLOCK`).
 *
 * Só chega aqui quando o roteiro já tentou o pagamento e o cliente pediu para liberar.
 * Quem dispara é o modelo (`action: "trust_unlock"`), mas quem decide é este código:
 *   titular confirmado pelo CPF neste atendimento → contrato bloqueado por atraso, lido agora →
 *   regra da BBNET (`trustUnlockDecision`) → idempotência (um desbloqueio por atendimento) →
 *   flags → IXC. Tudo no ledger `ixc_write_operations`, inclusive o negado.
 */

export const TRUST_UNLOCK_OPERATION = "contract.trust_unlock";

export type TrustUnlockOutcome =
  | { status: "done"; text: string; contractId: string }
  | { status: "needs_cpf" | "denied" | "refused" | "failed" | "skipped"; text: string; reason?: TrustUnlockReason | string };

export interface AiTrustUnlockDeps {
  enabled: boolean;
  provider: {
    listTrustUnlockContracts(customerId: string, correlationId: string): Promise<Array<{ id: string; status: string; internetStatus: string }>>;
    getTrustUnlockFacts(customerId: string, contractId: string, correlationId: string, allowCustomerPaymentHistory: boolean): Promise<IxcTrustUnlockFacts>;
  };
  ledger: IxcWriteOperationsRepository;
  unlock: (contractId: string, correlationId: string) => Promise<{ raw: Record<string, unknown> }>;
  correlationId: string;
  now?: () => Date;
}

export interface AiTrustUnlockInput { customerId: string; ticketId: string; holderVerified: boolean; promisedDate?: string }

const CONTRACT_REVIEW_TEXT = "Não consegui confirmar com segurança qual contrato pode ser liberado. Posso orientar você a falar com a equipe para conferir o contrato certo.";

const DENIAL_TEXT: Partial<Record<TrustUnlockReason, string>> = {
  not_blocked: TRUST_UNLOCK_TEXT.notBlocked, manual_block: TRUST_UNLOCK_TEXT.manualBlock,
  already_active: TRUST_UNLOCK_TEXT.alreadyActive, used_last_month_late: TRUST_UNLOCK_TEXT.usedLate,
};

export async function aiTrustUnlock(deps: AiTrustUnlockDeps, input: AiTrustUnlockInput): Promise<TrustUnlockOutcome> {
  if (!deps.enabled) return { status: "skipped", text: TRUST_UNLOCK_TEXT.refused, reason: "FEATURE_AI_TRUST_UNLOCK desligada" };
  // O telefone sozinho não basta para mexer no contrato: o mesmo CPF que libera a fatura.
  if (!input.holderVerified) return { status: "needs_cpf", text: TRUST_UNLOCK_TEXT.needsCpf };
  const key = `ai-unlock:${input.ticketId}`;
  try {
    const previous = await deps.ledger.findByIdempotencyKey(TRUST_UNLOCK_OPERATION, key);
    if (previous?.status === "success" && previous.customerId === input.customerId) return { status: "done", text: TRUST_UNLOCK_TEXT.done, contractId: previous.invoiceId ?? "" };
    if (previous) return { status: "refused", text: TRUST_UNLOCK_TEXT.refused, reason: "Já houve uma tentativa neste atendimento." };

    const contracts = await deps.provider.listTrustUnlockContracts(input.customerId, deps.correlationId);
    const blocked = contracts.filter((contract) => contract.status === "A" &&
      (DEBT_BLOCK_STATUSES.has(contract.internetStatus) || contract.internetStatus === "CM"));
    if (blocked.length > 1) return { status: "denied", text: CONTRACT_REVIEW_TEXT, reason: "multiple_blocked_contracts" };
    const contract = blocked[0];
    if (!contract) return { status: "denied", text: TRUST_UNLOCK_TEXT.notBlocked, reason: "not_blocked" };
    if (contract.internetStatus === "CM") return { status: "denied", text: TRUST_UNLOCK_TEXT.manualBlock, reason: "manual_block" };
    const facts = await deps.provider.getTrustUnlockFacts(input.customerId, contract.id, deps.correlationId, contracts.length === 1);
    if (facts.contractId !== contract.id) return { status: "denied", text: CONTRACT_REVIEW_TEXT, reason: "contract_scope_unverified" };
    const decision = trustUnlockDecision(facts, (deps.now ?? (() => new Date()))());
    const ledgerEntry = { operation: TRUST_UNLOCK_OPERATION, idempotencyKey: key, customerId: input.customerId, invoiceId: contract.id, requestedBy: "ia@lzr-hub", correlationId: deps.correlationId };
    if (!decision.allowed) {
      await deps.ledger.record({ ...ledgerEntry, status: "blocked", detail: `Regra da BBNET: ${decision.reason}` }).catch(() => undefined);
      return { status: "denied", text: DENIAL_TEXT[decision.reason] ?? TRUST_UNLOCK_TEXT.refused, reason: decision.reason };
    }
    if (process.env.FEATURE_IXC_WRITE !== "true") {
      await deps.ledger.record({ ...ledgerEntry, status: "blocked", detail: "FEATURE_IXC_WRITE desligada" }).catch(() => undefined);
      return { status: "skipped", text: TRUST_UNLOCK_TEXT.refused, reason: "FEATURE_IXC_WRITE desligada" };
    }
    // Reserva antes do IXC: reentrega do webhook não libera duas vezes.
    if (!await deps.ledger.claim({ ...ledgerEntry, status: "pending", detail: `Reservado (${decision.reason}${input.promisedDate ? `, pagamento prometido para ${input.promisedDate}` : ""}).` })) {
      return { status: "refused", text: TRUST_UNLOCK_TEXT.refused, reason: "Reserva já existente." };
    }
    try {
      await deps.unlock(contract.id, deps.correlationId);
      await deps.ledger.finishClaim(key, "success", `Desbloqueio de confiança feito pela IA (${decision.reason}).`, TRUST_UNLOCK_OPERATION);
      return { status: "done", text: TRUST_UNLOCK_TEXT.done, contractId: contract.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // Recusa explícita do IXC (HTTP 200 + type error): nada mudou no contrato.
      const refused = message.startsWith("IXC_RECUSOU");
      await deps.ledger.finishClaim(key, refused ? "blocked" : "unknown", refused ? message.slice(0, 240) : "Resultado não confirmado; conferir o contrato no IXC.", TRUST_UNLOCK_OPERATION).catch(() => undefined);
      return { status: refused ? "refused" : "failed", text: refused ? TRUST_UNLOCK_TEXT.refused : TRUST_UNLOCK_TEXT.failed, reason: message.slice(0, 120) };
    }
  } catch {
    return { status: "failed", text: CONTRACT_REVIEW_TEXT, reason: "contract_evidence_unavailable" };
  }
}
