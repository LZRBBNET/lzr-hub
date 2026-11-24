import type { Intent } from "../agent/types.ts";
import type { ConnectionDiagnosis } from "./connection-diagnosis-shared.ts";
import type { InvoiceSelfService } from "./invoice-self-service-shared.ts";
import type { TicketIntake } from "./agent-playbook-shared.ts";

/**
 * Triagem do atendimento: protocolo, setor e o menu que confirma o assunto.
 *
 * Sem dependência de servidor: a tela de Atendimentos usa os mesmos rótulos.
 *
 * O desenho segue o que os bots de provedor fazem (o Opa! Suite da própria IXC,
 * SimplesDesk, Talqui): a IA entende o assunto, e quando não tem certeza
 * **pergunta** em vez de passar para humano às cegas. Antes, 11 de 13 conversas
 * reais transbordavam por "não entendi" — e o atendente recebia a conversa sem
 * saber nem o assunto.
 */

/** Setor de destino. É o mesmo rótulo de fila (`queue`) que Equipes já usa. */
export type TriageQueue = "tecnico" | "financeiro" | "comercial" | "atendimento";

export const QUEUE_LABELS: Record<TriageQueue, string> = {
  tecnico: "Suporte técnico",
  financeiro: "Financeiro",
  comercial: "Comercial",
  atendimento: "Atendimento",
};
export const TRIAGE_QUEUES = Object.keys(QUEUE_LABELS) as TriageQueue[];
export const queueLabel = (queue: string | null | undefined): string => (queue && queue in QUEUE_LABELS ? QUEUE_LABELS[queue as TriageQueue] : "Sem setor");

/**
 * Para onde vai cada assunto. Cancelamento fica com o Comercial porque é
 * retenção; reclamação e pedido de atendente, com o atendimento geral.
 */
export function queueForIntent(intent: Intent | string): TriageQueue {
  if (intent.startsWith("technical_")) return "tecnico";
  if (intent.startsWith("financial_")) return "financeiro";
  if (intent === "sales_inquiry" || intent === "cancellation_risk") return "comercial";
  return "atendimento";
}

/**
 * O menu que confirma o assunto. No horário comercial vai como texto numerado,
 * como o da IXC. Fora dele vai como **lista clicável** do WhatsApp (`title` é o
 * que aparece na lista — a Meta corta acima de 24 caracteres). O número
 * continua valendo nos dois: quem digita "3" escolhe a terceira opção.
 */
export const TRIAGE_MENU: ReadonlyArray<{ label: string; title: string; description?: string; intent: Intent }> = [
  { label: "Sem internet", title: "Sem internet", intent: "technical_no_connection" },
  { label: "Internet lenta ou Wi-Fi fraco", title: "Internet lenta / Wi-Fi", description: "Lentidão ou sinal fraco em algum cômodo", intent: "technical_slow" },
  { label: "Segunda via ou PIX", title: "Segunda via ou PIX", description: "Fatura, boleto ou código PIX", intent: "financial_invoice" },
  { label: "Internet bloqueada", title: "Internet bloqueada", intent: "financial_unlock" },
  { label: "Já paguei", title: "Já paguei", description: "Pagamento ainda não reconhecido", intent: "financial_payment" },
  { label: "Visita técnica, instalação ou mudança de endereço", title: "Visita ou instalação", description: "Visita técnica, instalação ou mudança de endereço", intent: "technical_visit" },
  { label: "Planos e contratação", title: "Planos e contratação", intent: "sales_inquiry" },
  { label: "Cancelamento", title: "Cancelamento", intent: "cancellation_risk" },
  { label: "Falar com um atendente", title: "Falar com atendente", intent: "human_handoff" },
];

/** A lista clicável do WhatsApp (mensagem interativa da Cloud API). */
export interface InteractiveList { button: string; rows: Array<{ id: string; title: string; description?: string }> }
export const TRIAGE_LIST: InteractiveList = {
  button: "Ver assuntos",
  rows: TRIAGE_MENU.map((option, index) => ({ id: `menu-${index + 1}`, title: option.title, ...(option.description ? { description: option.description } : {}) })),
};
/** Como a lista aparece no histórico da tela: o atendente lê o que o cliente viu. */
export const listAsText = (list: InteractiveList) => list.rows.map((row, index) => `${index + 1}. ${row.title}`).join("\n");

export const CLARIFY_TEXT = `Olá! Aqui é o suporte da BBNET. Para te ajudar mais rápido, responda com o número do assunto:

${TRIAGE_MENU.map((option, index) => `${index + 1}. ${option.label}`).join("\n")}

Se preferir, é só escrever o que precisa.`;

