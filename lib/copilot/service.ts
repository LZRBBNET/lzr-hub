import { KnowledgeService } from "../platform/knowledge-service.ts";
import { findCopilotConversation } from "./conversation-repository.ts";
import { issueSuggestionReceipt } from "./suggestion-registry.ts";
import type { CopilotAction, CopilotActor, CopilotConversation, CopilotResult, CopilotSource } from "./types.ts";

export class CopilotConversationForbiddenError extends Error {}

function conversationQuery(conversation:CopilotConversation,question?:string) {
  return [
    ...conversation.messages.slice(-8).map((message)=>message.content),
    question??"",
  ].join(" ");
}

function insufficientEvidence(action:CopilotAction,simulationOnly:boolean):CopilotResult {
  return {
    action,
    answer:"Não encontrei evidência suficiente em documentos publicados e vigentes da base de conhecimento. Não vou sugerir uma resposta sem fonte confiável.",
    sources:[],
    simulationOnly,
  };
}

function suggestionFromSource(source:CopilotSource):string {
  if(source.id==="KB-001"){
    return "Entendi a urgência por causa do seu trabalho. Como a ONU aparece online e a autenticação PPPoE está offline, preciso confirmar se o roteador já foi reiniciado por 20 segundos. Se isso já foi feito e a conexão não voltou, sigo com o encaminhamento técnico sem repetir essa etapa.";
  }
  if(source.id==="KB-002"){
    return "Vou conferir a situação com o financeiro. O desbloqueio só pode ser confirmado depois da validação do contrato e do comprovante no sistema; por enquanto, nenhuma alteração foi realizada.";
  }
  return `Encontrei um procedimento vigente para este caso: ${source.excerpt}`;
}

function summarize(conversation:CopilotConversation,simulationOnly:boolean):CopilotResult {
  const customerMessages=conversation.messages.filter((message)=>message.role==="customer");
  const agentMessages=conversation.messages.filter((message)=>message.role==="agent");
  const lastCustomer=customerMessages.at(-1)?.content??"Sem relato do cliente.";
  const lastAgent=agentMessages.at(-1)?.content??"Sem orientação registrada.";
  return {
    action:"summarize",
    answer:[
      `Cliente: ${conversation.customerName} (${conversation.customerId}).`,
      `Relato: ${lastCustomer}`,
      `Atendimento: ${lastAgent}`,
      "Pendente: confirmar se o reinício orientado foi realizado e se a conexão voltou.",
    ].join("\n"),
    sources:[],
    simulationOnly,
  };
}

export function runInternalCopilot(input:{
  action:CopilotAction;
  actor:CopilotActor;
  conversationId:string;
  question?:string;
  runtimeMode:string|undefined;
  now?:Date;
  knowledgeService?:KnowledgeService;
}):CopilotResult {
  const conversation=findCopilotConversation(input.conversationId,input.actor.role);
  if(!conversation)throw new CopilotConversationForbiddenError("Conversa indisponível para este perfil");
  const simulationOnly=input.runtimeMode==="mock";
  if(input.action==="summarize")return summarize(conversation,simulationOnly);

  const query=input.action==="ask"
    ? input.question??""
    : conversationQuery(conversation);
  const sources=(input.knowledgeService??new KnowledgeService())
    .searchPublished(query,input.now);
  if(sources.length===0)return insufficientEvidence(input.action,simulationOnly);

  if(input.action==="ask"){
    return {
      action:input.action,
      answer:`Segundo a base interna vigente: ${sources[0].excerpt}`,
      sources,
      simulationOnly,
    };
  }

  return {
    action:input.action,
    answer:suggestionFromSource(sources[0]),
    sources,
    suggestionId:issueSuggestionReceipt({
      actor:input.actor,
      conversationId:conversation.id,
      sourceIds:sources.map((source)=>source.id),
      now:input.now,
    }),
    simulationOnly,
  };
}
