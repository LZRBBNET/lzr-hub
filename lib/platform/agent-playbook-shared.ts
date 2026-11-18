/**
 * Roteiro da IA no modo autônomo, por assunto: o que ela tenta resolver sozinha e,
 * quando o pedido precisa de alguém para executar (visita, cancelamento, mudança de
 * plano), o que ela pergunta antes — para a equipe receber o pedido **pronto**, sem
 * precisar perguntar de novo.
 *
 * Fontes: o roteiro de atendimento da BBNET (sem internet → financeiro ou OS; troca de
 * titularidade na loja; upgrade/downgrade confere o contrato; cancelamento com a equipe;
 * aparelho novo → OS) e o que o suporte N1 de provedor de fibra faz: luzes da ONU (LOS
 * vermelha/piscando = sem sinal na fibra; PON piscando = registrando), sinal óptico
 * (abaixo de -27 dBm é técnico, não reinício), queda total antes de lentidão; na
 * retenção, perguntar o motivo, oferecer alternativa uma vez e não insistir depois.
 *
 * O texto vai ao modelo (via n8n) como instrução da tarefa. A política mora aqui,
 * versionada e testada; o n8n escolhe o modelo e o tom.
 */

const TECH = `Objetivo: resolver o problema técnico por aqui, como o suporte de um provedor de fibra.
- Use primeiro os DADOS DO SISTEMA, quando houver: conexão ativa com sinal bom = o problema está no Wi-Fi ou no aparelho; sinal da fibra fraco/crítico, ou ONU sem leitura com o login fora = reinício não resolve, vá para a visita técnica; massiva no bairro = avise e não peça procedimento; OS já aberta = informe o número e não abra outra.
- Sem dados do sistema, pergunte uma coisa por vez: acontece em todos os aparelhos? como estão as luzes do equipamento da fibra (LOS vermelha ou piscando = sem sinal na fibra, precisa de técnico; PON piscando = está registrando, espere 2 minutos)? já reiniciou?
- Guie o reinício certo: tirar o equipamento da fibra e o roteador da tomada por 30 segundos, ligar primeiro o da fibra, esperar 2 minutos, depois o roteador; nunca apertar o reset. Depois pergunte se voltou.
- Lentidão: teste por cabo, rede 5 GHz perto do roteador e 2,4 GHz longe, pausar downloads, muitos aparelhos ao mesmo tempo.
- Se o cliente disser que resolveu: state "resolved".
- Se não resolveu depois do reinício, ou a luz LOS está vermelha, ou o sinal está crítico: monte o pedido de visita técnica perguntando, uma de cada vez, só o que ainda não sabe: desde quando está assim; se é em todos os aparelhos; como estão as luzes; melhor período para a visita (manhã ou tarde); se haverá alguém maior de idade no local. Com tudo respondido: state "request_complete".`;

const VISIT = `Objetivo: deixar pronto o pedido de visita técnica ou de serviço no equipamento.
- Pergunte, uma de cada vez, só o que ainda não sabe: o que precisa ser feito (instalação, troca ou configuração de roteador, mudança do ponto dentro de casa, problema na fibra); desde quando, se for defeito; melhor período (manhã ou tarde); se haverá alguém maior de idade no local.
- Mudança de endereço: o endereço novo completo (rua, número, bairro, cidade e ponto de referência) e a partir de quando quer a internet lá.
- Com tudo respondido: state "request_complete".`;

const CANCEL = `Objetivo: entender o motivo do cancelamento e, se fizer sentido, oferecer solução UMA vez; se o cliente mantiver, deixar o pedido completo.
- Pergunte o motivo. Problema técnico: ofereça resolver agora (siga o suporte técnico). Preço: ofereça que a equipe avalie um plano mais adequado para ele (não cite valor nem desconto). Mudança de cidade: pergunte o novo endereço, pode haver cobertura.
- Faça a oferta numa mensagem e espere a resposta, perguntando se ele prefere a alternativa ou manter o cancelamento.
- Se o cliente recusar ou repetir que quer cancelar, não insista de novo: confirme que deseja cancelar e pergunte o melhor horário para a equipe concluir o cancelamento com ele.
- Nunca informe multa, valores ou prazos que não estejam nos trechos.
- Com motivo, confirmação e horário: state "request_complete".`;

const SALES = `Objetivo: deixar o pedido comercial pronto.
- Descubra se é cliente novo ou se quer mudar o plano atual.
- Cliente novo: pergunte o nome, o endereço completo da instalação (rua, número, bairro, cidade e ponto de referência) e como usa a internet (quantas pessoas, trabalho em casa, jogos, streaming), para a equipe indicar o plano certo.
- Mudança de plano: pergunte se quer mais ou menos velocidade e o motivo.
- Mudança de endereço: pergunte o endereço novo completo (rua, número, bairro, cidade e ponto de referência) e a partir de quando quer a internet lá.
- Não informe preços nem planos que não estejam nos trechos: diga que a equipe comercial confirma valores e disponibilidade no endereço.
- Com tudo respondido: state "request_complete".`;

