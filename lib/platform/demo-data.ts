import type { AuditEvent, CollectionCampaign, CollectionRuleStep, CustomerSummary, HealthFactor, KnowledgeDocument, Lead, NetworkIncident } from "./types.ts";

export const customers: CustomerSummary[] = [
  { id:"DEMO-CLI-001", name:"João Pereira", maskedDocument:"***.***.***-DEMO-001 (inválido)", city:"Itabaiana", neighborhood:"Centro Demo", plan:"300 Mega", status:"Ativo fictício", health:64, churnRisk:"high", priority:"Alta", tags:["sintético","ONU online"] },
  { id:"DEMO-CLI-002", name:"Maria Souza", maskedDocument:"***.***.***-DEMO-002 (inválido)", city:"Lagarto", neighborhood:"Boa Vista Demo", plan:"600 Mega", status:"Ativo fictício", health:91, churnRisk:"low", priority:"Normal", tags:["sintético","potência normal"] },
  { id:"DEMO-CLI-003", name:"Rafael Costa", maskedDocument:"***.***.***-DEMO-003 (inválido)", city:"Campo do Brito", neighborhood:"Centro Demo", plan:"1 Giga", status:"Bloqueado fictício", health:48, churnRisk:"critical", priority:"Alta", tags:["sintético","pagamento não reconhecido"] },
  { id:"DEMO-CLI-004", name:"Ana Carvalho", maskedDocument:"***.***.***-DEMO-004 (inválido)", city:"São Domingos", neighborhood:"Centro Demo", plan:"300 Mega", status:"Ativo fictício", health:78, churnRisk:"medium", priority:"Normal", tags:["sintético","PPPoE offline"] },
];

export const incidents: NetworkIncident[] = [
  { id:"INC-2407", title:"Perda óptica elevada", city:"Itabaiana", neighborhood:"Queimadas", equipment:"OLT-ITA-02 / PON 7", severity:"critical", status:"investigating", startedAt:"12/07 07:18", affectedCustomers:184, probableCause:"Rompimento de fibra em análise", source:"LibreNMS Mock" },
  { id:"INC-2406", title:"Oscilação de energia", city:"Ribeirópolis", neighborhood:"Centro", equipment:"POP-RIB-01", severity:"high", status:"monitoring", startedAt:"12/07 06:42", affectedCustomers:76, probableCause:"Retorno instável da concessionária", source:"Monitoramento Mock" },
  { id:"INC-2405", title:"Autenticações intermitentes", city:"Campo do Brito", neighborhood:"São José", equipment:"BRAS-CDB-01", severity:"medium", status:"resolved", startedAt:"11/07 22:10", affectedCustomers:31, probableCause:"Sessões PPPoE normalizadas", source:"IXC Mock" },
];

export const collectionSteps: CollectionRuleStep[] = [
  { id:"RS-01", label:"Lembrete preventivo", offsetDays:-3, channel:"WhatsApp", template:"Vencimento próximo", time:"10:00", attempts:1, pauseOnPayment:true, optOut:true, active:true },
  { id:"RS-02", label:"No vencimento", offsetDays:0, channel:"WhatsApp", template:"Fatura vence hoje", time:"09:30", attempts:1, pauseOnPayment:true, optOut:true, active:true },
  { id:"RS-03", label:"Atraso inicial", offsetDays:5, channel:"WhatsApp + SMS", template:"Pagamento pendente", time:"11:00", attempts:2, pauseOnPayment:true, optOut:true, active:true },
  { id:"RS-04", label:"Negociação", offsetDays:15, channel:"WhatsApp", template:"Oferta autorizada", time:"14:00", attempts:2, pauseOnPayment:true, optOut:true, active:false },
];

export const campaigns: CollectionCampaign[] = [
  { id:"CAM-0712", name:"Atraso 5–15 dias", segment:"Adimplência recente", audience:842, delivered:811, read:604, converted:173, recovered:28640, status:"running-demo" },
  { id:"CAM-0708", name:"Preventivo dia 10", segment:"Vencimento dia 10", audience:2180, delivered:2124, read:1788, converted:492, recovered:64120, status:"completed" },
];

