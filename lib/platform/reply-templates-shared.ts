import { sanitizeHandoffText } from "../agent/handoff.ts";
import type { Intent } from "../agent/types.ts";

/**
 * Respostas aprovadas por intenção — o que o canal sugere (e, um dia, envia) no
 * lugar do texto de homologação do pipeline.
 *
 * Este arquivo não importa nada de servidor: a tela de edição também o usa, e
 * arrastar o banco para o navegador já quebrou um build antes.
 *
 * Por que **textos e não um prompt livre**: o modelo de linguagem do projeto só
 * escolhe uma intenção de uma lista fechada, e a resposta ao cliente tem
 * garantias que um prompt aberto jogaria fora (nunca afirmar ação não
 * executada, transbordar quando não sabe). Editar o texto aprovado dá à BBNET o
 * controle do tom sem abrir essa porta.
 *
 * Os textos abaixo descrevem o próximo passo necessário, não prometem envio,
 * encaminhamento ou execução. O canal não confirma ações no ERP por si só.
 */

export const REPLY_INTENTS: Array<{ intent: Intent; label: string }> = [
  { intent: "technical_no_connection", label: "Sem conexão" },
  { intent: "technical_slow", label: "Lentidão" },
  { intent: "technical_wifi", label: "Wi-Fi" },
  { intent: "technical_restart", label: "Reinício de equipamento" },
  { intent: "technical_ticket", label: "Abertura de chamado" },
  { intent: "technical_visit", label: "Visita técnica" },
  { intent: "financial_invoice", label: "Fatura / segunda via" },
  { intent: "financial_pix", label: "PIX" },
  { intent: "financial_payment", label: "Pagamento" },
  { intent: "financial_unlock", label: "Desbloqueio" },
  { intent: "financial_discount_request", label: "Pedido de desconto" },
  { intent: "complaint", label: "Reclamação" },
  { intent: "cancellation_risk", label: "Risco de cancelamento" },
  { intent: "human_handoff", label: "Pedido de atendente" },
  { intent: "unauthorized_request", label: "Pedido não autorizado" },
  { intent: "out_of_scope", label: "Fora de escopo" },
  { intent: "sales_inquiry", label: "Planos e contratação" },
  { intent: "general_information", label: "Informação geral" },
];

export const DEFAULT_REPLY_TEMPLATES: Record<Intent, string> = {
  technical_no_connection: "Vamos por partes: alguma luz do equipamento está vermelha ou apagada?",
  technical_slow: "A lentidão acontece em todos os aparelhos ou só em um?",
  technical_wifi: "O problema no Wi-Fi acontece em qual cômodo?",
  technical_restart: "Para reiniciar o roteador, tire da tomada por 30 segundos e ligue de novo. Não aperte o botão de reset. Depois, me diga se a conexão voltou.",
  technical_ticket: "A abertura do chamado precisa ser feita pela equipe técnica. Ainda não tenho um número de chamado para confirmar.",
  technical_visit: "A equipe precisa conferir a disponibilidade antes de combinar a visita com você. Não consigo confirmar um horário por aqui.",
  financial_invoice: "Um atendente precisa consultar sua fatura para enviar a segunda via correta por aqui.",
  financial_pix: "Um atendente precisa consultar sua fatura para enviar o PIX correto por aqui.",
  financial_payment: "Obrigado por avisar. Um atendente precisa conferir a baixa do pagamento; ainda não tenho essa confirmação por aqui.",
  financial_unlock: "O desbloqueio depende de uma conferência do cadastro. Ainda não consigo confirmar a liberação por aqui.",
  financial_discount_request: "Desconto ou renegociação dependem de aprovação. Um atendente precisa avaliar seu pedido antes de confirmar qualquer condição.",
  complaint: "Sinto muito pelo transtorno. Seu caso precisa da atenção de um atendente, com o histórico do que você já contou aqui.",
  cancellation_risk: "Sobre o cancelamento, um atendente precisa explicar as condições e dar continuidade se você decidir seguir. Não consigo concluir o cancelamento automaticamente.",
  human_handoff: "Certo. O próximo passo é continuar com um atendente, usando o que você já contou aqui.",
  unauthorized_request: "Não consigo ajudar com esse tipo de pedido. Posso ajudar com internet, Wi-Fi, fatura e cadastro.",
  out_of_scope: "Posso ajudar com internet, Wi-Fi, fatura e cadastro na BBNET. Para esse outro assunto, não consigo ajudar.",
  sales_inquiry: "Em qual cidade você quer instalar a internet? A disponibilidade e os planos precisam ser conferidos para o endereço.",
  general_information: "O que você precisa resolver? Pode me contar com suas palavras.",
};

export type ReplyOverrides = Partial<Record<Intent, string>>;

export const MAX_REPLY_LENGTH = 1000;

/**
 * O pipeline escreve texto de homologação ("preparei a segunda via *fictícia*").
 * Entregar essa palavra a um cliente real é o erro que este arquivo existe para
 * evitar — vale para o texto editado, para o envio pela tela e para o rascunho.
 */
const HOMOLOGATION_MARKERS = /fict[ií]ci|homologa[cç][aã]o|simulad[oa]|ambiente de teste/i;

export function containsHomologationText(text: string): boolean {
  return HOMOLOGATION_MARKERS.test(text);
}

/** `null` quando o texto serve; senão, o motivo em português para mostrar a quem editou. */
export function validateReplyText(text: string): string | null {
  const value = text.trim();
  if (!value) return "Escreva o texto da resposta.";
  if (value.length > MAX_REPLY_LENGTH) return `A resposta passa de ${MAX_REPLY_LENGTH} caracteres.`;
  if (containsHomologationText(value)) return "O texto menciona homologação, simulação ou dado fictício — isso não pode chegar a um cliente.";
  // Uma resposta aprovada vai para todo cliente daquela intenção. Dado pessoal ali
  // seria entregue a quem não é o titular.
  if (sanitizeHandoffText(value) !== value) return "O texto não pode conter e-mail, CPF ou telefone — ele vale para todos os clientes.";
  return null;
}

/** A resposta aprovada para a intenção: a editada, se existir e servir; senão o padrão. */
export function resolveReply(intent: Intent, overrides?: ReplyOverrides): string {
  const edited = overrides?.[intent]?.trim();
  return edited && validateReplyText(edited) === null ? edited : DEFAULT_REPLY_TEMPLATES[intent];
}
