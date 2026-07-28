import { randomUUID } from "node:crypto";
import { logUnauthenticatedAction } from "../platform/audit-log.ts";
import type { CopilotActor } from "./types.ts";

const RECEIPT_TTL_MS=15*60*1000;

interface SuggestionReceipt {
  id:string;
  actorId:string;
  conversationId:string;
  sourceIds:string[];
  expiresAt:number;
  usedAt?:string;
}

export interface CopilotUseAudit {
  suggestionId:string;
  actorId:string;
  conversationId:string;
  sourceIds:string[];
  storage:"database"|"memory";
  at:string;
}

const receipts=new Map<string,SuggestionReceipt>();
const memoryAudit:CopilotUseAudit[]=[];

export class CopilotSuggestionReceiptError extends Error {}

export function issueSuggestionReceipt(input:{
  actor:CopilotActor;
  conversationId:string;
  sourceIds:string[];
  now?:Date;
}):string {
  const now=input.now??new Date();
  const id=randomUUID();
  receipts.set(id,{
    id,
    actorId:input.actor.id,
    conversationId:input.conversationId,
    sourceIds:[...input.sourceIds],
    expiresAt:now.getTime()+RECEIPT_TTL_MS,
  });
  return id;
}

export async function consumeSuggestionReceipt(input:{
  actor:CopilotActor;
  conversationId:string;
  suggestionId:string;
  now?:Date;
}):Promise<CopilotUseAudit> {
  const now=input.now??new Date();
  const receipt=receipts.get(input.suggestionId);
  if(!receipt
    ||receipt.actorId!==input.actor.id
    ||receipt.conversationId!==input.conversationId
    ||receipt.expiresAt<now.getTime()
    ||receipt.usedAt){
    throw new CopilotSuggestionReceiptError("Sugestão inválida, expirada ou já utilizada");
  }

  receipt.usedAt=now.toISOString();
  const persisted=await logUnauthenticatedAction({
    action:"copilot.suggestion.use",
    entity:`conversation:${receipt.conversationId}`,
    result:"success",
    reason:`Sugestão interna utilizada após revisão; fontes: ${receipt.sourceIds.join(", ")}`,
    correlationId:`copilot-use-${receipt.id}`,
    actor:input.actor,
  });
  const audit:CopilotUseAudit={
    suggestionId:receipt.id,
    actorId:receipt.actorId,
    conversationId:receipt.conversationId,
    sourceIds:[...receipt.sourceIds],
    storage:persisted?"database":"memory",
    at:receipt.usedAt,
  };
  if(!persisted)memoryAudit.push(audit);
  return audit;
}

export function listMemoryCopilotAudit():CopilotUseAudit[] {
  return memoryAudit.map((entry)=>({...entry,sourceIds:[...entry.sourceIds]}));
}

export function resetCopilotSuggestionRegistryForTests() {
  receipts.clear();
  memoryAudit.length=0;
}
