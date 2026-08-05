import { customers } from "./demo-data.ts";
import { isOpenInvoice } from "./billing-service.ts";
import type { CustomerSummary, DataSource } from "./types.ts";
import type { IxcReadonlyProvider } from "../integrations/ixc/readonly-provider.ts";

export interface Customer360 {
  customer: CustomerSummary;
  contact: { phone:string; email:string; address:string; customerSince:string };
  contract: { id:string; plan:string; monthlyValue:number|null; dueDay:number; status:string; since:string };
  finance: { openInvoices:number; overdueAmount:number; lastPayment:string; paymentMethod:string };
  network: { onu:string; onuStatus:string; pppoe:string; opticalPower:string; uptime:string; devices:number; equipmentDescriptor:string; connectionType:string };
  support: { openTickets:number; lastProtocol:string; lastReason:string; csat:number };
  intelligence: { health:number; churnRisk:string; upgradeEligible:boolean; recommendedPlan:string; reason:string };
  details?: { contracts:number; invoices:number; payments:number; serviceOrders:number };
  totalLatencyMs?:number;
  mode: "demo"|"staging-readonly";
  sources: DataSource[];
  partial: boolean;
}

type Loader<T> = () => Promise<T>;
const delay = async <T>(value:T,ms=12) => { await new Promise((resolve)=>setTimeout(resolve,ms)); return value; };

export class Customer360Service {
  private readonly loaders?:Partial<Record<"contract"|"finance"|"network"|"support"|"intelligence",Loader<unknown>>>; private readonly ixc?:IxcReadonlyProvider; private readonly allowedIds:string[]; private readonly fullBase:boolean;
  constructor(loaders?: Partial<Record<"contract"|"finance"|"network"|"support"|"intelligence",Loader<unknown>>>,ixc?:IxcReadonlyProvider,allowedIds:string[]=[],fullBase=false){this.loaders=loaders;this.ixc=ixc;this.allowedIds=allowedIds;this.fullBase=fullBase;}

  async list(query="",risk="all",page=1,pageSize=10) {
    if(this.ixc)return this.listIxc(query,page,pageSize);
    const term=query.trim().toLocaleLowerCase("pt-BR");
    const filtered=customers.filter((customer)=>(!term||[customer.name,customer.city,customer.neighborhood,customer.id].some((value)=>value.toLocaleLowerCase("pt-BR").includes(term)))&&(risk==="all"||customer.churnRisk===risk));
    return { items:filtered.slice((page-1)*pageSize,page*pageSize), total:filtered.length, page, pageSize, mode:"demo" as const };
  }

  /**
   * O IXC não expõe uma listagem segura de toda a base, então a lista é a
   * allowlist — mas com o cadastro real de cada um, buscado do próprio ERP
   * (o snapshot é cacheado, então abrir o detalhe depois não consulta de novo).
   * Se a consulta de um cadastro falhar, ele aparece marcado como indisponível;
   * nunca com nome ou plano inventado.
   */
  private async listIxc(query:string,page:number,pageSize:number){
    // Base inteira liberada: uma consulta paginada resolve a lista. Com allowlist
    // continua sendo o snapshot de cada cadastro autorizado (são no máximo 10).
    if(this.fullBase){
      const result=await this.ixc!.listCustomers(query,page,pageSize,crypto.randomUUID());
      return{items:result.items.map((customer):CustomerSummary=>({id:customer.id,name:customer.name,maskedDocument:customer.document,city:customer.city,neighborhood:customer.neighborhood,plan:"Abrir para consultar",status:customer.status==="S"?"Ativo":customer.status==="N"?"Inativo":customer.status,priority:"—",tags:["IXC somente leitura"]})),total:result.total,page:result.page,pageSize:result.pageSize,mode:"staging-readonly" as const,scope:"full-base" as const};
    }
    const settled=await Promise.allSettled(this.allowedIds.map((id)=>this.ixc!.getSnapshot(id,crypto.randomUUID())));
    const items=settled.map((result,index):CustomerSummary=>{
      const id=this.allowedIds[index];
      if(result.status!=="fulfilled")return{id,name:`Cadastro ${id}`,maskedDocument:"Consulta indisponível",city:"—",neighborhood:"—",plan:"—",status:"Fonte indisponível",priority:"Indisponível",tags:["IXC indisponível"]};
      const snapshot=result.value;const contract=snapshot.contracts[0];
      return{id,name:snapshot.customer.name,maskedDocument:snapshot.customer.document,city:snapshot.customer.city,neighborhood:snapshot.customer.neighborhood,plan:contract?.planName??"Sem contrato",status:contract?.status??snapshot.customer.status,priority:"Controlada",tags:["IXC somente leitura"]};
    });
    const term=query.trim().toLocaleLowerCase("pt-BR");
    const filtered=term?items.filter((item)=>[item.id,item.name,item.maskedDocument,item.city,item.neighborhood].some((value)=>value.toLocaleLowerCase("pt-BR").includes(term))):items;
    return{items:filtered.slice((page-1)*pageSize,page*pageSize),total:filtered.length,page,pageSize,mode:"staging-readonly" as const,scope:"allowlist" as const};
  }

