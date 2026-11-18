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
  /** Sinal óptico da ONU, em dBm. `null` = sem leitura. */
  fiber?: Array<{ loginId: string; rxDbm: number | null; txDbm: number | null; readAt?: string }>;
}

/**
 * Faixas do sinal recebido pela ONU (GPON). Referência de campo, não norma: cada
 * fabricante define o seu limite, mas acima de -25 dBm é bom, entre -25 e -27 é limite
 * e abaixo de -27 dá erro, lentidão e queda — é caso de técnico, não de reinício.
 * Medido na base da BBNET em 18/11/2026: a maioria entre -17 e -25; uma em -30,96.
 */
export const SIGNAL_BORDERLINE = -25;
export const SIGNAL_CRITICAL = -27;
export type SignalLevel = "good" | "borderline" | "critical" | "none";
export interface FiberSignal { rxDbm: number | null; level: SignalLevel; readAt: string | null }

export function signalLevel(rxDbm: number | null): SignalLevel {
  if (rxDbm === null) return "none";
  if (rxDbm < SIGNAL_CRITICAL) return "critical";
  if (rxDbm < SIGNAL_BORDERLINE) return "borderline";
  return "good";
}
const dbmText = (value: number) => `${value.toFixed(2).replace(".", ",")} dBm`;

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
  /** Sinal da fibra na ONU; `null` quando o IXC não tem o dado (cliente sem fibra, leitura que falhou). */
  signal?: FiberSignal | null;
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
  const reading = login ? input.fiber?.find((item) => item.loginId === login.id) ?? input.fiber?.[0] : input.fiber?.[0];
  const signal: FiberSignal | null = reading ? { rxDbm: reading.rxDbm, level: signalLevel(reading.rxDbm), readAt: reading.readAt ?? null } : null;
  if (signal) {
    const at = signal.readAt ? `, lido em ${when(signal.readAt)}` : "";
    if (signal.level === "none") facts.push(`Sinal da fibra: sem leitura${at} — a ONU pode estar desligada, sem energia ou sem fibra chegando.`);
    else facts.push(`Sinal da fibra na ONU: ${dbmText(signal.rxDbm as number)} (${signal.level === "good" ? "bom" : signal.level === "borderline" ? "no limite" : "fraco, crítico"})${at}.`);
  }
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
      : signal?.level === "critical" ? "Sinal da fibra crítico com o login fora: problema na fibra ou na rede — reinício não resolve, precisa de técnico (OS)."
      : signal?.level === "none" ? "ONU sem leitura de sinal: conferir se está ligada na tomada e a luz LOS; LOS vermelha é técnico, senão reinício guiado e depois OS."
      : "Orientar o reinício do equipamento; se não voltar, abrir OS técnica.";
  } else if (login?.online === true) {
    verdict = "online";
    next = order ? `Conexão ativa e OS ${order.id} aberta: acompanhar a OS.`
      : signal && (signal.level === "critical" || signal.level === "borderline") ? "Conexão ativa, mas com sinal da fibra fraco: explica lentidão e quedas — precisa de técnico para corrigir a fibra."
      : "Conexão chega até o cliente com sinal bom: o problema está no Wi-Fi ou nos aparelhos — orientar antes de abrir OS.";
  } else {
    verdict = "unknown";
    next = "O IXC não deu dado suficiente: o atendente precisa verificar.";
  }
  return { at: new Date(now).toISOString(), verdict, facts, next, trustUnlockEligible, openServiceOrderId: order?.id ?? null, incident, signal };
}

export const VERDICT_LABELS: Record<DiagnosisVerdict, string> = {
  blocked: "Contrato bloqueado", offline: "Sem conexão", online: "Conexão ativa", unknown: "Inconclusivo",
};
