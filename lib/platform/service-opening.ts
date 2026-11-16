/** A legacy agent row indicates prior output, NOT confirmed delivery. Unknown
 * status conservatively suppresses repeated greetings. No session is invented. */
export interface OpeningRow { role: string; deliveryStatus?: string; }
export function hasPriorOutput(rows: OpeningRow[]): boolean {
  return rows.some(row => row.role === "agent" && !["failed", "blocked", "not_sent"].includes(row.deliveryStatus ?? ""));
}
export function serviceOpening(text: string, input: { now: number; priorOutput: boolean; concise: boolean }): string {
  const bodyWithoutGreeting = text.replace(/^(?:bom dia|boa tarde|boa noite|olá)[!,.: ]*/i, "").replace(/^tudo bem\?[ ]*/i, "");
  if (input.priorOutput) return bodyWithoutGreeting;
  let greeting = "Olá";
  if (Number.isFinite(input.now) && Number.isFinite(new Date(input.now).getTime())) {
    const hour = Number(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Maceio", hour: "numeric", hourCycle: "h23" }).format(new Date(input.now)));
    greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
  }
  // No name is accepted until the caller has a trustworthy validated field.
  let body = bodyWithoutGreeting;
  if (input.concise && !/sinto muito|entendo|entendi|precisa da avalia|preocupacao|preocupação/i.test(body)) body = `Sinto muito pelo transtorno. ${body}`;
  return `${greeting}! ${input.concise ? "" : "Tudo bem? "}${body}`;
}
