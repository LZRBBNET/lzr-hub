import type { ChatMessage } from "./types.ts";

const normal = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Customer reports only; these are not verified equipment actions or authority. */
export function restartReport(message: string): "done" | "not_done" | undefined {
  let report: "done" | "not_done" | undefined;
  for (let clause of normal(message).split(/(?<=\?)|[.!;]|\bmas\b|\bporem\b/)) {
    clause = clause.replace(/,?\s+(?:o que (?:eu )?(?:faco|fazer)|e agora|como (?:eu )?(?:procedo|resolvo))\s*\?$/, "");
    if (/\?|\b(?:se|caso|talvez|acho que)\b/.test(clause)) continue;
    const action = /\b(?:reiniciei|reiniciamos)\b|\bdesliguei\b.{0,40}\bliguei\b/.exec(clause);
    if (!action) continue;
    const before = clause.slice(0, action.index).split(",").at(-1) ?? "";
    report = /\b(?:nao|nem)\b/.test(before) || /\bdesliguei\b.{0,30}\bnao liguei\b/.test(clause) ? "not_done" : "done";
  }
  return report;
}

export function asksRestart(message: string): boolean {
  const text = normal(message);
  if (/\bnao (?:quero|preciso|devo|pode|vou|vamos)\b/.test(text)) return false;
  return /\b(?:como|posso|devo|preciso|quero|pode|poderia)\b.{0,35}\b(?:reiniciar|reinicio|reinicie|reinicia|reboot|desligar)\b/.test(text)
    || /^(?:por favor[, ]+)?(?:reinicia|reinicie|reiniciem|reiniciar|reboot)\b/.test(text);

}

export function reportsConnectionResolved(message: string): boolean {
  const text = normal(message).replace(/[, ]+nao precisa (?:mais|de mais nada)[.!]?$/, "");
  if (/\?|\b(?:nao|nem|se|caso|ainda|continua|caiu|cai|lenta|lento|travando|trava|so|apenas|falha|falhar|sem internet|sem conexao)\b/.test(text)) return false;
  return /\b(?:internet|conexao)\b.{0,25}\b(?:voltou|normalizou|funcionando)\b|\bagora (?:esta |ta )?(?:normal|funcionando)|\bproblema (?:foi )?resolvido\b/.test(text);
}

export function troubleshootingContext(message: string, history: ChatMessage[]) {
  // Do not import attempts from an episode the customer already said ended.
  const lastResolved = history.findLastIndex((turn) => turn.role === "customer" && (reportsConnectionResolved(turn.content) || startsNewSupportTopic(turn.content)));
  const recent = (startsNewSupportTopic(message) ? [] : history.slice(lastResolved + 1)).filter((turn) => turn.role === "customer" || turn.role === "agent");
  let restarted: boolean | undefined;
  let attemptedWithoutResult = false;
  let previousAgent = "";
  for (const turn of [...recent, { role: "customer", content: message }]) {
    if (turn.role === "agent") { previousAgent = normal(turn.content); continue; }
    const text = normal(turn.content);
    if (/\btentei (?:reiniciar|desligar)\b/.test(text) && !/\?|\bnao tentei\b/.test(text)) attemptedWithoutResult = true;
    const report = restartReport(turn.content);
    if (report) { restarted = report === "done"; attemptedWithoutResult = false; }
    else if (/^o roteador (?:ja )?foi reiniciado\?$|^(?:o roteador |voce |ja )?(?:ja )?reinici(?:ou|ou o roteador)\??$|^(?:para reiniciar.{0,60})?tire da tomada|^desligue.{0,40}ligue/.test(previousAgent)) {
      if (/^(?:nao funcionou|nao resolveu)/.test(text)) attemptedWithoutResult = true;
      if (/^(?:sim|ja fiz|fiz isso|fiz isso tudo|fiz o que pediu)(?:[,.! ]|$)/.test(text)) restarted = true;
      if (/^(?:nao|ainda nao)(?:[,.! ]|$)/.test(text) && !/nao funcionou|nao resolveu/.test(text)) restarted = false;
    }
    previousAgent = "";
  }
  return { restarted: restarted === true, attemptedWithoutResult, recent, resolved: reportsConnectionResolved(message) };
}

export type SupportRequest = "pause" | "human" | "visit" | "ticket";

