import { CHANNEL_NAME, type ChannelRepository, type ChannelResponse, type AutoReplySender } from "./n8n-channel-service.ts";
import { canonicalPhone, OPT_IN_REPLY, OPT_OUT_REPLY } from "./outbound-shared.ts";
import type { OutboundRepository } from "./outbound-service.ts";

type Repositories = {channel: ChannelRepository; outbound: Pick<OutboundRepository,"setOptOut">};
export async function processConsentCommand(deps: {channel: ChannelRepository; transaction: <T>(work: (repos: Repositories) => Promise<T>) => Promise<T>; confirmationEnabled: boolean; send: AutoReplySender},
  input: {conversationId: string; inboundMessageId: string; text: string; out: boolean; correlationId: string}) {
  const previous = await deps.channel.findIdempotent(input.inboundMessageId);
  if (previous) return previous;
  const receipt = `consent:${input.inboundMessageId}`;
  const base: ChannelResponse = {response:null,autoReply:false,status:input.out ? "opted_out" : "opted_in",handoff:false,correlationId:input.correlationId};
  // Consent, inbound and its receipt commit together BEFORE any possible notification.
  // Retrying an older command must not overwrite a newer consent decision.
  const consent = await deps.transaction(async ({channel,outbound}) => {
    const existing = await channel.findIdempotent(receipt) as (ChannelResponse & {confirmationAllowed?: boolean}) | undefined;
    if (existing) return existing;
    await channel.saveMessages(CHANNEL_NAME,input.conversationId,[{role:"customer",content:input.text,externalMessageId:input.inboundMessageId,correlationId:input.correlationId}]);
    await outbound.setOptOut(canonicalPhone(input.conversationId),input.out,"whatsapp");
    await channel.audit({correlationId:input.correlationId,entity:`conversation:${input.conversationId}`,action:"whatsapp.consent.applied",result:"recorded",reason:input.out ? "Opt-out aplicado; confirmação independente." : "Opt-in aplicado; confirmação independente."});
    const recorded = {...base,confirmationAllowed:deps.confirmationEnabled};
    await channel.saveIdempotency(receipt,CHANNEL_NAME,input.conversationId,recorded);
    return recorded;
  });
  const text = input.out ? OPT_OUT_REPLY : OPT_IN_REPLY;
  const confirmationAllowed = deps.confirmationEnabled && consent.confirmationAllowed === true;
  const delivery = confirmationAllowed ? await deps.send({conversationId:input.conversationId,text,inboundMessageId:input.inboundMessageId}) : {sent:false as const};
  if (delivery.sent) await deps.channel.saveMessages(CHANNEL_NAME,input.conversationId,[{role:"agent",content:text,externalMessageId:delivery.messageId,sentBy:"ia",correlationId:input.correlationId}]);
  await deps.channel.audit({correlationId:input.correlationId,entity:`conversation:${input.conversationId}`,action:"whatsapp.consent.confirmation",result:!confirmationAllowed ? "suppressed" : delivery.sent ? "accepted" : "not_confirmed",reason:!confirmationAllowed ? "Confirmação suprimida pelo controle de saída; consentimento e entrada preservados." : "Confirmação independente do consentimento; aceite não comprova entrega."});
  const result = {...base,response:delivery.sent ? text : null,autoReply:delivery.sent};
  await deps.channel.saveIdempotency(input.inboundMessageId,CHANNEL_NAME,input.conversationId,result);
  return result;
}
