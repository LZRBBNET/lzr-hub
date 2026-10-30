import type { ChatMessage } from "./types.ts";

const normal = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Customer reports only; these are not verified equipment actions or authority. */
export function restartReport(message: string): "done" | "not_done" | undefined {
  let report: "done" | "not_done" | undefined;
  for (let clause of normal(message).split(/[.!;]|\bmas\b|\bporem\b/)) {
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
  const lastResolved = history.findLastIndex((turn) => turn.role === "customer" && reportsConnectionResolved(turn.content));
  const recent = history.slice(lastResolved + 1).filter((turn) => turn.role === "customer" || turn.role === "agent");
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
