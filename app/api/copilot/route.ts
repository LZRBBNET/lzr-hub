import { NextResponse } from "next/server";
import { CopilotConversationForbiddenError, runInternalCopilot } from "@/lib/copilot/service";
import { containsCopilotInstructionInjection, copilotEnabled, hasUntrustedCopilotContext, resolveCopilotActor } from "@/lib/copilot/security";
import type { CopilotAction } from "@/lib/copilot/types";
import { consumeSuggestionReceipt, CopilotSuggestionReceiptError } from "@/lib/copilot/suggestion-registry";

const actions=new Set<CopilotAction>(["suggest_reply","ask","summarize"]);
const requestActions=new Set([...actions,"use_suggestion"]);
export async function GET() {
  return NextResponse.json({enabled:copilotEnabled()});
}

export async function POST(request:Request) {
  if(!copilotEnabled())return NextResponse.json({error:"Copiloto desabilitado"},{status:404});

  const actor=await resolveCopilotActor(request);
  if(!actor)return NextResponse.json({error:"Sessão interna obrigatória"},{status:401});

  const parsed=await request.json().catch(()=>null) as unknown;
  const body=parsed&&typeof parsed==="object"&&!Array.isArray(parsed)
    ? parsed as Record<string,unknown>
    : null;
  if(!body)return NextResponse.json({error:"Corpo inválido"},{status:400});
  if(hasUntrustedCopilotContext(request,body)){
    return NextResponse.json(
      {error:"Identidade ou contexto não autorizado",errorCode:"UNTRUSTED_COPILOT_CONTEXT"},
      {status:403},
    );
  }

  const action=typeof body.action==="string"&&requestActions.has(body.action)
    ? body.action
    : undefined;
  const conversationId=typeof body.conversationId==="string"?body.conversationId.trim():"";
  const question=typeof body.question==="string"?body.question.trim():undefined;
  if(!action||!/^[A-Za-z0-9_-]{1,80}$/.test(conversationId)){
    return NextResponse.json({error:"Solicitação inválida"},{status:400});
  }
  if(action==="ask"&&(!question||question.length>1000)){
    return NextResponse.json({error:"Pergunta inválida"},{status:400});
  }
  if(question&&containsCopilotInstructionInjection(question)){
    return NextResponse.json(
      {error:"Instrução operacional não autorizada",errorCode:"UNTRUSTED_COPILOT_INSTRUCTION"},
      {status:403},
    );
  }
  if(action!=="ask"&&question!==undefined){
    return NextResponse.json({error:"Pergunta não aceita nesta ação"},{status:400});
  }
  const suggestionId=typeof body.suggestionId==="string"?body.suggestionId.trim():undefined;
  if(action==="use_suggestion"){
    if(!suggestionId||!/^[0-9a-f-]{36}$/.test(suggestionId)){
      return NextResponse.json({error:"Recibo de sugestão inválido"},{status:400});
    }
    try {
      const audit=await consumeSuggestionReceipt({actor,conversationId,suggestionId});
      return NextResponse.json({used:true,audit:{storage:audit.storage,at:audit.at}});
    } catch(error) {
      if(error instanceof CopilotSuggestionReceiptError){
        return NextResponse.json({error:error.message},{status:409});
      }
      return NextResponse.json({error:"Auditoria do copiloto indisponível"},{status:503});
    }
  }
  if(suggestionId!==undefined){
    return NextResponse.json({error:"Recibo não aceito nesta ação"},{status:400});
  }

  try {
    return NextResponse.json(runInternalCopilot({
      action:action as CopilotAction,
      actor,
      conversationId,
      question,
      runtimeMode:process.env.LZR_RUNTIME_MODE,
    }));
  } catch(error) {
    if(error instanceof CopilotConversationForbiddenError){
      return NextResponse.json({error:"Conversa não encontrada ou não autorizada"},{status:404});
    }
    return NextResponse.json({error:"Copiloto indisponível"},{status:503});
  }
}
