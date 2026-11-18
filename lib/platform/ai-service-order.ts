import { sanitizeHandoffText } from "../agent/handoff.ts";
import type { ServiceOrderInput } from "../integrations/ixc/write-client.ts";
import type { IxcServiceDiagnosisData } from "../integrations/ixc/types.ts";
import { requestServiceOrderOpen, type IxcWriteOperationsRepository } from "./ixc-write-service.ts";

/**
 * A IA abre a ordem de serviço no IXC sozinha (modo autônomo), quando o atendimento
 * técnico termina com o pedido pronto e o problema não se resolveu à distância.
 *
 * Assuntos e setor escolhidos pelo Vinícius em 18/11/2026, entre os 159 assuntos reais
 * do IXC da BBNET (`scripts/ixc-probe-os-catalog.mjs`):
 *   sem internet → 14 SEM FUNCIONAR/EQUIPE CARRO · lenta → 116 SUPORTE INTERNET LENTA ·
 *   quedas → 118 SUPORTE INTERNET COM QUEDA · troca/configuração de roteador → 49 TROCAR
 *   ONU OU ROTEADOR · todos no setor 1 TECNICO, prioridade "N" (a padrão desses assuntos).
 * Mudança de endereço e cancelamento ficam com a ficha para a equipe, sem OS automática.
 *
 * Provado no piloto de 18/11 (OS 301041, cadastro de teste 21857): o IXC responde
 * `{type:"success", message:"Registro inserido com sucesso!", id}`; assunto com
 * `login_obrigatorio = S` exige `id_login` e `origem_endereco = "L"`.
 *
 * Mesma régua de toda escrita no ERP (`requestServiceOrderOpen`): idempotência pela
 * chave do atendimento (uma OS por atendimento, mesmo com o webhook reentregue),
 * política (catálogo, filial, contrato ativo e do cliente, OS repetida), flag, e tudo
 * no ledger `ixc_write_operations` — inclusive o bloqueado. Nada aqui afirma ao cliente
 * uma OS que o IXC não devolveu com número.
 */

export const AI_OS_SECTOR = "1";
export const AI_OS_PRIORITY = "N";
export const AI_OS_SUBJECTS = { noConnection: "14", slow: "116", drops: "118", equipment: "49" } as const;

const normalize = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Qual assunto de OS cabe ao pedido — ou nenhum (não é caso de OS automática). Quedas pesam
 * mais que o assunto classificado: "cai toda hora" chega como sem internet ou lenta.
 */
export function aiServiceOrderSubject(intent: string, summary: string): string | undefined {
  const text = normalize(summary);
  const drops = /\bqueda|\bcai\b|caindo|cai e volta|desconect|oscila/.test(text);
  if (intent === "technical_no_connection" || intent === "technical_restart") return drops ? AI_OS_SUBJECTS.drops : AI_OS_SUBJECTS.noConnection;
  if (intent === "technical_slow" || intent === "technical_wifi") return drops ? AI_OS_SUBJECTS.drops : AI_OS_SUBJECTS.slow;
  if (intent === "technical_visit" || intent === "technical_ticket") {
    // Mudança de endereço também chega como visita: não é troca de equipamento.
    if (/endereco|mudanca|mudar de casa|transferenc/.test(text)) return undefined;
    if (/roteador|onu\b|modem|equipamento/.test(text) && /troc|config|defeit|queim|novo|parou|nao liga|quebr/.test(text)) return AI_OS_SUBJECTS.equipment;
  }
  return undefined;
}

export type AiServiceOrderResult =
  | { status: "success"; orderId: string; detail: string }
  /** Já havia OS aberta: a IA informa o número e não abre outra (roteiro da BBNET). */
  | { status: "existing"; orderId: string; detail: string }
  | { status: "skipped" | "blocked" | "failed" | "unknown"; detail: string };

export interface AiServiceOrderDeps {
  enabled: boolean;
  provider: {
    getServiceDiagnosis(customerId: string, correlationId: string): Promise<IxcServiceDiagnosisData>;
    getServiceOrderContract(customerId: string, contractId: string, correlationId: string): Promise<{ id: string; customerId: string; status: string }>;
    getCustomerRecord(customerId: string, correlationId: string): Promise<Record<string, unknown> | undefined>;
    listOsSubjects(correlationId: string): Promise<Array<{ id: string }>>;
    listSectors(correlationId: string): Promise<Array<{ id: string }>>;
  };
  ledger: IxcWriteOperationsRepository;
  open: (input: ServiceOrderInput, correlationId: string) => Promise<{ raw: Record<string, unknown> }>;
  correlationId: string;
}