/** Abaixo disto a IA pergunta o assunto em vez de responder. É o mesmo corte do transbordo por "não entendi". */
export const CLARIFY_BELOW = 0.6;

const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * O assunto escolhido no menu: o número ("3", "3.", "opção 3") ou o nome exato da
 * opção. Texto livre não entra aqui — quem escreve "minha fatura veio errada" é
 * entendido melhor pelo classificador do que por casamento de palavra.
 */
export function menuChoice(text: string): Intent | undefined {
  const value = normalize(text);
  const number = value.match(/^(?:opcao\s*)?(\d{1,2})\s*[).:-]?$/);
  if (number) return TRIAGE_MENU[Number(number[1]) - 1]?.intent;
  // A resposta da lista clicável chega com o título da opção.
  return TRIAGE_MENU.find((option) => normalize(option.label) === value || normalize(option.title) === value)?.intent;
}

/* ------------------------------------------------- horário de atendimento --- */

/**
 * Atendimento humano: segunda a sexta, 8h–12h e 14h–18h, em Brasília, exceto
 * feriado. Fora disso (almoço, noite, fim de semana, feriado) a IA conduz
 * sozinha com a lista e as respostas aprovadas.
 */
export const BUSINESS_SHIFTS: ReadonlyArray<[number, number]> = [[8 * 60, 12 * 60], [14 * 60, 18 * 60]];
export const BUSINESS_DAYS = new Set([1, 2, 3, 4, 5]);

/**
 * Feriados fixos: os nacionais (Lei 662/1949 e alterações; 20/11 desde a Lei
 * 14.759/2023) e a Emancipação Política de Sergipe (8/7). Municipal varia com a
 * cidade, por isso fica em `BUSINESS_HOLIDAYS`.
 */
const FIXED_HOLIDAYS: Record<string, string> = {
  "01-01": "Confraternização Universal",
  "04-21": "Tiradentes",
  "05-01": "Dia do Trabalho",
  "07-08": "Emancipação Política de Sergipe",
  "09-07": "Independência do Brasil",
  "10-12": "Nossa Senhora Aparecida",
  "11-02": "Finados",
  "11-15": "Proclamação da República",
  "11-20": "Dia da Consciência Negra",
  "12-25": "Natal",
};

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), em UTC ao meio-dia para a conta de dias não escorregar. */
function easter(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day, 12));
}

/**
 * Feriados móveis, a partir da Páscoa. Carnaval e Corpus Christi são ponto
 * facultativo, não feriado nacional — entram porque, na dúvida, é melhor a IA
 * responder num dia em que há gente do que o cliente ficar sem resposta num dia
 * em que não há: a resposta automática é só a primeira, e a conversa continua na fila.
 */
function movableHolidays(year: number): Record<string, string> {
  const base = easter(year).getTime();
  const at = (offset: number) => new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
  return { [at(-48)]: "Carnaval", [at(-47)]: "Carnaval", [at(-2)]: "Sexta-feira Santa", [at(60)]: "Corpus Christi" };
}

/**
 * Feriados extras da operação (municipais, emendas): `BUSINESS_HOLIDAYS` com
 * datas separadas por vírgula, `MM-DD` para todo ano ou `AAAA-MM-DD` para um só.
 * Lido do ambiente quando existe — no navegador não existe, e a lista fica vazia.
 */
function extraHolidays(): Set<string> {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.BUSINESS_HOLIDAYS ?? "";
  return new Set(raw.split(",").map((value) => value.trim()).filter((value) => /^(\d{4}-)?\d{2}-\d{2}$/.test(value)));
}

/** O nome do feriado no dia (`AAAA-MM-DD`, Brasília), ou `undefined` se for dia comum. */
export function holidayName(day: string): string | undefined {
  const monthDay = day.slice(5);
  const extras = extraHolidays();
  return FIXED_HOLIDAYS[monthDay] ?? movableHolidays(Number(day.slice(0, 4)))[day] ?? (extras.has(day) || extras.has(monthDay) ? "Feriado" : undefined);
}

function saoPaulo(at: Date): { weekday: number; minutes: number; day: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(at).map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { weekday, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute), day: `${parts.year}-${parts.month}-${parts.day}` };
}

const isWorkday = (local: { weekday: number; day: string }) => BUSINESS_DAYS.has(local.weekday) && !holidayName(local.day);

export function isBusinessHours(at: Date = new Date()): boolean {
  const local = saoPaulo(at);
  return isWorkday(local) && BUSINESS_SHIFTS.some(([start, end]) => local.minutes >= start && local.minutes < end);
}

