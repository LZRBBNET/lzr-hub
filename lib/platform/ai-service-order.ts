import { sanitizeHandoffText } from "../agent/handoff.ts";
import type { ServiceOrderInput } from "../integrations/ixc/write-client.ts";
import type { IxcServiceDiagnosisData } from "../integrations/ixc/types.ts";
import { requestServiceOrderOpen, type IxcWriteOperationsRepository } from "./ixc-write-service.ts";
import {
  NO_CONNECTION_SUBJECT, addressPartsFrom, addressSourceOf, bestTimeCode, isSaturdayInBrasilia, needsClimb, pickTechnician,
  renderAddress, technicianCandidates, vehicleFor, type Vehicle,
} from "./os-dispatch-shared.ts";
import type { TechnicianRoutesRepository } from "./technician-routes-service.ts";

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
export const AI_OS_SUBJECTS = { noConnection: "14", noConnectionMoto: "9", slow: "116", drops: "118", equipment: "49" } as const;
/** A família técnica que a IA abre: uma OS aberta de qualquer um deles já é "o chamado do problema". */
const AI_OS_FAMILY: ReadonlySet<string> = new Set(Object.values(AI_OS_SUBJECTS));

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
  // Visita técnica, chamado técnico e qualquer outro assunto técnico: pedido técnico pronto é OS (Vinícius, 27/11/2026 —
  // em 27/11 "sem internet, LOS vermelha, fio no poste" fechou como visita e nenhuma OS saiu). O assunto vem da ficha.
  if (!intent.startsWith("technical_")) return undefined;
  // Mudança de endereço também chega como visita: não é OS de suporte, a equipe trata.
  if (/mudanca de endereco|mudar de endereco|mudar de casa|mudei de casa|novo endereco|transferenc/.test(text)) return undefined;
  if (/roteador|onu\b|modem|equipamento/.test(text) && /troc|config|defeit|queim|novo|nao liga|quebr|de lugar/.test(text)) return AI_OS_SUBJECTS.equipment;
  if (drops) return AI_OS_SUBJECTS.drops;
  if (/lent|devagar|velocidade|travando|trava\b/.test(text)) return AI_OS_SUBJECTS.slow;
  return AI_OS_SUBJECTS.noConnection;
}

export type AiServiceOrderResult =
  | { status: "success"; orderId: string; detail: string; technicianId?: string; vehicle?: Vehicle }
  /** Já havia OS aberta: a IA informa o número e não abre outra (roteiro da BBNET). */
  | { status: "existing"; orderId: string; detail: string }
  /** Vários contratos ativos e a conexão não diz qual: a IA pergunta ao cliente em qual endereço está o problema. */
  | { status: "choose"; detail: string; options: ContractOption[] }
  | { status: "skipped" | "blocked" | "failed" | "unknown"; detail: string };

/** Um contrato ativo oferecido ao cliente: o endereço dele, como o cliente o reconhece. */
export interface ContractOption { contractId: string; label: string }
/** Mais contratos que isso viram ficha para a equipe: lista longa no WhatsApp ninguém lê, e cada um custa consultas ao IXC. */
export const MAX_CONTRACT_OPTIONS = 5;

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
    getServiceOrderAddressSources(customerId: string, contractId: string, loginId: string | undefined, correlationId: string): Promise<{ customer: Record<string, unknown>; contract: Record<string, unknown>; login?: Record<string, unknown> }>;
    getCityAndState(cityId: string, correlationId: string): Promise<{ name: string; state: string } | undefined>;
    getOsSubjectConfig(subjectId: string, correlationId: string): Promise<{ id: string; addressOrigin: string; addressFormat: string; loginRequired: boolean; active: boolean } | undefined>;
    countOpenOrdersOfTechnician(technicianId: string, correlationId: string): Promise<number>;
  };
  /** Cidade → técnicos. Sem ele (ou cidade sem linha), a OS nasce sem técnico e o setor distribui. */
  routes?: TechnicianRoutesRepository;
  now?: () => Date;
  ledger: IxcWriteOperationsRepository;
  open: (input: ServiceOrderInput, correlationId: string) => Promise<{ raw: Record<string, unknown> }>;
  correlationId: string;
}

export interface AiServiceOrderInput {
  customerId: string; ticketId: string; intent: string; summary: string; protocol: string | null;
  /** O contrato que o cliente escolheu na lista de endereços. */
  contractId?: string;
  /**
   * Pode perguntar ao cliente em qual endereço é: só com o titular provado pelo telefone (e o CPF, quando houve).
   * Identificado só pelo CPF, a lista de endereços iria para um número que não é do cadastro.
   */
  allowChoice?: boolean;
}