  async get(customerId:string):Promise<Customer360|null> {
    if(this.ixc)return this.getIxc(customerId,false);
    const customer=customers.find((item)=>item.id===customerId); if(!customer) return null;
    const defaults = {
      contract:()=>delay({id:"CTR-2022-1934",plan:customer.plan,monthlyValue:89.9,dueDay:10,status:customer.status,since:"18/03/2022"}),
      finance:()=>delay({openInvoices:1,overdueAmount:customer.status==="Bloqueado"?179.8:0,lastPayment:"10/06/2026",paymentMethod:"PIX"}),
      network:()=>delay({onu:"FiberHome AN5506",onuStatus:"Online",pppoe:customer.id==="DEMO-CLI-001"?"Offline":"Online",opticalPower:"-19,8 dBm",uptime:"2d 14h",devices:8,equipmentDescriptor:"OLT-DEMO / PON 4",connectionType:"Fibra (fictício)"}),
      support:()=>delay({openTickets:customer.churnRisk==="high"?2:0,lastProtocol:"LZR-260711-1842",lastReason:"Intermitência",csat:(customer.health??0)>80?5:3}),
      intelligence:()=>delay({health:customer.health,churnRisk:customer.churnRisk,upgradeEligible:customer.plan!=="600 Mega",recommendedPlan:"600 Mega",reason:"Uso e quantidade de dispositivos"}),
    };
    const keys=Object.keys(defaults) as (keyof typeof defaults)[];
    const results=await Promise.allSettled(keys.map((key)=>(this.loaders?.[key]??defaults[key])()));
    const sources:DataSource[]=results.map((result,index)=>({provider:keys[index]==="network"?"Monitoramento Mock":keys[index]==="intelligence"?"LZR HUB":"IXC Mock",updatedAt:new Date().toISOString(),state:result.status==="fulfilled"?"ready":"error",detail:result.status==="rejected"?"Fonte temporariamente indisponível":undefined}));
    const value=<T>(key:keyof typeof defaults,fallback:T):T=>{const result=results[keys.indexOf(key)]; return result.status==="fulfilled"?result.value as T:fallback;};
    return { customer, contact:{phone:"(79) 90000-0000 (fictício)",email:`${customer.id.toLowerCase()}@exemplo.invalid`,address:`Rua Demonstração, 100 - ${customer.neighborhood}, ${customer.city}`,customerSince:"18/03/2022"}, contract:value("contract",{id:"—",plan:customer.plan,monthlyValue:0,dueDay:0,status:"Indisponível",since:"—"}), finance:value("finance",{openInvoices:0,overdueAmount:0,lastPayment:"Indisponível",paymentMethod:"—"}), network:value("network",{onu:"Indisponível",onuStatus:"Indisponível",pppoe:"—",opticalPower:"—",uptime:"—",devices:0,equipmentDescriptor:"—",connectionType:"—"}), support:value("support",{openTickets:0,lastProtocol:"—",lastReason:"Indisponível",csat:0}), intelligence:value("intelligence",{health:customer.health??0,churnRisk:customer.churnRisk??"low",upgradeEligible:false,recommendedPlan:"—",reason:"Fonte indisponível"}), sources, partial:results.some((item)=>item.status==="rejected"),mode:"demo" };
  }

  async refresh(customerId:string){if(!this.ixc)return this.get(customerId);return this.getIxc(customerId,true);}

