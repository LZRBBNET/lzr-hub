import { windowOpen } from "./conversation-state-shared.ts";

export type TrustScopeStage = "eligible" | "not_text" | "send_config_missing" | "sender_unverified" |
  "recipient_mismatch" | "message_id_unverified" | "message_time_unverified";
export type TrustActionStage = Exclude<TrustScopeStage,"eligible"> | "ixc_provider_missing" | "triage_missing" |
  "ticket_handoff" | "hook_missing" | "hook_error" | "no_outcome" |
  "needs_cpf" | "denied" | "refused" | "failed" | "skipped" | "done";

export function trustScopeStage(input: {kind:string;transcribed:boolean;senderVerified:boolean;receiver?:string;expectedReceiver?:string;id:string;sentAt?:string}, now:number):TrustScopeStage {
  if(input.kind!=="text"||input.transcribed)return "not_text";
  if(!input.expectedReceiver)return "send_config_missing";
  if(!input.senderVerified)return "sender_unverified";
  if(input.receiver!==input.expectedReceiver)return "recipient_mismatch";
  if(!/^wamid\.[A-Za-z0-9_=+\/-]{1,240}$/.test(input.id))return "message_id_unverified";
  if(!input.sentAt||!(Date.parse(input.sentAt)<=now)||!windowOpen(input.sentAt,now))return "message_time_unverified";
  return "eligible";
}

export function trustStageMarker(stage:TrustActionStage):string {
  // No caller data, IDs, timestamps, text, promises, or provider errors.
  return `lzr.trust_unlock.stage=${stage}`;
}

export function trustOutcomeStage(status?:string):TrustActionStage {
  switch(status){
    case "needs_cpf": case "denied":case "refused":case "failed":case "skipped":case "done": return status;
    default:return "no_outcome";
  }
}
