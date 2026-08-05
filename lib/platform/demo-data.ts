import type { AuditEvent, CustomerSummary } from "./types";

// Fixtures do modo demonstração (IXC desligado). Só o que ainda é consumido:
// a lista de clientes sintéticos e o rastro de auditoria de exemplo. Leads,
// campanhas, régua, fatores de saúde e documentos saíram junto com as telas que
// os exibiam -- fixture morta é como dado fictício volta sem ninguém notar.

export const customers: CustomerSummary[] = [
  { id:"DEMO-CLI-001", name:"João Pereira", maskedDocument:"***.***.***-DEMO-001 (inválido)", city:"Itabaiana", neighborhood:"Centro Demo", plan:"300 Mega", status:"Ativo fictício", health:64, churnRisk:"high", priority:"Alta", tags:["sintético","ONU online"] },
  { id:"DEMO-CLI-002", name:"Maria Souza", maskedDocument:"***.***.***-DEMO-002 (inválido)", city:"Lagarto", neighborhood:"Boa Vista Demo", plan:"600 Mega", status:"Ativo fictício", health:91, churnRisk:"low", priority:"Normal", tags:["sintético","potência normal"] },
  { id:"DEMO-CLI-003", name:"Rafael Costa", maskedDocument:"***.***.***-DEMO-003 (inválido)", city:"Campo do Brito", neighborhood:"Centro Demo", plan:"1 Giga", status:"Bloqueado fictício", health:48, churnRisk:"critical", priority:"Alta", tags:["sintético","pagamento não reconhecido"] },
  { id:"DEMO-CLI-004", name:"Ana Carvalho", maskedDocument:"***.***.***-DEMO-004 (inválido)", city:"São Domingos", neighborhood:"Centro Demo", plan:"300 Mega", status:"Ativo fictício", health:78, churnRisk:"medium", priority:"Normal", tags:["sintético","PPPoE offline"] },
];

export const auditEvents: AuditEvent[] = [
  { id:"DEMO-AUD-001", actor:"LZR Agent Demo", role:"IA", action:"billing.prepare_pix_demo", entity:"Fatura fictícia DEMO-0712", result:"simulated", origin:"ai", correlationId:"demo-pix-001", at:"24/07 08:31", reason:"Artefato fictício; nenhum PIX real" },
  { id:"DEMO-AUD-002", actor:"Admin Demonstração", role:"Administrador", action:"training.accept_case", entity:"Caso sintético DEMO-384", result:"simulated", origin:"human", correlationId:"demo-training-002", at:"24/07 08:30", reason:"Resposta demonstrativa aprovada localmente" },
  { id:"DEMO-AUD-003", actor:"LZR Agent Demo", role:"IA", action:"ixc.unlock", entity:"Contrato fictício", result:"blocked", origin:"ai", correlationId:"demo-blocked-003", at:"24/07 08:17", reason:"IXC e escrita externa desativados" },
];
