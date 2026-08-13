/**
 * Validação de CPF e CNPJ pelos dígitos verificadores.
 *
 * Existe porque cadastrar cliente no ERP com documento inválido cria alguém que
 * **nunca vai faturar direito**: boleto registrado em banco é recusado, nota
 * fiscal não sai, e a correção depois exige mexer num cadastro que já tem
 * contrato pendurado. Recusar na entrada custa um aviso; recusar depois custa
 * uma auditoria.
 *
 * Não valida se a pessoa existe — só se o número é possível. É o que dá para
 * saber sem consultar a Receita, e já elimina digitação errada e número
 * inventado.
 */

const onlyDigits = (value: string) => value.replace(/\D/g, "");

/** Todos os dígitos iguais passam na conta dos verificadores, e nenhum é documento real. */
const allSame = (digits: string) => /^(\d)\1+$/.test(digits);

function cpfIsValid(digits: string): boolean {
  if (digits.length !== 11 || allSame(digits)) return false;
  for (const [length, factor] of [[9, 10], [10, 11]] as const) {
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += Number(digits[index]) * (factor - index);
    const rest = (sum * 10) % 11 % 10;
    if (rest !== Number(digits[length])) return false;
  }
  return true;
}

function cnpjIsValid(digits: string): boolean {
  if (digits.length !== 14 || allSame(digits)) return false;
  const weights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (const length of [12, 13]) {
    const slice = weights.slice(weights.length - length);
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += Number(digits[index]) * slice[index];
    const rest = sum % 11;
    const expected = rest < 2 ? 0 : 11 - rest;
    if (expected !== Number(digits[length])) return false;
  }
  return true;
}

export type PersonKind = "F" | "J";

export interface DocumentCheck { valid: boolean; kind?: PersonKind; masked?: string }

/**
 * Confere o documento e devolve, quando válido, o tipo de pessoa e o formato
 * com máscara — que é como o IXC guarda.
 */
export function checkDocument(raw: string): DocumentCheck {
  const digits = onlyDigits(raw);
  if (digits.length === 11 && cpfIsValid(digits)) {
    return { valid: true, kind: "F", masked: `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}` };
  }
  if (digits.length === 14 && cnpjIsValid(digits)) {
    return { valid: true, kind: "J", masked: `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}` };
  }
  return { valid: false };
}
