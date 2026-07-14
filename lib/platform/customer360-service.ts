import { customers } from "./demo-data";
import type { CustomerSummary, DataSource } from "./types";
import type { IxcReadonlyProvider } from "../integrations/ixc/readonly-provider.ts";

export interface Customer360 {
  customer: CustomerSummary;
  contract: { id:string; plan:string; monthlyValue:number; dueDay:number; status:string; since:string };
  finance: { openInvoices:number; overdueAmount:number; lastPayment:string; paymentMethod:string };
  network: { onu:string; onuStatus:string; pppoe:string; opticalPower:string; uptime:string; devices:number };
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
  private readonly loaders?:Partial<Record<"contract"|"finance"|"network"|"support"|"intelligence",Loader<unknown>>>; private readonly ixc?:IxcReadonlyProvider; private readonly allowedIds:string[];
  constructor(loaders?: Partial<Record<"contract"|"finance"|"network"|"support"|"intelligence",Loader<unknown>>>,ixc?:IxcReadonlyProvider,allowedIds:string[]=[]){this.loaders=loaders;this.ixc=ixc;this.allowedIds=allowedIds;}

  list(query="",risk="all",page=1,pageSize=10) {
    if(this.ixc){const term=query.trim().toLocaleLowerCase("pt-BR");const authorized=this.allowedIds.map((id,index):CustomerSummary=>({id,name:`Cliente autorizado ${String(index+1).padStart(2,"0")}`,maskedDocument:`***.***.***-${id.slice(-2).padStart(2,"*")}`,city:"Homologação",neighborhood:"Mascarado",plan:"Consultar IXC",status:"Somente leitura",health:0,churnRisk:"low",priority:"Controlada",tags:["IXC somente leitura"]})).filter((item)=>!term||item.id.toLowerCase().includes(term)||item.name.toLowerCase().includes(term));return{items:authorized.slice((page-1)*pageSize,page*pageSize),total:authorized.length,page,pageSize,mode:"staging-readonly" as const};}
    const term=query.trim().toLocaleLowerCase("pt-BR");
    const filtered=customers.filter((customer)=>(!term||[customer.name,customer.city,customer.neighborhood,customer.id].some((value)=>value.toLocaleLowerCase("pt-BR").includes(term)))&&(risk==="all"||customer.churnRisk===risk));
    return { items:filtered.slice((page-1)*pageSize,page*pageSize), total:filtered.length, page, pageSize, mode:"demo" as const };
  }

  async get(customerId:string):Promise<Customer360|null> {
    if(this.ixc)return this.getIxc(customerId,false);
    const customer=customers.find((item)=>item.id===customerId); if(!customer) return null;
    const defaults = {
      contract:()=>delay({id:"CTR-2022-1934",plan:customer.plan,monthlyValue:89.9,dueDay:10,status:customer.status,since:"18/03/2022"}),
      finance:()=>delay({openInvoices:1,overdueAmount:customer.status==="Bloqueado"?179.8:0,lastPayment:"10/06/2026",paymentMethod:"PIX"}),
      network:()=>delay({onu:"FiberHome AN5506",onuStatus:"Online",pppoe:customer.id==="CLI-1042"?"Offline":"Online",opticalPower:"-19,8 dBm",uptime:"2d 14h",devices:8}),
      support:()=>delay({openTickets:customer.churnRisk==="high"?2:0,lastProtocol:"LZR-260711-1842",lastReason:"Intermitência",csat:customer.health>80?5:3}),
      intelligence:()=>delay({health:customer.health,churnRisk:customer.churnRisk,upgradeEligible:customer.plan!=="600 Mega",recommendedPlan:"600 Mega",reason:"Uso e quantidade de dispositivos"}),
    };
    const keys=Object.keys(defaults) as (keyof typeof defaults)[];
    const results=await Promise.allSettled(keys.map((key)=>(this.loaders?.[key]??defaults[key])()));
    const sources:DataSource[]=results.map((result,index)=>({provider:keys[index]==="network"?"Monitoramento Mock":keys[index]==="intelligence"?"LZR HUB":"IXC Mock",updatedAt:new Date().toISOString(),state:result.status==="fulfilled"?"ready":"error",detail:result.status==="rejected"?"Fonte temporariamente indisponível":undefined}));
    const value=<T>(key:keyof typeof defaults,fallback:T):T=>{const result=results[keys.indexOf(key)]; return result.status==="fulfilled"?result.value as T:fallback;};
    return { customer, contract:value("contract",{id:"—",plan:customer.plan,monthlyValue:0,dueDay:0,status:"Indisponível",since:"—"}), finance:value("finance",{openInvoices:0,overdueAmount:0,lastPayment:"Indisponível",paymentMethod:"—"}), network:value("network",{onu:"Indisponível",onuStatus:"Indisponível",pppoe:"—",opticalPower:"—",uptime:"—",devices:0}), support:value("support",{openTickets:0,lastProtocol:"—",lastReason:"Indisponível",csat:0}), intelligence:value("intelligence",{health:customer.health,churnRisk:customer.churnRisk,upgradeEligible:false,recommendedPlan:"—",reason:"Fonte indisponível"}), sources, partial:results.some((item)=>item.status==="rejected"),mode:"demo" };
  }