const WEEKDAY_NAMES = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

/** Quando o atendimento humano volta, em palavras: "hoje às 14h", "amanhã às 8h", "segunda-feira às 8h", "dia 26/12 às 8h". */
export function nextOpeningText(at: Date = new Date()): string {
  const today = saoPaulo(at);
  if (isWorkday(today)) {
    const later = BUSINESS_SHIFTS.find(([start]) => start > today.minutes);
    if (later) return `hoje às ${later[0] / 60}h`;
  }
  // Até 15 dias: cobre feriado emendado com fim de semana e Carnaval.
  for (let ahead = 1; ahead <= 15; ahead++) {
    const local = saoPaulo(new Date(at.getTime() + ahead * 86_400_000));
    if (!isWorkday(local)) continue;
    const hour = `às ${BUSINESS_SHIFTS[0][0] / 60}h`;
    if (ahead === 1) return `amanhã ${hour}`;
    return ahead < 7 ? `${WEEKDAY_NAMES[local.weekday]} ${hour}` : `dia ${local.day.slice(8)}/${local.day.slice(5, 7)} ${hour}`;
  }
  return "no próximo dia útil";
}

/** "Hoje é feriado (Natal). " quando é, para o cliente entender por que não há gente num dia de semana. */
function holidayPrefix(at: Date): string {
  const today = saoPaulo(at);
  const name = BUSINESS_DAYS.has(today.weekday) ? holidayName(today.day) : undefined;
  return name ? `Hoje é feriado${name === "Feriado" ? "" : ` (${name})`}. ` : "";
}

/** A abertura do atendimento fora do horário: quem é, quando há gente, e a lista. */
export function offHoursMenuText(at: Date = new Date()): string {
  return `Olá! Aqui é o suporte da BBNET. Nosso atendimento com pessoas funciona de segunda a sexta, das 8h às 12h e das 14h às 18h. ${holidayPrefix(at)}Ele volta ${nextOpeningText(at)}. Enquanto isso, posso resolver várias coisas por aqui: toque em "${TRIAGE_LIST.button}" e escolha o assunto, ou escreva o que precisa.`;
}

/** Vai no fim das respostas fora do horário: a promessa "um atendente retorna" ganha data. */
export const offHoursNote = (at: Date = new Date()) => `Nosso atendimento com pessoas volta ${nextOpeningText(at)}; se precisar, um atendente continua daqui.`;

/** `AAAAMMDD` no fuso de Brasília + o sequencial com 6 dígitos. */
export function formatProtocol(seq: number, at: Date): string {
  const day = at.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace(/-/g, "");
  return `${day}${String(seq).padStart(6, "0")}`;
}

export const protocolFooter = (protocol: string) => `Protocolo do atendimento: ${protocol}`;

/** `handoff`: a IA (modo autônomo) passou para o atendente e se cala até alguém devolver a conversa a ela. */
export type TicketStage = "new" | "clarifying" | "routed" | "handoff";
export type TicketIdentification = "pending" | "identified" | "not_found" | "unavailable";

/** O que a tela mostra do atendimento. */
export interface TicketSummary {
  protocol: string | null;
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
  closedReason: string | null;
  identification: TicketIdentification;
  ixcCustomerId: string | null;
  intent: string | null;
  intentSource: string | null;
  intentConfidence: number | null;
  queue: string | null;
  stage: TicketStage;
  protocolSentAt: string | null;
  /** Diagnóstico de conexão, quando o assunto é técnico e o cliente foi identificado. */
  diagnosis: ConnectionDiagnosis | null;
  /** Segunda via com confirmação do titular. */
  selfService: InvoiceSelfService | null;
  /** Pedido que a IA deixou pronto para a equipe (modo autônomo). */
  intake?: TicketIntake | null;
}

/** Assuntos em que o diagnóstico de conexão ajuda: o problema pode estar no contrato, no login ou na rede. */
export const DIAGNOSABLE_INTENTS = new Set(["technical_no_connection", "technical_slow", "technical_wifi", "technical_restart"]);

export const STAGE_LABELS: Record<TicketStage, string> = {
  new: "Recebido",
  clarifying: "IA perguntou o assunto",
  routed: "Encaminhado ao setor",
  handoff: "Com a equipe (pedido registrado pela IA)",
};

export const IDENTIFICATION_LABELS: Record<TicketIdentification, string> = {
  pending: "Consultando o IXC",
  identified: "Cliente identificado pelo telefone",
  not_found: "Telefone sem cadastro único no IXC",
  unavailable: "IXC não respondeu",
};
