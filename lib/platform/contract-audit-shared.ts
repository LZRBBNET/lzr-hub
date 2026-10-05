/**
 * Regras da auditoria de contratos: o que o cadastro do cliente precisa ter
 * quando um contrato novo nasce no IXC.
 *
 * Sem dependência de servidor: a tela também usa os rótulos e as dicas.
 *
 * As regras vieram da operação da BBNET e foram medidas na base real antes de
 * virar código (`scripts/ixc-probe-contract-audit.mjs`): numa amostra de 60
 * cadastros de contratos recentes, 4 estavam sem e-mail ou com e-mail inválido
 * e 2 tinham o Número do endereço zerado — gravado como "00" e "000", não só
 * "0", por isso a regra olha qualquer quantidade de zeros.
 */

export type ContractIssueCode =
  | "sem_celular"
  | "celular_invalido"
  | "sem_email"
  | "email_invalido"
  | "numero_vazio"
  | "numero_zero"
  | "numero_fora_do_padrao";

export interface ContractIssue {
  code: ContractIssueCode;
  /** O valor encontrado, só para o Número do endereço — nunca telefone ou e-mail. */
  found?: string;
}

export const ISSUE_TEXT: Record<ContractIssueCode, { label: string; hint: string }> = {
  sem_celular: { label: "Sem celular nem WhatsApp", hint: "Preencha Celular ou WhatsApp na aba Contato do cliente." },
  celular_invalido: { label: "Celular/WhatsApp incompleto", hint: "O número precisa ter DDD e telefone: 10 ou 11 algarismos." },
  sem_email: { label: "Sem e-mail", hint: "Preencha o E-mail na aba Contato do cliente." },
  email_invalido: { label: "E-mail inválido", hint: "O e-mail precisa estar no formato nome@dominio.com." },
  numero_vazio: { label: "Número do endereço vazio", hint: "Quando o endereço não tem número, o padrão é SN." },
  numero_zero: { label: "Número do endereço zerado", hint: "Não use 0: quando não há número, o padrão é SN." },
  numero_fora_do_padrao: { label: "Número fora do padrão", hint: "Use só o número da casa, ou SN quando não houver." },
};

export interface CustomerContactFields {
  mobile?: string;
  whatsapp?: string;
  email?: string;
  addressNumber?: string;
}

export type AddressNumberShape = "sn" | "numero" | "zero" | "vazio" | "fora_do_padrao";

/**
 * O campo Número do endereço. Aceita duas formas: **SN** (sem número) ou um
 * número de verdade. Zero não é número de casa — é o jeito errado de dizer "sem
 * número". "S/N", "s.n." e afins são o jeito certo com a grafia errada.
 */
export function classifyAddressNumber(raw: string | undefined): AddressNumberShape {
  const value = (raw ?? "").trim();
  if (!value) return "vazio";
  if (value.toUpperCase() === "SN") return "sn";
  if (/^0+$/.test(value)) return "zero";
  // "12A", "120-B", "KM 5": tem número. O que não tem algarismo nenhum e não é SN está fora do padrão.
  if (/[1-9]/.test(value)) return "numero";
  return "fora_do_padrao";
}

const digitCount = (value: string | undefined) => (value ?? "").replace(/\D/g, "").length;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * O que está errado no cadastro, na ordem em que a aba aparece no IXC.
 * Celular **ou** WhatsApp basta: os dois servem para alcançar o cliente.
 */
export function evaluateContact(fields: CustomerContactFields): ContractIssue[] {
  const issues: ContractIssue[] = [];

  const best = Math.max(digitCount(fields.mobile), digitCount(fields.whatsapp));
  if (best === 0) issues.push({ code: "sem_celular" });
  else if (best < 10) issues.push({ code: "celular_invalido" });

  const email = (fields.email ?? "").trim();
  if (!email) issues.push({ code: "sem_email" });
  else if (!EMAIL.test(email)) issues.push({ code: "email_invalido" });

  const shape = classifyAddressNumber(fields.addressNumber);
  const found = (fields.addressNumber ?? "").trim().slice(0, 12);
  if (shape === "vazio") issues.push({ code: "numero_vazio" });
  if (shape === "zero") issues.push({ code: "numero_zero", found });
  if (shape === "fora_do_padrao") issues.push({ code: "numero_fora_do_padrao", found });

  return issues;
}
