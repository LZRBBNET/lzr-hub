/**
 * Mensagens que a BBNET manda primeiro (cobrança e avisos de rede) — pedido do Vinícius, 18/11/2026.
 *
 * Fora da janela de 24 horas a Meta só aceita **modelo aprovado** (template). Os modelos moram
 * aqui, versionados, e o LZR os cadastra pela API (`/api/admin/whatsapp-templates`). Categoria
 * UTILIDADE: lembrete de pagamento e aviso de serviço são atualização de conta, não marketing.
 * A Meta recusa corpo que começa ou termina com variável e exige exemplo de cada uma.
 *
 * Toda mensagem leva o rodapé de descadastro: quem responde SAIR não recebe mais (`isOptOut`).
 */

export const OPT_OUT_FOOTER = "Para não receber estes avisos, responda SAIR";
export const TEMPLATE_LANGUAGE = "pt_BR";

export interface TemplateDefinition {
  name: string;
  category: "UTILITY";
  body: string;
  /** Exemplo de cada variável, na ordem — a Meta exige para aprovar. */
  example: string[];
  quickReplies?: string[];
}

export const TEMPLATES = {
  billingDueSoon: {
    name: "lzr_fatura_vence_em_3_dias", category: "UTILITY",
    body: "Olá, {{1}}! Passando para lembrar que sua fatura da BBNET no valor de {{2}} vence em {{3}}. Se quiser pagar agora com PIX, toque em \"Quero o PIX\" que eu envio o código por aqui. Se já pagou, pode desconsiderar.",
    example: ["Maria", "R$ 99,90", "21/11"], quickReplies: ["Quero o PIX"],
  },
  billingDueToday: {
    name: "lzr_fatura_vence_hoje", category: "UTILITY",
    body: "Olá, {{1}}! Sua fatura da BBNET no valor de {{2}} vence hoje, {{3}}. Para pagar com PIX agora, toque em \"Quero o PIX\" e eu envio o código por aqui. Se já pagou, pode desconsiderar.",
    example: ["Maria", "R$ 99,90", "18/11"], quickReplies: ["Quero o PIX"],
  },
  billingOverdue: {
    name: "lzr_fatura_em_atraso", category: "UTILITY",
    body: "Olá, {{1}}. Ainda não identificamos o pagamento da sua fatura da BBNET de {{2}}, que venceu em {{3}}. Para regularizar com PIX, toque em \"Quero o PIX\" e eu envio o código por aqui. Se já pagou, pode desconsiderar.",
    example: ["Maria", "R$ 99,90", "17/11"], quickReplies: ["Quero o PIX"],
  },
  billingBlockWarning: {
    name: "lzr_aviso_antes_do_bloqueio", category: "UTILITY",
    body: "Olá, {{1}}. Sua fatura da BBNET de {{2}}, vencida em {{3}}, continua em aberto e a conexão pode ser bloqueada automaticamente amanhã. Pagando com PIX a liberação é imediata: toque em \"Quero o PIX\" e eu envio o código por aqui.",
    example: ["Maria", "R$ 99,90", "12/11"], quickReplies: ["Quero o PIX"],
  },
  outageStart: {
    name: "lzr_aviso_instabilidade_regiao", category: "UTILITY",
    body: "Olá, {{1}}. Identificamos uma instabilidade na rede da BBNET na região de {{2}}. Nossa equipe técnica já está trabalhando para normalizar o serviço e avisaremos por aqui quando a conexão for restabelecida. Não é preciso abrir chamado.",
    example: ["Maria", "Centro, Itabaiana"],
  },
  outageEnd: {
    name: "lzr_aviso_instabilidade_resolvida", category: "UTILITY",
    body: "Olá, {{1}}. A instabilidade na rede da região de {{2}} foi resolvida e a conexão já deve estar normal. Se a sua internet ainda estiver fora, desligue o equipamento da fibra e o roteador da tomada por 30 segundos e ligue de novo. Se continuar, toque em \"Ainda estou sem internet\".",
    example: ["Maria", "Centro, Itabaiana"], quickReplies: ["Ainda estou sem internet"],
  },
  maintenance: {
    name: "lzr_aviso_manutencao_programada", category: "UTILITY",
    body: "Olá, {{1}}. A BBNET fará uma manutenção programada na rede da região de {{2}} no dia {{3}}, {{4}}. Durante esse período a internet pode ficar instável ou indisponível. Agradecemos a compreensão.",
    example: ["Maria", "Centro, Itabaiana", "25/11", "das 01h às 05h"],
  },
} as const satisfies Record<string, TemplateDefinition>;

export type TemplateKey = keyof typeof TEMPLATES;

