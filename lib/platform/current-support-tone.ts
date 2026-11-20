import { REPLY_WINDOW_MS } from "./conversation-state-shared.ts";
import { MAX_CPF_ATTEMPTS, type InvoiceSelfService } from "./invoice-self-service-shared.ts";
import type { TicketSummary } from "./triage-shared.ts";

export type SupportDaypart = "bom dia" | "boa tarde" | "boa noite";
const normalize = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/g, " ");

export function explicitSupportDaypart(text: string): SupportDaypart | undefined {
  const value = normalize(text).replace(/[,!.?]+/g, " ").replace(/ +/g, " ").trim();
  return /^(?:(?:oi|ola) )?(bom dia|boa tarde|boa noite)\b/.exec(value)?.[1] as SupportDaypart | undefined;
}

/** Only a signed, near-current provider event may trigger an inferred opening. */
export function freshSupportDaypart(sentAt: string | undefined, now = Date.now()): SupportDaypart | undefined {
  const received = Date.parse(sentAt ?? "");
  if (!Number.isFinite(received) || received > now || now - received > 120_000) return undefined;
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23",
  }).format(now));
  return hour >= 5 && hour < 12 ? "bom dia" : hour >= 12 && hour < 18 ? "boa tarde" : "boa noite";
}

const cues = [
  "puta que pariu", "vai tomar no cu", "vao tomar no cu", "que merda", "que porcaria", "que lixo", "que saco", "que droga",
  "seus incompetentes", "seus idiotas", "pelo amor de deus", "isso e um absurdo", "e um absurdo",
  "estou indignado", "estou indignada", "estou muito irritado", "estou muito irritada",
  "estou irritado", "estou irritada", "estou puto", "estou puta", "to puto", "to puta",
  "to de saco cheio", "estou de saco cheio", "estou cansado disso", "estou cansada disso",
  "porra", "merda", "caralho", "pqp", "absurdo",
].join("|");
const moodMarker = new RegExp(`\\b(?:${cues}|incompetente[s]?|idiota[s]?|desgraca|lixo)\\b`);
const leadCue = new RegExp(`^(?:${cues})(?:\\b[ ,.!?:;–—-]+|$)`);
const tailCue = new RegExp(`(?:[ ,.!?:;–—-]+(?:e )?)(?:${cues})$`);
const dangerous = /\b(?:vou (?:te |vos |lhes )?(?:matar|agredir|bater|atirar|explodir|queimar|arrebentar|pegar)|vou (?:me matar|me machucar)|vou (?:na |ate a )?(?:loja|empresa) armado|(?:tenho|trouxe|peguei) uma arma|posso me matar)\b/;
const wordsOnly = /^[\p{L}\p{M} ,.!?:;–—-]+$/u;

export type CurrentTechnicalComplaint =
  | { kind: "frustrated"; report: string; daypart?: SupportDaypart }
  | { kind: "review" };

/**
 * Recognizes only edge cues surrounding an entire allowlisted current symptom.
 * Anything else marked rude/threatening is held, never pasted into a prompt.
 */
export function currentTechnicalComplaint(text: string): CurrentTechnicalComplaint | undefined {
  const value = normalize(text);
  if (dangerous.test(value)) return { kind: "review" };
  if (!moodMarker.test(value)) return undefined;
  if (text.length > 140 || !wordsOnly.test(text)) return { kind: "review" };

  const daypart = explicitSupportDaypart(text);
  let core = value.replace(/^(?:(?:oi|ola)[ ,.!?]+)?(?:bom dia|boa tarde|boa noite)[ ,.!?]+/, "");
  core = core.replace(/^[ ,.!?:;–—-]+|[ ,.!?:;–—-]+$/g, "");
  let matched = false;
  // Bound the amount of stripping. Interior cues, pasted prose and mixed intents stay for review.
  for (let index = 0; index < 3; index++) {
    const next = core.replace(leadCue, "").replace(tailCue, "").replace(/^[ ,.!?:;–—-]+|[ ,.!?:;–—-]+$/g, "");
    if (next === core) break;
    core = next;
    matched = true;
  }
  if (!matched) return { kind: "review" };
  core = core.replace(/(?: de novo| novamente| por favor)$/, "");
  if (/^(?:(?:estou|to|continuo|sigo) )?(?:sem internet|sem conexao)$|^(?:(?:a|minha) )?internet (?:caiu|nao funciona)$/.test(core))
    return { kind: "frustrated", report: "Cliente relata que está sem internet.", daypart };
  if (/^(?:(?:a|minha) )?internet (?:esta |ta )?lenta$/.test(core))
    return { kind: "frustrated", report: "Cliente relata lentidão na internet.", daypart };
  if (/^(?:(?:o|meu) )?(?:wi fi|wi-fi|wifi) nao conecta$/.test(core))
    return { kind: "frustrated", report: "Cliente relata que o Wi-Fi não conecta.", daypart };
  if (/^(?:(?:a|minha) )?(?:conexao|internet) (?:continua falhando|continua caindo|fica caindo)$/.test(core))
    return { kind: "frustrated", report: "Cliente relata que a conexão está falhando.", daypart };
  return { kind: "review" };
}

const DAYPART_PREFIX = /^(bom dia|boa tarde|boa noite)[!.] +/;
const EMPATHY_PREFIX = /^(entendo (?:a )?sua frustracao|sinto muito pelo transtorno|lamento (?:pelo|o) transtorno|sei que isso e frustrante)[.!] +/;

export function technicalReplyLayout(text: string) {
  if (text.length > 200 || !/^[\p{L}\p{M} .!?-]+\?$/u.test(text)) return undefined;
  let core = normalize(text);
  const match = DAYPART_PREFIX.exec(core);
  if (match) core = core.slice(match[0].length);
  const acknowledgment = EMPATHY_PREFIX.exec(core);
  if (acknowledgment) core = core.slice(acknowledgment[0].length);
  return { daypart: match?.[1] as SupportDaypart | undefined, empathetic: !!acknowledgment, question: core };
}

type TicketGatesInput = Pick<TicketSummary, "status" | "stage" | "intent">
  & { lastCustomerAt: string; selfService: Pick<InvoiceSelfService, "step" | "at" | "attempts"> | null };

/** Case metadata isn't active just because the low-level query returned an open row. */
export function currentTicketGates(ticket: TicketGatesInput | undefined, now = Date.now()) {
  if (!ticket || ticket.status !== "open") {
    return { priorIntent: undefined, humanHandoff: false, privateFlowPending: false };
  }
  const last = Date.parse(ticket.lastCustomerAt);
  if (Number.isFinite(last) && now - last > REPLY_WINDOW_MS) {
    return { priorIntent: undefined, humanHandoff: false, privateFlowPending: false };
  }

  const flow = ticket.selfService;
  const pendingStep = flow?.step === "awaiting_cpf" || (flow?.step === "invalid_cpf"
    && !(typeof flow.attempts === "number" && flow.attempts >= MAX_CPF_ATTEMPTS));
  const stepAt = Date.parse(flow?.at ?? "");
  const stepProvenStale = Number.isFinite(stepAt) && now - stepAt > REPLY_WINDOW_MS;
  const recent = Number.isFinite(last) && last <= now;
  return {
    priorIntent: recent ? ticket.intent : undefined,
    humanHandoff: recent && ticket.stage === "handoff",
    // If an actual sensitive step is still pending and has no proven expiry,
    // fail closed even when one of its timestamps is invalid or future-dated.
    privateFlowPending: pendingStep && !stepProvenStale,
  };
}