/** Explicit operational preferences, never authority to create an OS or visit. */
export function supportRequest(message: string): SupportRequest | undefined {
  const text = normal(message);
  const paused = /\bnao (?:posso|consigo) (?:ficar )?(?:falar|conversar|conversando|responder)(?:\s+agora|\s|$)/.test(text)
    || /\bnao (?:estou |to |tenho |tenho mais )?(?:com )?tempo\b/.test(text)
    || /^(?:estou |to )?sem tempo\b/.test(text)
    || /\bnao (?:me )?(?:faca|mande) (?:mais )?perguntas\b/.test(text);
  let result: SupportRequest | undefined;
  for (const clause of text.split(/[.!?;,]|\bmas\b|\be (?=(?:quero|preciso|prefiro)\b)/)) {
    if (/\b(?:nao|nem) (?:quero|preciso|precisa|pode|mande|manda|chame|chama|abra|abre|agende|agendar|tecnico|atendente|chamado|visita)\b/.test(clause)) continue;
    if (/\b(?:humano|humana|atendente|supervisor|pessoa de verdade)\b/.test(clause)) result = "human";
    else if (/\b(?:abrir|abre|abra|preciso|quero|pode)\b.{0,35}\b(?:chamado|protocolo tecnico)\b|\bchamado tecnico\b/.test(clause)) result = "ticket";
    else if (/\b(?:quero|preciso|mande|manda|mandar|envie|envia|enviar|chama|chamar)\b.{0,35}\btecnico\b|\b(?:mandar|mande|manda|envie) alguem (?:vir|vim)\b|\bvisita\b|\bagendar\b|\bagenda.{0,30}tecnico\b|\bhorario.{0,30}tecnico\b/.test(clause)) result = "visit";
  }
  return result ?? (paused ? "pause" : undefined);
}

export function negatesSupportRequest(message: string): boolean {
  return /\b(?:nao|nem)\b.{0,45}\b(?:tecnico|atendente|humano|chamado|visita|agendar)\b/.test(normal(message));
}

/** Small fixed-vocabulary summary: no copied identifiers, diagnoses or action claims. */
export function supportReportSummary(message: string, history: ChatMessage[]): string {
  const context = troubleshootingContext(message, history);
  const reports = [...context.recent.filter((turn) => turn.role === "customer").map((turn) => normal(turn.content)), normal(message)]
    .filter((text) => !/\?|\b(?:se|caso|talvez|posso|quero|devo|preciso|pretendo|vou|poderia|testar)\b/.test(text));
  // Keep corrective negatives in the timeline: omitting them resurrects stale
  // positives. If a last report is ambiguous, omit that fact rather than assert it.
  const slow = reports.findLast((text) => /\b(?:lenta|lento|lentidao|trava|travando)\b/.test(text));
  const games = reports.findLast((text) => /\bpartidas? online\b/.test(text));
  const cable = reports.findLast((text) => /\bcabo\b/.test(text));
  const affirmative = (text: string | undefined) => !!text && !/\b(?:nao|nem)\b/.test(text);
  const facts: string[] = [];
  if (affirmative(slow)) facts.push("lentidão relatada");
  if (context.restarted) facts.push("reinício já tentado");
  if (affirmative(games) && /\bcai\b/.test(games!)) facts.push("quedas em partidas online");
  if (affirmative(cable) && /\b(?:pelo|no|por|via) cabo\b/.test(cable!) && /wi-?fi/.test(cable!) && !/\bsem cabo/.test(cable!)) facts.push("uso de cabo e Wi-Fi");
  return facts.length ? `Pelo que você contou: ${facts.slice(0, 3).join(", ")}. ` : "";
}

/** Explicit topic boundaries only; no inference that an old diagnosis is current. */
export function startsNewSupportTopic(message: string): boolean {
  const text = normal(message);
  return !/\b(?:nao|nem)\b/.test(text) && (/\b(?:outro assunto|outro problema|nova duvida|mudando de assunto|agora e sobre)\b/.test(text)
    || /\b(?:quero|preciso|manda|mande|envie|enviar|segunda via)\b.{0,35}\b(?:boleto|fatura|pix)\b/.test(text));

}

/** Pending preference derived solely from customer turns, never an action claim.
 * A voluntary return releases a pause, not a still-requested technical visit.
 */
export function pendingSupportRequest(message: string, history: ChatMessage[]): SupportRequest | undefined {
  let pending: SupportRequest | undefined;
  for (const turn of [...history, { role: "customer", content: message }]) {
    if (turn.role !== "customer") continue;
    const text = normal(turn.content);
    if (reportsConnectionResolved(turn.content) || startsNewSupportTopic(turn.content)) pending = undefined;
    const negatedPreference = !/\b(?:nao|nem) (?:cancela|cancele|desconsidera|desconsidere)\b/.test(text)
      && negatesSupportRequest(turn.content) && (!pending
      || (pending === "visit" ? /tecnico|visita|agendar/.test(text)
        : pending === "ticket" ? /chamado|protocolo/.test(text) : /atendente|humano/.test(text)));
    const affirmative = !/\b(?:nao|nem)\b/.test(text);
    if (negatedPreference || (affirmative && /\b(?:cancela|cancele|desconsidera|desconsidere) (?:o )?(?:pedido|chamado|tecnico|visita)\b/.test(text))) pending = undefined;
    if (affirmative && pending === "pause" && /\b(?:agora (?:eu )?posso (?:conversar|falar|responder)|pode continuar|vamos continuar|podemos continuar|quero continuar (?:os )?testes)\b/.test(text)) pending = undefined;
    if (affirmative && /\b(?:quero|podemos|vamos) (?:continuar|fazer) (?:os )?testes\b/.test(text)) pending = undefined;
    const request = supportRequest(turn.content);
    if (request) {
      // A later lack of time does not erase a requested technician.
      if (request !== "pause" || !pending) pending = request;
    }
  }
  return pending;
}