/** O corpo do cadastro na Meta (`POST /{waba}/message_templates`). */
export function templatePayload(definition: TemplateDefinition) {
  return {
    name: definition.name, language: TEMPLATE_LANGUAGE, category: definition.category,
    components: [
      { type: "BODY", text: definition.body, example: { body_text: [definition.example] } },
      { type: "FOOTER", text: OPT_OUT_FOOTER },
      ...(definition.quickReplies?.length ? [{ type: "BUTTONS", buttons: definition.quickReplies.map((text) => ({ type: "QUICK_REPLY", text })) }] : []),
    ],
  };
}

/* ---------------------------------------------------------------- cobrança --- */

/** A internet da BBNET é bloqueada com 7 dias de atraso (Vinícius, 18/11/2026); o aviso sai na véspera. */
export const BLOCK_AFTER_DAYS = 7;

export type BillingKind = "billing_block_warning" | "billing_overdue_1" | "billing_due_today" | "billing_due_3";

/**
 * As etapas, na ordem de prioridade: quem está para ser bloqueado primeiro, depois o atraso,
 * o vencimento de hoje e o lembrete. Se o limite do dia acabar, sobra o lembrete — o que
 * menos custa ao cliente perder.
 */
export const BILLING_STAGES: ReadonlyArray<{ kind: BillingKind; offsetDays: number; template: TemplateKey }> = [
  { kind: "billing_block_warning", offsetDays: -(BLOCK_AFTER_DAYS - 1), template: "billingBlockWarning" },
  { kind: "billing_overdue_1", offsetDays: -1, template: "billingOverdue" },
  { kind: "billing_due_today", offsetDays: 0, template: "billingDueToday" },
  { kind: "billing_due_3", offsetDays: 3, template: "billingDueSoon" },
];

/** A data `AAAA-MM-DD` em Brasília, deslocada em dias. */
export function brasiliaDate(at: Date, offsetDays = 0): string {
  return new Date(at.getTime() + offsetDays * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
}

export const formatMoney = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const formatDay = (isoDate: string) => (/^\d{4}-\d{2}-\d{2}/.test(isoDate) ? `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}` : isoDate);

/** Avisos só no horário em que se manda mensagem a cliente: das 8h às 20h em Brasília. */
export function sendingHours(at: Date): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(at)) % 24;
  return hour >= 8 && hour < 20;
}

/* ---------------------------------------------------------------- contato --- */

/**
 * O celular do cadastro no formato do WhatsApp (`55` + DDD + 9 dígitos). Só celular: fixo de 10
 * dígitos não recebe WhatsApp e mandar para ele só gastaria dinheiro. WhatsApp antes do celular.
 */
export function whatsappNumber(...candidates: string[]): string | undefined {
  for (const raw of candidates) {
    let digits = String(raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
    if (digits.length === 13 && digits.startsWith("55")) digits = digits.slice(2);
    if (digits.length === 11 && digits[2] === "9" && /^[1-9]{2}/.test(digits)) return `55${digits}`;
  }
  return undefined;
}

/**
 * O mesmo celular sempre com o nono dígito: o WhatsApp entrega alguns números brasileiros antigos
 * sem ele (`557991234567`), e o cadastro do IXC tem com ele. Sem isso, quem respondeu SAIR por um
 * formato continuaria recebendo pelo outro.
 */
export function canonicalPhone(phone: string): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("55") && /[6-9]/.test(digits[4])) return `${digits.slice(0, 4)}9${digits.slice(4)}`;
  return digits;
}

/** "MARIA DA SILVA" → "Maria". Nome de empresa (LTDA, ME, EIRELI…) vira "cliente". */
export function firstName(name: string): string {
  const clean = name.trim();
  if (!clean || /\b(ltda|eireli|me|epp|s\/?a|mei|associacao|associação|igreja|prefeitura|condominio|condomínio)\b/i.test(clean)) return "cliente";
  const first = clean.split(/\s+/)[0].replace(/[^\p{L}'-]/gu, "");
  return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : "cliente";
}

/* ------------------------------------------------------------- descadastro --- */

/** "SAIR", "parar", "não quero mais receber" — a resposta que tira o cliente dos avisos automáticos. */
export function isOptOut(text: string): boolean {
  const value = text.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  return /^(sair|parar|pare|stop|descadastrar|cancelar avisos|nao quero (mais )?receber)\b[.! ]*$/.test(value);
}
export function isOptIn(text: string): boolean {
  return /^(voltar|receber avisos)\b[.! ]*$/i.test(text.trim());
}
export const OPT_OUT_REPLY = "Pronto, você não vai mais receber avisos automáticos de fatura e de rede por aqui. Se mudar de ideia, responda VOLTAR. O atendimento pelo WhatsApp continua normalmente.";
export const OPT_IN_REPLY = "Pronto, você voltou a receber os avisos de fatura e de rede por aqui. Para parar, responda SAIR.";
