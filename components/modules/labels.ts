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

/** Telefone do WhatsApp em formato legível, sem esconder dígito de quem atende. */
export function conversationLabel(id:string) {
  const digits = id.replace(/\D/g,"");
  if (digits.length < 12 || digits.length > 13) return id;
  const ddd = digits.slice(2,4); const rest = digits.slice(4);
  return `(${ddd}) ${rest.slice(0,rest.length-4)}-${rest.slice(-4)}`;
}
