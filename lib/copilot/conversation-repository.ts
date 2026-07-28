import type { Role } from "../platform/rbac.ts";
import type { CopilotConversation } from "./types.ts";

const demoConversation:CopilotConversation={
  id:"DEMO-CONV-001",
  customerId:"DEMO-CLI-001",
  customerName:"João Pereira",
  allowedRoles:["Administrador","Supervisor","Atendente","Suporte"],
  messages:[
    {
      role:"customer",
      content:"Oi, estou sem internet e trabalho de casa. Preciso resolver isso rápido.",
      at:"16:42",
    },
    {
      role:"agent",
      content:"Demonstração com dados fictícios: a ONU simulada está online e o PPPoE simulado está offline. Nenhuma consulta ou ação real foi executada. Para continuar o diagnóstico de exemplo, consegue desligar o roteador da tomada por 20 segundos?",
      at:"16:43",
    },
  ],
};

const conversations=new Map([[demoConversation.id,demoConversation]]);

/**
 * O navegador informa somente o identificador. Conteúdo e escopo são
 * recuperados de uma fonte controlada pelo servidor.
 */
export function findCopilotConversation(id:string,role:Role):CopilotConversation|undefined {
  const conversation=conversations.get(id);
  if(!conversation||!conversation.allowedRoles.includes(role))return undefined;
  return structuredClone(conversation);
}