/**
 * O endereço de cada contrato, como o cliente reconhece ("Rua X, 120 - Centro"). Mesma fonte que a OS usa (cliente,
 * contrato ou login, pelo que o login manda). Endereços iguais ganham o número do contrato, senão a escolha seria cega.
 */
async function contractOptions(deps: AiServiceOrderDeps, customerId: string, contractIds: string[]): Promise<ContractOption[] | undefined> {
  try {
    const options = await Promise.all(contractIds.map(async (contractId) => {
      const sources = await deps.provider.getServiceOrderAddressSources(customerId, contractId, undefined, deps.correlationId);
      const which = addressSourceOf(sources.login?.endereco_padrao_cliente as string | undefined);
      const source = which === "customer" ? sources.customer : which === "contract" ? sources.contract : (sources.login ?? sources.customer);
      const parts = addressPartsFrom(source, sources.login, undefined);
      const label = [parts.street && `${parts.street}${parts.number ? `, ${parts.number}` : ""}`, parts.neighborhood].filter(Boolean).join(" - ");
      return { contractId, label: label || `contrato ${contractId}` };
    }));
    const seen = new Map<string, number>();
    for (const option of options) seen.set(option.label, (seen.get(option.label) ?? 0) + 1);
    return options.map((option) => (seen.get(option.label) ?? 0) > 1 ? { ...option, label: `${option.label} (contrato ${option.contractId})` } : option);
  } catch { return undefined; }
}

