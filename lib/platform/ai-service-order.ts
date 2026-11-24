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
/** A família técnica que a IA abre: uma OS aberta de qualquer um deles já é "o chamado do problema". */
const AI_OS_FAMILY: ReadonlySet<string> = new Set(Object.values(AI_OS_SUBJECTS));
/** Assuntos com `login_obrigatorio = S` no IXC: sem um login certo, não abre. */
const LOGIN_REQUIRED: ReadonlySet<string> = new Set([AI_OS_SUBJECTS.noConnection, AI_OS_SUBJECTS.equipment]);

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
    listActiveContracts(customerId: string, correlationId: string): Promise<{ ids: string[]; complete: boolean }>;
    listContractLogins(customerId: string, contractId: string, correlationId: string): Promise<{ logins: Array<{ id: string; online: boolean | null }>; complete: boolean }>;
    reconcileServiceOrder(customerId: string, contractId: string, orderId: string, correlationId: string): Promise<{ id: string; customerId: string; contractId: string; status: string }>;
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
    // Só a família técnica conta como "já existe": OS antiga de outro assunto (cobrança, retirada)
    // não é o chamado deste problema — e bloquearia a OS para sempre (o 24088 tem 7 assim, de 2024).
    const open = data.openServiceOrders.find((item) => AI_OS_FAMILY.has(item.subjectId ?? ""));
    if (open) return { status: "existing", orderId: open.id, detail: `Já existe OS técnica aberta (nº ${open.id}); não abri outra.` };
    // Contrato e login lidos com prova de lista completa — o diagnóstico só traz 5 de cada.
    const active = await deps.provider.listActiveContracts(input.customerId, deps.correlationId);
    if (!active.complete || active.ids.length !== 1) return { status: "blocked", detail: `Contrato ativo único não confirmado (${active.complete ? `${active.ids.length} ativos` : "lista incompleta"}): a equipe abre a OS no contrato certo.` };
    const contract = { id: active.ids[0] };
    const ofContract = await deps.provider.listContractLogins(input.customerId, contract.id, deps.correlationId);
    const online = ofContract.logins.filter((item) => item.online === true);
    const login = !ofContract.complete ? undefined : ofContract.logins.length === 1 ? ofContract.logins[0] : online.length === 1 ? online[0] : undefined;
    if (!login && LOGIN_REQUIRED.has(subjectId)) return { status: "blocked", detail: `Login do contrato ${contract.id} não ficou claro (${ofContract.logins.length} logins): a equipe abre a OS no login certo.` };
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
    if (result.status === "success" && /^[1-9]\d*$/.test(orderId)) {
      // Lê de volta antes de dizer ao cliente: a OS existe, é deste cliente e deste contrato. Sem isso,
      // "Abri a OS nº X" dependeria só da resposta da escrita — o IXC já respondeu 200 com erro no corpo.
      const back = await deps.provider.reconcileServiceOrder(input.customerId, contract.id, orderId, deps.correlationId).catch(() => undefined);
      if (!back) return { status: "unknown", detail: `${result.detail} A OS nº ${orderId} não foi confirmada na releitura do IXC; confira antes de informar o cliente.` };
      return { status: "success", orderId, detail: result.detail };
    }
    return { status: result.status === "success" ? "unknown" : result.status, detail: result.detail } as AiServiceOrderResult;
  } catch {
    // IXC fora, contrato não confirmado: a ficha continua valendo, a equipe abre a OS.
    return { status: "failed", detail: "Não consegui abrir a OS no IXC agora; a ficha ficou para a equipe." };
  }
}