export const leads: Lead[] = [
  { id:"LEAD-901", name:"Carlos Santos", maskedPhone:"(79) 9****-1842", city:"Itabaiana", neighborhood:"Porto", source:"Instagram", interest:"600 Mega", coverage:"Disponível", owner:"Mariana", stage:"Qualificado", score:88, nextAction:"Enviar proposta hoje 15:00" },
  { id:"LEAD-902", name:"Juliana Alves", maskedPhone:"(79) 9****-6031", city:"Ribeirópolis", neighborhood:"Centro", source:"Indicação", interest:"400 Mega", coverage:"Disponível", owner:"Paulo", stage:"Proposta", score:76, nextAction:"Confirmar documentação" },
  { id:"LEAD-903", name:"Mercadinho Lima", maskedPhone:"(79) 9****-2290", city:"Campo do Brito", neighborhood:"Centro", source:"Site", interest:"Empresarial", coverage:"Análise", owner:"Mariana", stage:"Cobertura", score:69, nextAction:"Retorno técnico 16:30" },
];

export const healthFactors: HealthFactor[] = [
  { label:"Chamados repetidos", value:82, weight:25, impact:-20, explanation:"3 chamados semelhantes em 30 dias" },
  { label:"Instabilidade recente", value:74, weight:20, impact:-15, explanation:"2 eventos de rede na região" },
  { label:"Adimplência", value:100, weight:20, impact:20, explanation:"Sem atraso nos últimos 12 meses" },
  { label:"CSAT", value:58, weight:15, impact:-6, explanation:"Última avaliação: 3 de 5" },
  { label:"Tempo de contrato", value:90, weight:10, impact:9, explanation:"Cliente há mais de 4 anos" },
  { label:"Plano defasado", value:35, weight:10, impact:-4, explanation:"Plano abaixo do perfil de uso" },
];

export const knowledgeDocuments: KnowledgeDocument[] = [
  { id:"KB-001", title:"Diagnóstico de ONU offline", category:"Suporte", status:"published", version:4, city:"Todas", plan:"Todos", equipment:"ONU FiberHome", validUntil:"31/12/2026", chunks:12, updatedAt:"12/07 08:20" },
  { id:"KB-002", title:"Política de desbloqueio em confiança", category:"Financeiro", status:"published", version:2, city:"Todas", plan:"Todos", equipment:"—", validUntil:"30/09/2026", chunks:8, updatedAt:"11/07 17:40" },
  { id:"KB-003", title:"Wi-Fi 5 GHz e posicionamento", category:"Suporte", status:"review", version:3, city:"Todas", plan:"400+ Mega", equipment:"Roteadores Wi-Fi 5/6", validUntil:"15/08/2026", chunks:15, updatedAt:"10/07 14:12" },
];

export const auditEvents: AuditEvent[] = [
  { id:"DEMO-AUD-001", actor:"LZR Agent Demo", role:"IA", action:"billing.prepare_pix_demo", entity:"Fatura fictícia DEMO-0712", result:"simulated", origin:"ai", correlationId:"demo-pix-001", at:"24/07 08:31", reason:"Artefato fictício; nenhum PIX real" },
  { id:"DEMO-AUD-002", actor:"Admin Demonstração", role:"Administrador", action:"training.accept_case", entity:"Caso sintético DEMO-384", result:"simulated", origin:"human", correlationId:"demo-training-002", at:"24/07 08:30", reason:"Resposta demonstrativa aprovada localmente" },
  { id:"DEMO-AUD-003", actor:"LZR Agent Demo", role:"IA", action:"ixc.unlock", entity:"Contrato fictício", result:"blocked", origin:"ai", correlationId:"demo-blocked-003", at:"24/07 08:17", reason:"IXC e escrita externa desativados" },
];
