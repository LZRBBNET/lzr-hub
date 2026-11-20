import { openOrContinueTicket, type TicketRepository } from "./triage-service.ts";
import { CHANNEL_NAME, type ChannelRepository, type ChannelResponse, type AutoReplySender } from "./n8n-channel-service.ts";
import { TRIAGE_MENU } from "./triage-shared.ts";

export function requestsHuman(text: string, interactiveReplyId?: string): boolean {
  const official = TRIAGE_MENU.findIndex(item => item.intent === "human_handoff") + 1;
  if (official > 0 && interactiveReplyId === `menu-${official}`) return true;
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  // Conservative: do not infer intent from negation, a quoted phrase, a number or a mere mention.
  if (/\b(nao|nem|nunca|dispenso|sem)\b/.test(normalized)) return false;
  return /^(?:(?:oi|ola)[,! ]+)?(?:por favor[, ]+)?(?:(?:quero|preciso|gostaria de) (?:falar|conversar) com (?:um |uma |o |a )?(?:atendente|humano|pessoa)|(?:falar|conversar) com (?:um |uma |o |a )?atendente|(?:me )?(?:transfira|encaminhe)(?:-me)? (?:para|pra) (?:um |uma |o |a )?atendente)(?:\s*(?:[.!?,;:]|$))/.test(normalized);
}

/** Deliberately has no account lookup, classifier, model, CRM or IXC dependency. */
export async function explicitHumanHandoff(deps: { channel: ChannelRepository; tickets: TicketRepository; send: AutoReplySender },
  input: { conversationId: string; text: string; inboundMessageId: string; correlationId: string }): Promise<ChannelResponse> {
  const previous = await deps.channel.findIdempotent(input.inboundMessageId);
  if (previous) return previous;
  await deps.channel.saveMessages(CHANNEL_NAME,input.conversationId,[{role:"customer",content:input.text,externalMessageId:input.inboundMessageId,correlationId:input.correlationId}]);
  const {ticket} = await openOrContinueTicket(deps.tickets,{channel:CHANNEL_NAME,conversationId:input.conversationId});
  const alreadyHandedOff = ticket.stage === "handoff";
  if (!alreadyHandedOff && !await deps.tickets.updateTriage(ticket.id,{stage:"handoff"})) throw Error("EXPLICIT_HANDOFF_NOT_CONFIRMED");
  await deps.channel.audit({correlationId:input.correlationId,entity:`conversation:${input.conversationId}`,action:"whatsapp.handoff.explicit",result:"recorded",
    reason:"Pedido explícito registrado na fila humana, sem identificação de conta. Não comprova disponibilidade, atribuição ou entrega."});
  const text = `Seu pedido para falar com um atendente foi registrado.${ticket.protocol ? ` Protocolo: ${ticket.protocol}.` : ""} A equipe continuará por aqui quando puder.`;
  // Retry after the durable transition recovers evidence, never invents a new send authorization.
  const delivery = alreadyHandedOff ? {sent:false as const} : await deps.send({conversationId:input.conversationId,text,inboundMessageId:input.inboundMessageId});
  if (delivery.sent) await deps.channel.saveMessages(CHANNEL_NAME,input.conversationId,[{role:"agent",content:text,externalMessageId:delivery.messageId,sentBy:"ia",correlationId:input.correlationId}]);
  await deps.channel.audit({correlationId:input.correlationId,entity:`conversation:${input.conversationId}`,action:"whatsapp.handoff.explicit_confirmation",result:delivery.sent ? "accepted" : "not_confirmed",reason:"Confirmação separada da transferência; aceite não comprova entrega ao cliente."});
  const result: ChannelResponse = {response:delivery.sent ? text : null,autoReply:delivery.sent,status:"awaiting_human",handoff:true,correlationId:input.correlationId};
  await deps.channel.saveIdempotency(input.inboundMessageId,CHANNEL_NAME,input.conversationId,result);
  return result;
}
