/**
 * Diagnóstico de "sem internet / lenta": o que os bots de provedor fazem antes
 * de abrir chamado (SimplesDesk, Talqui, ConectaAI) — contrato bloqueado? login
 * online? massiva na região? já tem OS aberta?
 *
 * Regras puras, sem IXC nem banco: entram os dados já lidos e sai o veredito com
 * o próximo passo. Fica gravado no atendimento e aparece ao atendente; a IA
 * ainda não age por ele (fase de observação).
 *
 * Nenhum código do IXC é traduzido por palpite: o que não está na tabela abaixo
 * aparece como "código X".
 */

export interface DiagnosisInput {
  logins: Array<{ id: string; contractId?: string; online: boolean | null; lastConnectedAt?: string; lastDisconnectedAt?: string; disconnectReason?: string; neighborhood?: string }>;
  contracts: Array<{ id: string; status: string; internetStatus: string; trustUnlockActive: boolean }>;
  openServiceOrders: Array<{ id: string; status: string; subjectId?: string; openedAt?: string }>;
}

export interface ActiveIncident { title: string; city: string; neighborhood: string; startedAt: string }

export type DiagnosisVerdict = "blocked" | "offline" | "online" | "unknown";

export interface ConnectionDiagnosis {
  at: string;
  verdict: DiagnosisVerdict;
  /** O que foi constatado, em frases para quem atende. */
  facts: string[];
  /** O que a IA faria — ou o que o atendente deve fazer. */
  next: string;
  trustUnlockEligible: boolean;
  openServiceOrderId: string | null;
  incident: ActiveIncident | null;
}

/** `status_internet` do contrato, como aparece no IXC. */
export const INTERNET_STATUS: Record<string, string> = {
  A: "ativo", D: "desativado", CM: "bloqueado manualmente", CA: "bloqueado automaticamente",
  FA: "financeiro em atraso", AA: "aguardando assinatura",
};
const BLOCKED = new Set(["CM", "CA", "FA"]);
/** Bloqueio por atraso: é o que o desbloqueio de confiança resolve. Bloqueio manual é decisão de alguém. */
const DEBT_BLOCK = new Set(["CA", "FA"]);

const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const statusLabel = (code: string) => INTERNET_STATUS[code] ?? `código ${code || "vazio"}`;
const when = (value?: string) => (value ? value.replace(/^(\d{4})-(\d{2})-(\d{2})\s?(\d{2}:\d{2})?.*$/, (_m, y, mo, d, hm) => `${d}/${mo}/${y}${hm ? ` ${hm}` : ""}`) : "sem data");

export function diagnoseConnection(input: DiagnosisInput, incidents: ActiveIncident[], now = Date.now()): ConnectionDiagnosis {
  const facts: string[] = [];
  const contract = input.contracts.find((c) => c.status === "A") ?? input.contracts[0];
  const login = (contract && input.logins.find((l) => l.contractId === contract.id)) ?? input.logins[0];
  const order = input.openServiceOrders[0] ?? null;
  const incident = login?.neighborhood ? incidents.find((i) => normalize(i.neighborhood) === normalize(login.neighborhood ?? "")) ?? null : null;

  if (contract) facts.push(`Contrato ${contract.id}: internet ${statusLabel(contract.internetStatus)}${contract.trustUnlockActive ? " (em desbloqueio de confiança)" : ""}.`);
  else facts.push("Nenhum contrato encontrado no IXC.");
  if (login) {
    if (login.online === true) facts.push(`Login conectado agora (desde ${when(login.lastConnectedAt)}).`);
    else if (login.online === false) facts.push(`Login desconectado desde ${when(login.lastDisconnectedAt)}${login.disconnectReason ? ` — motivo informado pelo concentrador: ${login.disconnectReason}` : ""}.`);
    else facts.push("O IXC não informou se o login está conectado.");
  } else facts.push("Nenhum login de conexão encontrado.");
  if (incident) facts.push(`Massiva registrada no bairro ${incident.neighborhood} (${incident.city}): "${incident.title}", desde ${when(incident.startedAt)}.`);
  if (order) facts.push(`Já existe OS aberta: nº ${order.id}, de ${when(order.openedAt)}.`);
  const blocked = !!contract && BLOCKED.has(contract.internetStatus);
  const trustUnlockEligible = !!contract && DEBT_BLOCK.has(contract.internetStatus) && !contract.trustUnlockActive;

  let verdict: DiagnosisVerdict;
  let next: string;
  if (blocked) {
    verdict = "blocked";
    next = trustUnlockEligible
      ? "Bloqueio por atraso: encaminhar ao financeiro — o contrato pode receber desbloqueio de confiança."
      : contract?.internetStatus === "CM" ? "Bloqueio manual: só quem bloqueou decide liberar." : "Contrato bloqueado e já em desbloqueio de confiança: encaminhar ao financeiro.";
  } else if (login?.online === false) {
    verdict = "offline";
    next = incident ? "Avisar o cliente da massiva em andamento; não abrir OS individual."
      : order ? `Acompanhar a OS ${order.id} já aberta, em vez de abrir outra.`
      : "Orientar o reinício do equipamento; se não voltar, abrir OS técnica.";
  } else if (login?.online === true) {
    verdict = "online";
    next = order ? `Conexão ativa e OS ${order.id} aberta: acompanhar a OS.` : "Conexão chega até o cliente: verificar Wi-Fi e aparelhos antes de abrir OS.";
  } else {
    verdict = "unknown";
    next = "O IXC não deu dado suficiente: o atendente precisa verificar.";
  }
  return { at: new Date(now).toISOString(), verdict, facts, next, trustUnlockEligible, openServiceOrderId: order?.id ?? null, incident };
}

export const VERDICT_LABELS: Record<DiagnosisVerdict, string> = {
  blocked: "Contrato bloqueado", offline: "Sem conexão", online: "Conexão ativa", unknown: "Inconclusivo",
};