export async function openAiServiceOrder(deps: AiServiceOrderDeps, input: AiServiceOrderInput): Promise<AiServiceOrderResult | undefined> {
  const baseSubject = aiServiceOrderSubject(input.intent, input.summary);
  // Pedido técnico sem OS automática deixa o motivo na ficha: em 27/11 a OS "sumiu" sem rastro nenhum.
  if (!baseSubject) return input.intent.startsWith("technical_")
    ? { status: "skipped", detail: "Pedido técnico de mudança de endereço: não abre OS automática, a equipe trata." } : undefined;
  if (!deps.enabled) return { status: "skipped", detail: "FEATURE_AI_SERVICE_ORDER desligada: a ficha fica para a equipe abrir a OS." };
  const corr = deps.correlationId;
  try {
    // Lido agora, não do diagnóstico guardado: OS aberta há um minuto conta.
    const data = await deps.provider.getServiceDiagnosis(input.customerId, corr);
    // Só a família técnica conta como "já existe": OS antiga de outro assunto (cobrança, retirada)
    // não é o chamado deste problema — e bloquearia a OS para sempre (o 24088 tem 7 assim, de 2024).
    const open = data.openServiceOrders.find((item) => AI_OS_FAMILY.has(item.subjectId ?? ""));
    if (open) return { status: "existing", orderId: open.id, detail: `Já existe OS técnica aberta (nº ${open.id}); não abri outra.` };
    // Contrato e login lidos com prova de lista completa — o diagnóstico só traz 5 de cada.
    const active = await deps.provider.listActiveContracts(input.customerId, corr);
    if (!active.complete || active.ids.length === 0) return { status: "blocked", detail: `Contrato ativo não confirmado (${active.complete ? "nenhum ativo" : "lista incompleta"}): a equipe abre a OS no contrato certo.` };
    // Sem internet: a conexão que caiu diz onde é o problema. Lenta, quedas, Wi-Fi e roteador não aparecem no login.
    const noConnection = baseSubject === AI_OS_SUBJECTS.noConnection;
    let chosen: { id: string; logins: Array<{ id: string; online: boolean | null }>; complete: boolean } | undefined;
    if (input.contractId) {
      if (!active.ids.includes(input.contractId)) return { status: "blocked", detail: `O contrato escolhido (${input.contractId}) não está mais ativo: a equipe abre a OS.` };
      chosen = { id: input.contractId, ...await deps.provider.listContractLogins(input.customerId, input.contractId, corr) };
    } else if (active.ids.length === 1) {
      chosen = { id: active.ids[0], ...await deps.provider.listContractLogins(input.customerId, active.ids[0], corr) };
    } else {
      // Cliente com dois endereços (casa e escritório): OS no contrato errado manda o técnico para o lugar onde a internet
      // funciona (Vinícius, 27/11). Escolhe pela conexão caída; sem como saber, pergunta ao cliente.
      if (active.ids.length > MAX_CONTRACT_OPTIONS) return { status: "blocked", detail: `${active.ids.length} contratos ativos: a equipe abre a OS no contrato certo.` };
      const all = await Promise.all(active.ids.map(async (id) => ({ id, ...await deps.provider.listContractLogins(input.customerId, id, corr) })));
      const down = all.filter((item) => item.logins.some((login) => login.online === false));
      if (noConnection && all.every((item) => item.complete) && down.length === 1) chosen = down[0];
      else {
        const why = noConnection ? (down.length === 0 ? "nenhuma conexão aparece caída" : `${down.length} conexões caídas`) : "o problema não aparece na conexão";
        if (!input.allowChoice) return { status: "blocked", detail: `${active.ids.length} contratos ativos e ${why}: a equipe abre a OS no contrato certo.` };
        const options = await contractOptions(deps, input.customerId, all.map((item) => item.id));
        if (!options) return { status: "blocked", detail: `${active.ids.length} contratos ativos e ${why}; não consegui ler os endereços: a equipe abre a OS no contrato certo.` };
        return { status: "choose", detail: `${active.ids.length} contratos ativos e ${why}: a IA perguntou ao cliente em qual endereço é.`, options };
      }
    }
    const contract = { id: chosen.id };
    const ofContract = chosen;
    const online = ofContract.logins.filter((item) => item.online === true);
    const offline = ofContract.logins.filter((item) => item.online === false);
    // Sem internet, com mais de um login no contrato: o que caiu é o do problema.
    const login = !ofContract.complete ? undefined : ofContract.logins.length === 1 ? ofContract.logins[0]
      : noConnection && offline.length === 1 ? offline[0] : online.length === 1 ? online[0] : undefined;

    // Moto ou carro: poste/telhado (ou fibra sem sinal) é carro; dentro de casa é moto; sem saber, carro.
    const fiberRx = data.fiber?.find((item) => item.loginId === login?.id)?.rxDbm ?? null;
    const climb = needsClimb(input.summary, fiberRx);
    const vehicle = vehicleFor(climb);
    const subjectId = baseSubject === AI_OS_SUBJECTS.noConnection ? NO_CONNECTION_SUBJECT[vehicle] : baseSubject;
    // A configuração do assunto é a que a tela do IXC aplica: login obrigatório, de onde vem o endereço e o molde.
    const config = await deps.provider.getOsSubjectConfig(subjectId, corr);
    if (!config?.active) return { status: "blocked", detail: `Assunto ${subjectId} inativo ou não encontrado no IXC: a equipe abre a OS.` };
    if (!login && config.loginRequired) return { status: "blocked", detail: `Login do contrato ${contract.id} não ficou claro (${ofContract.logins.length} logins): a equipe abre a OS no login certo.` };

    const [confirmed, record, subjects, sectors] = await Promise.all([
      deps.provider.getServiceOrderContract(input.customerId, contract.id, corr),
      deps.provider.getCustomerRecord(input.customerId, corr),
      deps.provider.listOsSubjects(corr),
      deps.provider.listSectors(corr),
    ]);
    const branchId = String(record?.filial_id ?? "").trim() || undefined;

    // Endereço como a tela grava (100% das OS de atendente têm): fonte pelo login (S/C/N), texto pelo molde do assunto.
    // Falhou a leitura? A OS sai sem endereço — como antes —, e o detalhe diz isso.
    let address: ServiceOrderInput["address"];
    try {
      const sources = await deps.provider.getServiceOrderAddressSources(input.customerId, contract.id, login?.id, corr);
      const which = addressSourceOf(sources.login?.endereco_padrao_cliente as string | undefined);
      const source = which === "customer" ? sources.customer : which === "contract" ? sources.contract : (sources.login ?? sources.customer);
      const parts = addressPartsFrom(source, sources.login, await deps.provider.getCityAndState(String(source.cidade ?? ""), corr));
      if (parts.street) address = { text: renderAddress(config.addressFormat, parts), neighborhood: parts.neighborhood, cityId: parts.cityId, complement: parts.complement, reference: parts.reference, latitude: parts.latitude, longitude: parts.longitude };
    } catch { address = undefined; }

    // Técnico: os da cidade e do tipo, o com menos OS aberta, alternando no empate. Cidade sem rota → setor distribui.
    let technicianId: string | undefined;
    if (deps.routes && address?.cityId) {
      const candidates = technicianCandidates(await deps.routes.list(), address.cityId, climb, isSaturdayInBrasilia((deps.now ?? (() => new Date()))()));
      const loads = new Map<string, number>();
      for (const id of candidates) { try { loads.set(id, await deps.provider.countOpenOrdersOfTechnician(id, corr)); } catch { /* sem carga conhecida, fica de fora */ } }
      technicianId = pickTechnician(candidates, loads, await deps.routes.lastAssigned(address.cityId, vehicle));
    }

    // O técnico lê isto na OS: sem CPF, e-mail ou telefone, e dizendo quem abriu e por quê.
    const team = `Equipe indicada: ${vehicle === "carro" ? "carro (precisa subir em poste ou telhado, ou não deu para saber)" : "moto (serviço dentro de casa)"}${technicianId ? "" : " — sem técnico definido: o setor distribui"}.`;
    const message = sanitizeHandoffText(`Aberta pela IA do LZR HUB${input.protocol ? ` (protocolo ${input.protocol})` : ""}, depois de tentar resolver com o cliente pelo WhatsApp.\n${input.summary}\n${team}`).slice(0, 1800);
    const order: ServiceOrderInput = {
      customerId: input.customerId, contractId: contract.id, subjectId, sectorId: AI_OS_SECTOR, branchId: branchId ?? "", priority: AI_OS_PRIORITY, message,
      loginId: login?.id, technicianId, bestTime: bestTimeCode(input.summary), protocol: input.protocol ?? undefined, address,
    };
    const result = await requestServiceOrderOpen({
      customerId: input.customerId, contractId: contract.id, confirmedContract: confirmed, subjectId, sectorId: AI_OS_SECTOR, branchId,
      priority: AI_OS_PRIORITY, message, idempotencyKey: `ai-os:${input.ticketId}`, correlationId: corr, requestedBy: "ia@lzr-hub",
      knownSubjectIds: new Set(subjects.map((item) => item.id)), knownSectorIds: new Set(sectors.map((item) => item.id)),
      openSubjects: new Set(data.openServiceOrders.map((item) => item.subjectId ?? "").filter(Boolean)),
      // A reserva cliente+assunto de uma OS antiga só cai se o IXC confirmar que aquela OS foi fechada.
      settleStaleScope: async (previous) => {
        let recorded: { serviceOrderId?: unknown; contractId?: unknown } = {};
        try { recorded = JSON.parse(previous.detail ?? "{}"); } catch { return false; }
        const previousId = String(recorded.serviceOrderId ?? ""), previousContract = String(recorded.contractId ?? "");
        if (!/^[1-9]\d*$/.test(previousId) || !/^[1-9]\d*$/.test(previousContract)) return false;
        const state = await deps.provider.reconcileServiceOrder(input.customerId, previousContract, previousId, corr);
        return state.status === "F" || state.status === "C";
      },
    }, deps.ledger, (correlationId) => deps.open(order, correlationId));
    // Primeira abertura traz o número em `raw.id`; reentrega do webhook (mesma chave) traz em `serviceOrderId`.
    const orderId = String((result.raw as { id?: unknown } | undefined)?.id ?? (result as { serviceOrderId?: unknown }).serviceOrderId ?? "");
    const where = `assunto ${subjectId}, ${vehicle}, técnico ${technicianId ?? "não definido"}, endereço ${address ? "preenchido" : "não preenchido"}`;
    if (result.status === "success" && /^[1-9]\d*$/.test(orderId)) {
      // Lê de volta antes de dizer ao cliente: a OS existe, é deste cliente e deste contrato. Sem isso,
      // "Abri a OS nº X" dependeria só da resposta da escrita — o IXC já respondeu 200 com erro no corpo.
      const back = await deps.provider.reconcileServiceOrder(input.customerId, contract.id, orderId, corr).catch(() => undefined);
      if (!back) return { status: "unknown", detail: `${result.detail} (${where}) A OS nº ${orderId} não foi confirmada na releitura do IXC; confira antes de informar o cliente.` };
      if (technicianId && address?.cityId) await deps.routes?.setLastAssigned(address.cityId, vehicle, technicianId).catch(() => undefined);
      return { status: "success", orderId, detail: `${result.detail} (${where})`, technicianId, vehicle };
    }
    return { status: result.status === "success" ? "unknown" : result.status, detail: `${result.detail} (${where})` } as AiServiceOrderResult;
  } catch {
    // IXC fora, contrato não confirmado: a ficha continua valendo, a equipe abre a OS.
    return { status: "failed", detail: "Não consegui abrir a OS no IXC agora; a ficha ficou para a equipe." };
  }
}