  async refresh(customerId:string){if(!this.ixc)return this.get(customerId);return this.getIxc(customerId,true);}

  private async getIxc(customerId:string,force:boolean):Promise<Customer360>{
    const snapshot=await this.ixc!.getSnapshot(customerId,crypto.randomUUID(),force);const contract=snapshot.contracts[0];const openInvoices=snapshot.invoices.filter((item)=>!/[PR]|pago|recebido/i.test(item.status));const latestPayment=snapshot.payments[0];const connection=snapshot.connection;const customer:CustomerSummary={id:snapshot.customer.id,name:snapshot.customer.nameMasked,maskedDocument:snapshot.customer.documentMasked,city:snapshot.customer.city,neighborhood:snapshot.customer.neighborhoodMasked,plan:contract?.planName??"Não informado",status:contract?.status??snapshot.customer.status,health:0,churnRisk:"low",priority:"Controlada",tags:["IXC somente leitura"]};
    const source=(provider:string,key:string,partialKey:string):DataSource=>({provider,updatedAt:snapshot.fetchedAt,state:snapshot.partialSources.includes(partialKey)?"error":"ready",detail:snapshot.partialSources.includes(partialKey)?"Fonte indisponível; restante preservado":"Dado mascarado",mode:"staging-readonly",cache:snapshot.cache,masked:true,latencyMs:snapshot.metrics.blockLatencies[key]??0});
    return{customer,contract:{id:contract?.id??"—",plan:contract?.planName??"Indisponível",monthlyValue:contract?.monthlyValue??0,dueDay:contract?.dueDay??0,status:contract?.status??"Indisponível",since:contract?.activatedAt??"—"},finance:{openInvoices:openInvoices.length,overdueAmount:openInvoices.reduce((sum,item)=>sum+(item.value??0),0),lastPayment:latestPayment?.paidAt??"Não informado",paymentMethod:latestPayment?.method??"—"},network:{onu:"Não consultada",onuStatus:connection?.status??"Indisponível",pppoe:connection?.loginMasked??"Indisponível",opticalPower:"Não disponibilizada",uptime:connection?.lastAccessAt??"—",devices:0},support:{openTickets:snapshot.serviceOrders.filter((item)=>!/[F]|fechad/i.test(item.status)).length,lastProtocol:snapshot.serviceOrders[0]?.id??"—",lastReason:snapshot.serviceOrders[0]?.subject??"Sem OS",csat:0},intelligence:{health:0,churnRisk:"não calculado",upgradeEligible:false,recommendedPlan:"—",reason:"Score suspenso na homologação até validação dos dados"},details:{contracts:snapshot.contracts.length,invoices:snapshot.invoices.length,payments:snapshot.payments.length,serviceOrders:snapshot.serviceOrders.length},totalLatencyMs:snapshot.metrics.totalLatencyMs,sources:[source("IXC cliente","getCustomer","customer"),source("IXC contratos","listContracts","contracts"),source("IXC plano","getPlan","plan"),source("IXC financeiro","listInvoices","invoices"),source("IXC pagamentos","listPayments","payments"),source("IXC ordens de serviço","listServiceOrders","serviceOrders"),source("IXC conexão","getConnection","connection")],partial:snapshot.partialSources.length>0,mode:"staging-readonly"};
  }
}
