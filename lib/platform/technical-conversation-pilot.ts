import { knownSupportThreat } from "./current-support-tone.ts";

type Issue = "offline" | "slow" | "wifi";
type DeviceScope = "one" | "many";
type Light = "red" | "not-red";
type Duration = "today" | "yesterday";
export type ApprovedTechnicalStep = "devices" | "light" | "wifi-one-device" | "red-light-label" | "los-guidance";

export interface PilotFinding {
  issue: Issue;
  restarted: boolean;
  clientConnectionControlsTried: boolean;
  devices?: DeviceScope;
  light?: Light;
  duration?: Duration;
}

const CANONICAL = /^[1-9][0-9]{9,14}$/;
const META_ID = /^wamid\.[A-Za-z0-9_=+\/-]{1,240}$/;
type MetaConversationScope = {
  phone: string; canonicalSender?: boolean; actualPhoneNumberId?: string; expectedPhoneNumberId?: string; messageId: string;
};
type Environment = Record<string, string | undefined>;

/**
 * A faixa protegida do fluxo técnico atende **sozinha** cumprimento, "estou sem internet" e o piloto de perguntas fixas:
 * só faz as perguntas aprovadas e, diante de qualquer resposta fora delas ("a luz está desligada"), fica **calada** e
 * deixa para revisão manual. Para o cliente isso é uma conversa que morre no meio, e nada abre atendimento, ficha nem OS.
 * Com `FEATURE_PROTECTED_TECHNICAL_LANE=false` esses três casos seguem o caminho normal (IA conversando, atendimento, ficha e OS).
 * Cliente agressivo ou ameaçando continua sempre na faixa: texto assim nunca vai ao modelo. Padrão: ligada, como antes.
 */
export function protectedLaneEnabled(env: Environment): boolean {
  // Valor digitado à mão no painel: "False", " false", "\"false\"" e "0" também desligam. Vazio ou desconhecido mantém ligada.
  const value = String(env.FEATURE_PROTECTED_TECHNICAL_LANE ?? "").trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
  return !["false", "0", "off", "no", "nao", "não", "desligada", "desligado"].includes(value);
}
export function technicalPilotEnabled(env: Environment, input: MetaConversationScope, now = Date.now()): boolean {
  const permitted = env.META_CONVERSATION_PILOT_SENDER;
  const until = env.META_CONVERSATION_PILOT_UNTIL;
  const expires = until && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(until) ? Date.parse(until) : NaN;
  return env.FEATURE_META_CONVERSATION_PILOT === "true" && !!permitted && CANONICAL.test(permitted)
    && Number.isFinite(expires) && new Date(expires).toISOString() === (until?.includes(".") ? until : until?.replace(/Z$/, ".000Z"))
    && expires > now && expires - now <= 24 * 60 * 60_000
    && input.canonicalSender === true && input.phone === permitted && !!input.expectedPhoneNumberId
    && input.actualPhoneNumberId === input.expectedPhoneNumberId && META_ID.test(input.messageId);
}

/** Called only after the Meta webhook verifies its HMAC against the raw body. */
export function technicalConversationRelease(env: Environment, signedInput: MetaConversationScope, now = Date.now()) {
  if (env.FEATURE_META_TECHNICAL_CONVERSATION_ROLLOUT === "true" && signedInput.canonicalSender === true
    && CANONICAL.test(signedInput.phone) && !!signedInput.expectedPhoneNumberId
    && signedInput.actualPhoneNumberId === signedInput.expectedPhoneNumberId && META_ID.test(signedInput.messageId)) {
    return { scope: "rollout", redLightLabel: true, losGuidance: true } as const;
  }
  if (technicalPilotEnabled(env, signedInput, now)) {
    return { scope: "pilot", redLightLabel: env.FEATURE_META_CONVERSATION_PILOT_RED_LIGHT_LABEL === "true",
      losGuidance: env.FEATURE_META_CONVERSATION_PILOT_LOS_GUIDANCE === "true" } as const;
  }
  return undefined;
}

