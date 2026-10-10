/** Nomes legíveis para códigos que vêm do pipeline e do canal. Sem dependência de servidor. */

const INTENT_LABELS: Record<string,string> = {
  technical_no_connection:"Sem conexão", technical_slow:"Lentidão", technical_wifi:"Wi-Fi", technical_restart:"Reinício de equipamento",
  technical_ticket:"Abertura de chamado", technical_visit:"Visita técnica", financial_invoice:"Fatura / segunda via", financial_pix:"PIX",
  financial_payment:"Pagamento", financial_unlock:"Desbloqueio", financial_discount_request:"Pedido de desconto", complaint:"Reclamação", cancellation_risk:"Risco de cancelamento",
  human_handoff:"Pedido de atendente", unauthorized_request:"Pedido não autorizado", out_of_scope:"Fora de escopo", general_information:"Informação geral",
};
const HANDOFF_LABELS: Record<string,string> = {
  low_intent_confidence:"A IA não entendeu o pedido", customer_requested_human:"Cliente pediu atendente", customer_irritated:"Cliente irritado",
  unauthorized_request:"Pedido não autorizado", cancellation_risk:"Risco de cancelamento", "não informado":"Não informado",
};
export const intentLabel = (key:string) => INTENT_LABELS[key] ?? key;
export const handoffLabel = (key:string) => HANDOFF_LABELS[key] ?? key;

/**
 * Telefone do WhatsApp em formato legível, sem esconder dígito de quem atende.
 * Brasileiro sai como "(79) 99999-0000"; os de fora, com o código do país —
 * "16465894168" cru não dizia nem que era um número dos Estados Unidos.
 */
export function conversationLabel(id:string) {
  if (!/^\d+$/.test(id)) return id;
  if (id.startsWith("55") && (id.length === 12 || id.length === 13)) {
    const ddd = id.slice(2,4); const rest = id.slice(4);
    return `(${ddd}) ${rest.slice(0,rest.length-4)}-${rest.slice(-4)}`;
  }
  if (id.startsWith("1") && id.length === 11) return `+1 (${id.slice(1,4)}) ${id.slice(4,7)}-${id.slice(7)}`;
  return id.length >= 8 ? `+${id}` : id;
}

/** O nome interno do canal ("n8n-whatsapp") é detalhe de implementação; quem atende vê "WhatsApp". */
export function channelLabel(channel:string) {
  return /whatsapp|meta|evolution/i.test(channel) ? "WhatsApp" : channel;
}