  private async getIxc(customerId:string,force:boolean):Promise<Customer360>{
    const snapshot=await this.ixc!.getSnapshot(customerId,crypto.randomUUID(),force);const contract=snapshot.contracts[0];
    // Usa a mesma regra da Cobrança. A anterior era `!/[PR]|pago|recebido/` —
    // sem âncora, então qualquer status contendo P ou R era descartado, e
    // "cancelada" (C) entrava como dívida. Duas telas discordavam sobre o mesmo cliente.
    const openInvoices=snapshot.invoices.filter((item)=>isOpenInvoice(item.status));
    // Pagamentos vêm de várias faturas (uma consulta por fatura); ordena por data antes de
    // pegar o mais recente -- assume formato de data comparável como string (AAAA-MM-DD).
    const latestPayment=[...snapshot.payments].sort((a,b)=>(b.paidAt??"").localeCompare(a.paidAt??""))[0];
    const connection=snapshot.connection;
    // CustomerSummary é o tipo compartilhado com a lista/modo demo -- a chave continua
    // "maskedDocument" por compatibilidade, mas em staging-readonly carrega o CPF/CNPJ
    // completo: a proteção passou a ser sessão + RBAC (login obrigatório), não mais texto
    // truncado. Ver decisão registrada ao lado do pedido do Breno de tela completa.
    const customer:CustomerSummary={id:snapshot.customer.id,name:snapshot.customer.name,maskedDocument:snapshot.customer.document,city:snapshot.customer.city,neighborhood:snapshot.customer.neighborhood,plan:contract?.planName??"Não informado",status:contract?.status??snapshot.customer.status,priority:"Controlada",tags:["IXC somente leitura"]};
    const source=(provider:string,key:string,partialKey:string):DataSource=>({provider,updatedAt:snapshot.fetchedAt,state:snapshot.partialSources.includes(partialKey)?"error":"ready",detail:snapshot.partialSources.includes(partialKey)?"Fonte indisponível; restante preservado":"Dado real do IXC",mode:"staging-readonly",cache:snapshot.cache,masked:false,latencyMs:snapshot.metrics.blockLatencies[key]??0});
    return{
      customer,
      contact:{phone:snapshot.customer.phone,email:snapshot.customer.email,address:snapshot.customer.address,customerSince:snapshot.customer.customerSince??"Não informado"},
      contract:{id:contract?.id??"—",plan:contract?.planName??"Indisponível",monthlyValue:contract?.monthlyValue??null,dueDay:contract?.dueDay??0,status:contract?.status??"Indisponível",since:contract?.activatedAt??"—"},
      finance:{openInvoices:openInvoices.length,overdueAmount:openInvoices.reduce((sum,item)=>sum+(item.value??0),0),lastPayment:latestPayment?.paidAt??"Não informado",paymentMethod:latestPayment?.method??"—"},
      // ONU, potência óptica e quantidade de dispositivos genuinamente não vêm do endpoint
      // de conexão do IXC (confirmado consultando um cliente real) -- mensagem honesta em
      // vez de sugerir que só não perguntamos.
      network:{onu:"Não disponibilizado pelo IXC",onuStatus:connection?.status==="N"?"Offline":connection?.status==="S"?"Online":connection?.status??"Indisponível",pppoe:connection?.login??"Indisponível",opticalPower:"Não disponibilizado pelo IXC",uptime:connection?.lastAccessAt??"—",devices:0,equipmentDescriptor:connection?.equipmentDescriptor??"Não disponibilizado pelo IXC",connectionType:connection?.connectionType??"Não informado"},
      support:{openTickets:snapshot.serviceOrders.filter((item)=>!/[F]|fechad/i.test(item.status)).length,lastProtocol:snapshot.serviceOrders[0]?.id??"—",lastReason:snapshot.serviceOrders[0]?.subject??"Sem OS",csat:0},
      intelligence:{health:0,churnRisk:"não calculado",upgradeEligible:false,recommendedPlan:"—",reason:"Nenhum modelo calcula saúde ou risco: os sinais necessários não são coletados. Ver docs/telas-removidas.md"},
      details:{contracts:snapshot.contracts.length,invoices:snapshot.invoices.length,payments:snapshot.payments.length,serviceOrders:snapshot.serviceOrders.length},
      totalLatencyMs:snapshot.metrics.totalLatencyMs,
      sources:[source("IXC cliente","getCustomer","customer"),source("IXC contratos","listContracts","contracts"),source("IXC plano","getPlan","plan"),source("IXC financeiro","listInvoices","invoices"),source("IXC pagamentos","listPayments","payments"),source("IXC ordens de serviço","listServiceOrders","serviceOrders"),source("IXC conexão","getConnection","connection")],
      partial:snapshot.partialSources.length>0,
      mode:"staging-readonly",
    };
  }
}
