import type { ChatMessage } from "./types.ts";

const normalize = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
/** Narrow textual cues for review, not an emotion/violence classifier. Quotes are
 * excluded; ambiguous wording never authorizes actions or asserts an accusation. */
export function servicePreferences(message: string, history: ChatMessage[] = []) {
  const text = normalize(message);
  const own = text.replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'/g, " ");
  const nonContractCancellation = /\bcancelar\s+(?:(?:o|a|um|uma|meu|minha)\s+)?(?:visita|agendamento|boleto|fatura|pedido|chamado|protocolo|teste|solicitacao)\b/.test(own);
  const cancellationMention = /\bcancel(?:ar|o|amento)\b/.test(text);
  const negatedCancellation = /\bnao (?:quero|vou|pretendo|preciso) (?:mais )?cancelar\b/.test(own);
  const conditionalCancellation = /\b(?:se|caso)\b[^.!?]{0,140}\b(?:cancelar|cancelo)\b/.test(own);
  const explicitCancellation = !nonContractCancellation && !conditionalCancellation && !negatedCancellation
    && /\b(?:quero|preciso|vou) cancelar(?: o (?:contrato|plano|servico))?\b/.test(own)
    && !/\b(?:disse|falou|vizinho|exemplo|hipotese)\b/.test(own);
  const dispute = /\b(?:nao reconheco|desconheco|contestar|contestacao)\b[^.!?]{0,45}\b(?:cobranca|fatura|boleto)\b|\b(?:cobranca|fatura|boleto)\b[^.!?]{0,45}\b(?:nao reconheco|fraude|indevid[oa])\b/.test(own);
  // Review only threats aimed at people. Literal targets avoid idioms such as
  // "bater um papo" and "matar a saudade"; negation is scoped to that statement.
  const threatClauses = own.split(/[.!?;]|\bmas\b|\bporem\b/).map(s => s.trim());
  const target = /\b(?:agredir|bater (?:em|no|na)|matar|machucar)\s+(?:(?:o|a|um|uma|seu|sua)\s+)?(?:tecnico|atendente|voces|voce|funcionario)\b/;
  const negatedThreat = (s: string) => /\b(?:nao|nem)\s+(?:(?:vou|irei|quero|pretendo)\s+)?(?:agredir|bater|matar|machucar)\b/.test(s);
  const directThreat = threatClauses.some(s => target.test(s) && /\b(?:vou|irei)\b/.test(s)
    && !negatedThreat(s) && !/\b(?:disse|falou|exemplo)\b/.test(s));
  const ambiguousThreat = !directThreat && threatClauses.some(s => target.test(s) && !negatedThreat(s));
  const directInsult = (s: string) => /\b(?:voce e (?:um |uma )?|sua? )(?:idiota|incompetente)\b/.test(normalize(s))
    && !/["“”']|\b(?:nao|nem|disse|falou|exemplo)\b/.test(normalize(s));
  const persistentInsult = directInsult(own) && history.filter(t => t.role === "customer").some(t => directInsult(t.content));
  // Used ONLY to avoid an incongruous social question, never to penalize/label.
  const conciseOpening = /\b(?:caralho|merda|porcaria|idiota|incompetente|raiva|absurdo|urgente|urgencia|sem tempo|nao tenho tempo|nao posso|nao consigo|procon|anatel)\b/.test(own) || directThreat || ambiguousThreat || dispute || explicitCancellation;
  const technicalText = own.replace(/\b(?:se|caso)\b[^.!?]{0,140}\b(?:cancelar|cancelo)\b/g, " ")
    .replace(/\bnao (?:quero|vou|pretendo|preciso) (?:mais )?cancelar\b/g, " ");
  return { nonContractCancellation, cancellationMention, negatedCancellation, conditionalCancellation, explicitCancellation,
    dispute, directThreat, ambiguousThreat, persistentInsult, conciseOpening, technicalText };
}
