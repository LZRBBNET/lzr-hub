import { checkDocument } from "./document-check.ts";

/**
 * Segunda via com confirmação do titular — o autoatendimento financeiro que os
 * bots de provedor oferecem (SimplesDesk, Talqui, o Opa! Suite da IXC).
 *
 * Regra decidida pela BBNET: **o telefone não basta, a IA pede o CPF**. E o CPF
 * sozinho também não: ele precisa ser do mesmo cadastro que o telefone da
 * conversa identificou. CPF vaza com facilidade; telefone de terceiro também.
 * Os dois juntos são o que dá para conferir sem senha.
 *
 * O CPF nunca é gravado: o atendimento guarda só o resultado da conferência.
 *
 * Sem dependência de servidor: a tela usa os rótulos e o mesmo rascunho.
 */

export const INVOICE_INTENTS = new Set(["financial_invoice", "financial_pix"]);
/** Tentativas de CPF antes de passar para o atendente. */
export const MAX_CPF_ATTEMPTS = 2;

export type InvoiceStep = "awaiting_cpf" | "invalid_cpf" | "verified" | "mismatch" | "unavailable";

export interface InvoicePreviewItem { id: string; dueAt: string | null; value: number | null; overdue: boolean; paymentCode: string | null }

export interface InvoiceSelfService {
  step: InvoiceStep;
  at: string;
  attempts: number;
  purpose?: "trust_unlock";
  verifiedHolderId?: string;
  unlockPromptMessageId?: string;
  /** Faturas em aberto do titular confirmado. Ausente antes da confirmação. */
  invoices?: InvoicePreviewItem[];
  /** PIX copia-e-cola da fatura que vence primeiro. Nulo = o IXC não devolveu (o rascunho segue sem ele). */
  pix?: { invoiceId: string; copyPaste: string; expiresAt: string | null } | null;
  /** O que a IA mandaria ao cliente com a fatura — rascunho para o atendente enquanto o envio não é ligado. */
  draft?: string;
}

export const ASK_CPF_TEXT = "Para te enviar a segunda via com segurança, preciso confirmar o titular. Me diga o CPF (ou CNPJ) do titular do contrato, só os números.";
export const INVALID_CPF_TEXT = "Esse número não parece um CPF válido. Confere e me manda de novo, só os números?";
export const MISMATCH_TEXT = "Esse documento não confere com o cadastro deste número de WhatsApp. Um atendente vai te ajudar por aqui.";
export const UNAVAILABLE_TEXT = "Não consegui consultar seu cadastro agora. Um atendente vai te enviar a segunda via por aqui.";
export const VERIFIED_HANDOFF_TEXT = "Titular confirmado, obrigado! Um atendente já vai te enviar a segunda via por aqui.";

/**
 * O documento na fala do cliente: o primeiro número com cara de CPF ou CNPJ,
 * com ou sem pontuação. `invalid` = tem o tamanho, mas os dígitos verificadores
 * não fecham (erro de digitação, na maioria das vezes).
 */
export function extractDocument(text: string): { digits?: string; invalid?: boolean } {
  // Sem dígito colado antes nem depois: um telefone de 13 dígitos não pode virar
  // um "CPF" de 11 por acaso — 1 em cada 100 sequências fecharia os verificadores.
  const candidates = text.match(/(?<!\d)(?:\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}|\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2})(?!\d)/g) ?? [];
  let sawLength = false;
  for (const candidate of candidates) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length !== 11 && digits.length !== 14) continue;
    sawLength = true;
    if (checkDocument(digits).valid) return { digits };
  }
  return sawLength ? { invalid: true } : {};
}

const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const day = (iso: string) => iso.replace(/^(\d{4})-(\d{2})-(\d{2}).*$/, "$3/$2/$1");

/**
 * O texto com as faturas. Só leva o que veio do IXC: vencimento, valor e, quando
 * o IXC devolve, a linha digitável. Nada de PIX enquanto o formato do `get_pix`
 * não for provado com uma fatura real.
 */
export function invoiceDraft(invoices: InvoicePreviewItem[], pix?: InvoiceSelfService["pix"]): string {
  if (invoices.length === 0) return "Titular confirmado! Não encontrei fatura em aberto no seu cadastro. Se você recebeu uma cobrança, me mande uma foto que um atendente confere.";
  const lines = invoices.slice(0, 5).map((invoice) => `• vence ${invoice.dueAt ? day(invoice.dueAt) : "sem data"} — ${invoice.value !== null ? money(invoice.value) : "valor não informado"}${invoice.overdue ? " (vencida)" : ""}`);
  const first = invoices[0];
  // PIX primeiro: fatura de gateway (o caso da BBNET) não tem linha digitável no IXC.
  // No backup de Itabaiana o cliente achava que o código era link ("não consigo pagar por esse link"): a explicação
  // vai antes do código, e o código fica por último para sair numa mensagem só dele (`splitPixCode`).
  const code = pix && pix.invoiceId === first.id
    ? `\n\nPara pagar, copie o código da próxima mensagem e cole no aplicativo do seu banco, na opção *Pix Copia e Cola* (não é link).\nPIX copia e cola da que vence primeiro${first.value !== null ? ` (${money(first.value)})` : ""}:\n${pix.copyPaste}`
    : first.paymentCode ? `\n\nLinha digitável da que vence primeiro:\n${first.paymentCode}` : "";
  const intro = invoices.length === 1 ? "Titular confirmado! Você tem 1 fatura em aberto:" : `Titular confirmado! Você tem ${invoices.length} faturas em aberto:`;
  return `${intro}\n${lines.join("\n")}${code}`;
}

/**
 * Código PIX no fim do texto sai numa mensagem só dele. Copiar uma mensagem do WhatsApp copia a mensagem inteira:
 * com o texto junto, o banco recusa o código. A atendente de Itabaiana manda o código sozinho ~3 mil vezes no backup.
 */
export function splitPixCode(text: string): { body: string; code: string } | undefined {
  const match = /\n(000201\S{20,})\s*$/.exec(text);
  if (!match) return undefined;
  const body = text.slice(0, match.index).trim();
  return body ? { body, code: match[1] } : undefined;
}

export const INVOICE_STEP_LABELS: Record<InvoiceStep, string> = {
  awaiting_cpf: "IA pediu o CPF do titular",
  invalid_cpf: "CPF inválido — IA pediu de novo",
  verified: "Titular confirmado pelo CPF",
  mismatch: "CPF não confere com o cadastro do número",
  unavailable: "IXC não respondeu à conferência",
};
