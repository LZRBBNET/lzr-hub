import {MemoryConversationsRepository} from '../platform/conversations-service.ts';
import {MemoryAuthRepository} from '../platform/auth.ts';
import {MemoryPaymentPromiseRepository} from '../platform/payment-promise-service.ts';
import {MemoryCollectionRulesRepository} from '../platform/collection-rules-service.ts';
import {MemoryCollectionDispatchRepository} from '../platform/collection-dispatch-service.ts';
import {MemoryConversationStateRepository} from '../platform/conversation-state-service.ts';
import {createSyntheticInvoiceDemo} from '../integrations/ixc/synthetic-demo.ts';
import {Customer360Service} from '../platform/customer360-service.ts';
const key=Symbol.for('lzr.exclusive-memory-demo.v1');
export const conversationId='synthetic-demo-customer-10',channel='n8n-whatsapp';
export async function createState(config){
 const auth=new MemoryAuthRepository();await auth.addUser('supervisor@example.invalid',config.password,'Supervisor','Supervisor fictício',true,true);await auth.addUser('reader@example.invalid',config.readerPassword,'Somente leitura','Leitor fictício',true,true);
 const promises=new MemoryPaymentPromiseRepository(),rules=new MemoryCollectionRulesRepository(),ledger=new MemoryCollectionDispatchRepository(),states=new MemoryConversationStateRepository();
 await rules.saveVersion({name:'DEMO — régua sem envio',steps:[{offsetDays:1,channel:'WhatsApp',templateId:'DEMO-NO-DELIVERY',attempts:1,active:true}]},auth.users[0].id);
 const at=new Date().toISOString();states.conversations.set(channel+':'+conversationId,at);
 const messages=[{role:'customer',content:'Minha conexão está instável. Preciso de ajuda de uma pessoa.',createdAt:at},{role:'agent',content:'Vou encaminhar seu caso para uma pessoa, com o contexto desta conversa. Simulação sem envio.',createdAt:at}];
 const outcome={intent:'support',finalStatus:'handoff',handoff:true,handoffReason:'Cliente fictício pediu atendimento humano após conexão instável.',intentSource:'rules',intentConfidence:null,intentModel:null,appVersion:'memory-demo',correlationId:'synthetic-memory',createdAt:at};
 const conversations=new MemoryConversationsRepository();for(const message of messages)conversations.add({...message,channel,externalConversationId:conversationId});conversations.getAudit=async(c,id)=>c===channel&&id===conversationId?{...outcome}:undefined;
 const demo=createSyntheticInvoiceDemo(()=>config.env),customers=new Customer360Service(undefined,demo.provider,['10'],false);
 return{tail:Promise.resolve(),queued:0,auth,promises,rules,ledger,states,conversations,demo,customers};
}
export async function sharedState(config){if(!globalThis[key])globalThis[key]=createState(config);return globalThis[key];}
