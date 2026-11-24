import test from "node:test";
import assert from "node:assert/strict";
import { trustScopeStage, trustStageMarker, trustOutcomeStage } from "../lib/platform/trust-unlock-stage.ts";
const now=Date.parse("2026-11-24T15:00:00.000Z");
const base={kind:"text",transcribed:false,senderVerified:true,receiver:"99",expectedReceiver:"99",id:"wamid.synthetic",sentAt:"2026-11-24T14:59:59.000Z"};
test("same protected admission outcomes, only fixed first failing stage is reported",()=>{
 for(const [patch,stage] of [[{},"eligible"],[{kind:"audio"},"not_text"],[{transcribed:true},"not_text"],
  [{expectedReceiver:undefined},"send_config_missing"],[{senderVerified:false},"sender_unverified"],[{receiver:"77"},"recipient_mismatch"],
  [{id:"not-wamid"},"message_id_unverified"],[{sentAt:undefined},"message_time_unverified"],
  [{sentAt:"2026-11-24T15:00:01Z"},"message_time_unverified"],[{sentAt:"2026-11-23T14:59:59Z"},"message_time_unverified"]]){
   assert.equal(trustScopeStage({...base,...patch},now),stage);
 }
});
test("provider messages and dynamic status are never promoted to stage text",()=>{
 const arbitrary="test-private-external-detail";
 assert.equal(trustStageMarker(trustOutcomeStage(arbitrary)),"lzr.trust_unlock.stage=no_outcome");
 for(const value of ["needs_cpf","denied","refused","failed","skipped","done"])
   assert.equal(trustStageMarker(trustOutcomeStage(value)),`lzr.trust_unlock.stage=${value}`);
});