export interface AiServiceOrderInput { customerId: string; ticketId: string; intent: string; summary: string; protocol: string | null }

export async function openAiServiceOrder(deps: AiServiceOrderDeps, input: AiServiceOrderInput): Promise<AiServiceOrderResult | undefined> {
  const subjectId = aiServiceOrderSubject(input.intent, input.summary);
  if (!subjectId) return undefined;
  if (!deps.enabled) return { status: "skipped", detail: "FEATURE_AI_SERVICE_ORDER desligada: a ficha fica para a equipe abrir a OS." };
  try {
    // Lido agora, não do diagnóstico guardado: OS aberta há um minuto conta.
    const data = await deps.provider.getServiceDiagnosis(input.customerId, deps.correlationId);
    const open = data.openServiceOrders[0];
    if (open) return { status: "existing", orderId: open.id, detail: `Já existe OS aberta (nº ${open.id}); não abri outra.` };
    const contract = data.contracts.find((item) => item.status === "A");
    if (!contract || data.contracts.filter((item) => item.status === "A").length > 1) return { status: "blocked", detail: "Contrato ativo único não encontrado: a equipe abre a OS no contrato certo." };
    const login = data.logins.find((item) => item.contractId === contract.id) ?? (data.logins.length === 1 ? data.logins[0] : undefined);
    const [confirmed, record, subjects, sectors] = await Promise.all([
      deps.provider.getServiceOrderContract(input.customerId, contract.id, deps.correlationId),
      deps.provider.getCustomerRecord(input.customerId, deps.correlationId),
      deps.provider.listOsSubjects(deps.correlationId),
      deps.provider.listSectors(deps.correlationId),
    ]);
    const branchId = String(record?.filial_id ?? "").trim() || undefined;
    // O técnico lê isto na OS: sem CPF, e-mail ou telefone, e dizendo quem abriu e por quê.
    const message = sanitizeHandoffText(`Aberta pela IA do LZR HUB${input.protocol ? ` (protocolo ${input.protocol})` : ""}, depois de tentar resolver com o cliente pelo WhatsApp.\n${input.summary}`).slice(0, 1800);
    const order: ServiceOrderInput = { customerId: input.customerId, contractId: contract.id, subjectId, sectorId: AI_OS_SECTOR, branchId: branchId ?? "", priority: AI_OS_PRIORITY, message, loginId: login?.id };
    const result = await requestServiceOrderOpen({
      customerId: input.customerId, contractId: contract.id, confirmedContract: confirmed, subjectId, sectorId: AI_OS_SECTOR, branchId,
      priority: AI_OS_PRIORITY, message, idempotencyKey: `ai-os:${input.ticketId}`, correlationId: deps.correlationId, requestedBy: "ia@lzr-hub",
      knownSubjectIds: new Set(subjects.map((item) => item.id)), knownSectorIds: new Set(sectors.map((item) => item.id)),
      openSubjects: new Set(data.openServiceOrders.map((item) => item.subjectId ?? "").filter(Boolean)),
    }, deps.ledger, (correlationId) => deps.open(order, correlationId));
    // Primeira abertura traz o número em `raw.id`; reentrega do webhook (mesma chave) traz em `serviceOrderId`.
    const orderId = String((result.raw as { id?: unknown } | undefined)?.id ?? (result as { serviceOrderId?: unknown }).serviceOrderId ?? "");
    if (result.status === "success" && /^[1-9]\d*$/.test(orderId)) return { status: "success", orderId, detail: result.detail };
    return { status: result.status === "success" ? "unknown" : result.status, detail: result.detail } as AiServiceOrderResult;
  } catch {
    // IXC fora, contrato não confirmado: a ficha continua valendo, a equipe abre a OS.
    return { status: "failed", detail: "Não consegui abrir a OS no IXC agora; a ficha ficou para a equipe." };
  }
}