/** Route only freshly eligible pilot input; leave incumbent private flows on their prior lane. */
export function technicalPilotRoute(input: {
  baselineProtected: boolean; pilotCandidate: boolean; humanHandoff: boolean; privateFlowPending: boolean;
}): "pilot" | "protected" | "legacy" {
  if (input.pilotCandidate && !input.humanHandoff && !input.privateFlowPending) return "pilot";
  return input.baselineProtected ? "protected" : "legacy";
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const tokenize = (text: string) => text.replace(/[,.!?;:()-]/g, " ").replace(/ +/g, " ");
const sensitiveOrMixed = /\b(?:cpf|cnpj|documento|senha|token|credencial|email|e mail|endereco|cep|pix|boleto|fatura|cobranca|paga[rm]|paguei|pagamento|desbloque|desbloquear|financeiro|negociar|cancelar|cancelamento|ordem de servico|protocolo|chamado|o s|numero da os|abrir (?:uma )?os|visita tecnica|agendar|assinar|contratar|comprar|vender|oferta|preco|meus dados|codigo|atendente|humano|vizinh[aos]|amig[aos]|terceir[aos]|outro cliente|(?:da minha|do meu) (?:irma|irmao|mae|pai|tia|tio|cliente)|casa de outra pessoa|me chamo|meu nome|sou o titular|(?:vou|pretendo|quero|estou pensando em) (?:te |me )?(?:matar|machucar|agredir)|ignore|instrucoes|sistema anterior|prompt|execute|simule|faz de conta)\b/u;
const notCurrent = /\b(?:se (?:eu |a internet )?(?:ficar|estiver|cair)|quando (?:eu |a internet )?(?:ficar|estiver|cair)|nao estou sem|nao fiquei sem|nao esta lenta|nao e verdade que|nao tem problema|desde amanha|(?:ja|hoje|agora) (?:voltou|normalizou|resolveu)|antes eu|ontem eu estava|voltou a funcionar|esta funcionando (?:normalmente|de novo)|problema resolvido)\b/u;
const plausibleSelf = /\b(?:eu|minha|meu|nosso|nossa|estou|estamos|to|tamos|fiquei|ficamos|aqui|em casa|reiniciei|desliguei|tirei|liguei)\b/u;

function inputWords(text: string): string | undefined {
  if (!text || text.length > 420 || knownSupportThreat(text)) return undefined;
  const line = text.replace(/\r?\n/g, " ");
  // Permit only plain punctuation and words. Refuse numbers/identifiers,
  // links, handles, control separators and arbitrary symbols even though
  // none of the user's original words would be sent to the model.
  if (line.includes("@") || /(?:https?:|www\.|\p{N})/iu.test(line) || /[^\p{L}\p{M} ,.?!;:()\-]/u.test(line)) return undefined;
  const value = tokenize(fold(line));
  return sensitiveOrMixed.test(value) || notCurrent.test(value) ? undefined : value;
}

const explicitlyWired = (value: string) => /\b(?:cabo (?:de rede|ethernet)|(?:por|pelo|via|no|com) (?:o )?cabo|ethernet)\b/u.test(value);
const clientControlsMentioned = (value: string) => /\b(?:desliguei|liguei|religuei|ativei|desativei|alternei|tirei|coloquei) [\p{L} ]{0,24}?(?:wi fi|wifi|dados moveis|dados do celular)\b/u.test(value);
export function currentAnswerAlreadyTriedClientControls(text: string): boolean {
  const value = inputWords(text);
  return !!value && (explicitlyWired(value) || clientControlsMentioned(value) || /\b(?:reiniciei|desliguei|religuei|tirei da tomada)\b/u.test(value));
}

export function anchoredPilotAnswerContradictsBinary(text: string, finding: DeviceScope | Light, yesIsClear: boolean, noIsClear: boolean): boolean {
  const value = inputWords(text)?.trim();
  if (!value) return true;
  if (finding === "one" && /\bnao (?:so|apenas|somente)\b/u.test(value)) return true;
  return (yesIsClear && /^(?:sim|isso)\b/.test(value) && (finding === "one" || finding === "not-red"))
    || (noIsClear && /^nao (?!ha luz|tem luz|vejo luz)/.test(value) && (finding === "many" || finding === "red"));
}

export function extractCurrentTechnicalPilot(text: string): PilotFinding | undefined {
  const value = inputWords(text);
  if (!value) return undefined;
  const offline = /\b(?:(?:sem|acabou a|caiu a) (?:internet|conexao)|internet caiu|internet nao (?:funciona|voltou|pega)|conexao nao voltou|internet (?:fica |anda )?caindo)\b/u.test(value);
  const slow = /\b(?:(?:internet|conexao) (?:esta |ta |ficou |anda |muito )*(?:lenta|devagar)|lentidao (?:na|da) internet|internet (?:aqui )?(?:esta |ta |fica )?travando)\b/u.test(value);
  const wifi = /\b(?:(?:wi fi|wifi) nao (?:conecta|aparece|pega)|nao consigo conectar no (?:wi fi|wifi)|(?:wi fi|wifi) desconectando)\b/u.test(value);
  if (Number(offline) + Number(slow) + Number(wifi) !== 1) return undefined;
  if (!plausibleSelf.test(value) && !/^(?:sem (?:internet|conexao)|internet caiu|internet lenta|(?:wi fi|wifi) nao conecta)$/.test(value.trim())) return undefined;

  const equipment = "(?:o modem e o roteador|o roteador e o modem|os equipamentos|meus equipamentos|o equipamento|o modem|o roteador|a (?:ont|onu))";
  const positiveRestart = new RegExp("\\b(?:reiniciei " + equipment
    + "|desliguei " + equipment + "(?: e| e depois| depois) (?:liguei|religuei)(?: de novo)?"
    + "|tirei " + equipment + " da tomada(?: e| e depois| depois) (?:liguei|religuei)(?: de novo)?)\\b", "u").test(value);
  const negativeOrPlannedRestart = /\b(?:nao (?:ja )?reiniciei|ainda nao reiniciei|nao desliguei|nao tirei|vou (?:reiniciar|desligar)|se (?:eu )?reiniciar)\b/u.test(value);
  // Distinct from known equipment restart. A partial or ambiguous prior
  // client-side toggle is enough to avoid offering that same Wi-Fi step.
  const clientConnectionControlsTried = explicitlyWired(value) || clientControlsMentioned(value)
    || (!positiveRestart && /\b(?:reiniciei|desliguei|religuei|tirei da tomada)\b/u.test(value));
  const one = /\b(?:so|apenas|somente) (?:no|na|em) (?:meu |minha )?(?:celular|computador|notebook|tv|um aparelho)\b/u.test(value);
  const many = /\b(?:em|nos) (?:(?:todos|varios|dois) (?:os )?(?:meus )?aparelhos|mais de um aparelho)\b/u.test(value);
  const hasRed = /\bluz (?:do roteador )?(?:(?:ta|esta|fica) )?vermelha\b/u.test(value);
  const noRed = /\b(?:nenhuma luz (?:do roteador )?(?:(?:ta|esta|fica) )?vermelha|nao (?:tem|ha) luz vermelha)\b/u.test(value);
  const doubleNegation = /\b(?:nao|nunca) (?:vi|vejo|consigo ver) (?:uma )?luz vermelha\b/u.test(value);
  const today = /\bdesde (?:hoje|cedo|esta manha)\b/u.test(value);
  const yesterday = /\bdesde ontem\b/u.test(value);
  return {
    issue: offline ? "offline" : slow ? "slow" : "wifi",
    restarted: positiveRestart && !negativeOrPlannedRestart,
    clientConnectionControlsTried,
    devices: one === many ? undefined : one ? "one" : "many",
    light: doubleNegation ? undefined : noRed ? "not-red" : hasRed ? "red" : undefined,
    duration: today === yesterday ? undefined : today ? "today" : "yesterday",
  };
}

export interface PilotPlan { step: ApprovedTechnicalStep; report: string }
export function choosePilotStep(finding: PilotFinding): PilotPlan | undefined {
  const report = [
    { offline: "Cliente relata internet indisponível.", slow: "Cliente relata lentidão na internet.", wifi: "Cliente relata dificuldade para conectar ao Wi-Fi." }[finding.issue],
    finding.restarted ? "Cliente relata que já reiniciou o equipamento, sem solução." : "",
    finding.devices === "one" ? "Cliente relata dificuldade em um único aparelho." : finding.devices === "many" ? "Cliente relata dificuldade em vários aparelhos." : "",
    finding.light === "red" ? "Cliente relata uma luz vermelha no roteador." : finding.light === "not-red" ? "Cliente relata não ver luz vermelha no roteador." : "",
    finding.duration === "today" ? "Cliente relata isso desde hoje." : finding.duration === "yesterday" ? "Cliente relata isso desde ontem." : "",
  ].filter(Boolean).join(" ");
  if (!finding.devices) return { step: "devices", report };
  if (finding.devices === "one") return finding.clientConnectionControlsTried ? undefined : { step: "wifi-one-device", report };
  if (!finding.light) return { step: "light", report };
  return undefined;
}

export function pilotAnchoredFinding(text: string, dimension: "devices" | "light"): DeviceScope | Light | undefined {
  if (text.length > 100) return undefined;
  const value = inputWords(text);
  if (!value || /\b(?:talvez|nao sei|nao testei|nao tenho certeza|eu acho|creio|parece|sugira|escreva)\b/u.test(value)) return undefined;
  if (dimension === "devices") {
    const one = /\b(?:so|apenas|somente) (?:no|na|em) (?:meu |minha )?(?:celular|computador|notebook|tv|um aparelho|um dispositivo|nesse aparelho)\b/u.test(value);
    const many = /\b(?:em|nos) (?:todos|dois|varios|mais de um)(?: os)? (?:meus )?(?:aparelhos|dispositivos|da casa|aqui(?: em casa| da casa)?)\b/u.test(value)
      || /\b(?:em|nos) todos (?:aqui )?(?:em casa|da casa)\b/u.test(value)
      || /\b(?:no celular e (?:na tv|no computador|no notebook)|na tv e no celular)\b/u.test(value);
    if (one === many) return undefined;
    // Leading opinions between "yes/no" and the explicit device scope
    // may contradict on some question phrasings. Exact short yes/no
    // stays with the current question's deterministic binary semantics.
    return one ? "one" : "many";
  }
  const noRed = /\b(?:nenhuma luz (?:do roteador )?(?:(?:ta|esta|fica) )?vermelha|nao (?:tem|ha|vejo) (?:nenhuma |uma )?luz vermelha)\b/u;
  const absent = noRed.test(value);
  const rest = value.replace(new RegExp(noRed.source, "gu"), "");
  const red = /\b(?:a |uma |alguma )?luz(?: do roteador)? (?:ta |esta |fica |ficou )?vermelha\b/u.test(rest);
  if (red === absent) return undefined;
  return red ? "red" : "not-red";
}

export function pilotReportedRedLight(text: string): boolean {
  const value = text.length <= 100 && inputWords(text)?.trim();
  return !!value && /^(?:sim +)?(?:tem|vejo|ha) (?:uma|a) (?:luz )?vermelha(?: (?:acesa|no (?:roteador|modem)))?$/.test(value);
}

export function safePilotRedLightLabel(text: string): boolean {
  const value = fold(text);
  return /^(?:(?:voce consegue|pode|voce pode) (?:ler|ver|me dizer) (?:a sigla|o nome) (?:ao lado|perto) da luz vermelha|(?:qual (?:e )?(?:a sigla|o nome) (?:ao lado|perto) da luz vermelha))\?$/.test(value);
}

export const LOS_GUIDANCE = "Essa luz pode indicar perda do sinal da fibra. Não mexa no cabo. O próximo passo é verificar o sinal com o suporte técnico.";

export function pilotReportedLosLabel(text: string): boolean {
  const value = text.length <= 50 && inputWords(text)?.trim();
  return !!value && /^(?:(?:e|a sigla e|esta escrito) )?los$/.test(value);
}

export function matchesProtectedTechnicalConversation(text: string, consentCommand: boolean, release: ReturnType<typeof technicalConversationRelease>): boolean {
  return !!release && !consentCommand && (!!extractCurrentTechnicalPilot(text) || isPossiblePilotAnswer(text, release.redLightLabel));
}

export function isPossibleRedLightLabelAnswer(text: string): boolean {
  const value = text.length <= 60 && inputWords(text)?.trim();
  return !!value && /^(?:(?:(?:e|diz|esta escrito|esta marcada como|a sigla e|o nome e) )?(?:los|pon|power|alarm|internet|lan|optical|fibra)|nao (?:consigo|consegui) (?:ler|ver)(?: a sigla)?|nao da (?:para|pra) ler)$/.test(value);
}

export function isPossiblePilotAnswer(text: string, includeRedLightLabel = false): boolean {
  const value = text.length <= 100 && inputWords(text);
  return !!value && ((includeRedLightLabel && (pilotReportedRedLight(text) || isPossibleRedLightLabelAnswer(text))) || pilotAnchoredFinding(text, "devices") !== undefined
    || pilotAnchoredFinding(text, "light") !== undefined
    || /^(?:sim|nao|isso|(?:so|somente|apenas) (?:em|no|na) |(?:em|nos) (?:mais de um|dois|todos)|(?:a |uma |alguma |nenhuma )?luz |nao (?:tem|ha) luz)/.test(value.trim()));
}

export function safePilotWifiStep(text: string): boolean {
  const value = fold(text).replace(/-/g, " ");
  return /^(?:(?:voce consegue|voce pode|pode) )?(?:desligar e ligar o wi fi (?:de novo )?(?:apenas |so )?(?:nesse|neste|no) (?:aparelho|celular)|desligar e religar o wi fi (?:apenas |so )?(?:nesse|neste|no) (?:aparelho|celular))(?: e (?:me dizer|verificar) se (?:(?:a internet|a conexao) )?voltou)?\?$/.test(value);
}