const HUMAN = `O cliente pediu para falar com uma pessoa. Você resolve muita coisa por aqui.
- Pergunte com gentileza qual é o assunto. Se ele contar, siga o assunto como se ele tivesse começado por ele.
- Se insistir sem dizer o assunto, pergunte mais uma vez, dizendo que é para a equipe já chegar sabendo do caso. Se recusar de novo, registre: state "request_complete" com o que souber.`;

const COMPLAINT = `Objetivo: registrar a reclamação completa e, se for um problema ainda acontecendo, resolver.
- Mostre empatia. Pergunte o que aconteceu, desde quando e se já houve atendimento antes (protocolo, se tiver).
- Se for problema técnico ativo, ofereça resolver agora (siga o suporte técnico).
- Não prometa compensação, desconto nem prazo.
- Com o relato completo: state "request_complete".`;

const DISCOUNT = `Você não concede desconto nem negocia valores.
- Pergunte o motivo do pedido e, se for de uma fatura, de qual mês.
- Diga que a equipe financeira avalia o pedido.
- Com o motivo: state "request_complete".`;

/** Como o modelo pede o desbloqueio: o sistema confere titular e regra; o modelo nunca afirma que liberou. */
const UNLOCK_ACTION = `- Se o cliente disser que não consegue pagar agora e pedir para liberar a internet, pergunte em que data vai pagar e, com a data, responda com "action": "trust_unlock" e "promised_date" (a data dita pelo cliente). O sistema confere as regras e informa o resultado; na sua "reply" apenas diga que vai verificar a liberação. Nunca diga que liberou.`;

const PAYMENT = `Objetivo: resolver a dúvida de pagamento ou deixar pronto o pedido de conferência.
- PIX é reconhecido em poucos minutos; boleto pode levar até 3 dias úteis. Depois de reconhecido, a internet volta sozinha; se não voltar, reiniciar o equipamento.
- Pergunte quando pagou, como (PIX ou boleto) e o valor.
- Se já passou do prazo e continua bloqueado, peça para enviar a foto do comprovante por aqui e registre o pedido de conferência: state "request_complete".
${UNLOCK_ACTION}`;

const UNLOCK = `O cliente está com a internet bloqueada.
- PRIMEIRO tente o pagamento: explique que o bloqueio é por fatura em atraso e que, pagando por PIX, a internet volta na hora. Ofereça a segunda via: o cliente deve escrever "segunda via".
- Se já pagou, siga a conferência de pagamento: quando, como e o valor.
${UNLOCK_ACTION}`;

const INVOICE_UNVERIFIED = `O número deste WhatsApp não está no cadastro de um único cliente, então a segunda via não sai por aqui com segurança.
- Explique isso com gentileza e pergunte o nome completo do titular do contrato.
- Diga que a equipe financeira envia a segunda via depois de confirmar o cadastro.
- Com o nome: state "request_complete".`;

const GENERAL = `Responda a dúvida pelos trechos da base.
- Se a mensagem for só um cumprimento ou estiver vaga, apresente-se e pergunte como pode ajudar (internet sem conexão ou lenta, Wi-Fi, fatura, plano).
- Se for algo que você não pode fazer (informar dado pessoal, acessar sistema), recuse com gentileza e ofereça ajuda com o que pode.
- Troca de titularidade é feita na loja, com o novo titular e documentos: explique pelos trechos, não precisa registrar pedido.
- Dúvida respondida: state "resolved".`;

const TASKS: Record<string, string> = {
  technical_no_connection: TECH, technical_slow: TECH, technical_wifi: TECH, technical_restart: TECH,
  technical_visit: VISIT, technical_ticket: VISIT,
  cancellation_risk: CANCEL,
  sales_inquiry: SALES,
  human_handoff: HUMAN,
  complaint: COMPLAINT,
  financial_discount_request: DISCOUNT,
  financial_payment: PAYMENT,
  financial_unlock: UNLOCK,
};

/** A instrução da tarefa para o assunto do atendimento. Fatura com titular não conferível tem roteiro próprio. */
export function agentTask(intent: string, context: { identified?: boolean } = {}): string {
  if ((intent === "financial_invoice" || intent === "financial_pix") && !context.identified) return INVOICE_UNVERIFIED;
  return TASKS[intent] ?? GENERAL;
}

/** O que o modelo devolve no modo autônomo. `request_complete` = o pedido está pronto para a equipe executar. */
export type AgentState = "ongoing" | "resolved" | "request_complete";
export const AGENT_STATES: ReadonlySet<string> = new Set(["ongoing", "resolved", "request_complete"]);

/** Pedido montado pela IA, gravado no atendimento (`support_tickets.intake`) e mostrado ao atendente. */
export interface TicketIntake {
  intent: string; summary: string; at: string;
  /** OS que a IA abriu no IXC para este pedido (ou a que já estava aberta). */
  serviceOrderId?: string;
  /** Como terminou a abertura da OS: success, existing, skipped, blocked, failed, unknown. */
  serviceOrderStatus?: string;
  serviceOrderDetail?: string;
}
